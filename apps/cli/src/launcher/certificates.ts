import { createHash, X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { BUILD_INFO } from "../build-info.ts";
import { PRODUCT_IDENTITY } from "../product/identity.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { isTrue } from "./debug-preview.ts";

const KEYCHAIN_TIMEOUT_MS = 1_000;
const MAX_CA_BYTES = 4 * 1024 * 1024;
const ZSCALER_KEYCHAIN_COMMAND = [
  "/usr/bin/security",
  "find-certificate",
  "-c",
  "Zscaler Root CA",
  "-a",
  "-p",
  "/Library/Keychains/System.keychain",
] as const;

export interface CertificateOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly readKeychain?: () => Promise<string | undefined>;
  readonly debug?: (message: string) => void;
}

export interface CertificateBundle {
  readonly path: string;
  readonly source: string;
  readonly environment: NodeJS.ProcessEnv;
}

async function readZscalerKeychain(): Promise<string | undefined> {
  const child = Bun.spawn([...ZSCALER_KEYCHAIN_COMMAND], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: KEYCHAIN_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const [pem, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return exitCode === 0 && pem.trim() ? pem : undefined;
}

/** Copy only valid CA certificates, never private keys or unrelated PEM data. */
function parseCertificates(pem: string): string[] {
  if (Buffer.byteLength(pem) > MAX_CA_BYTES) throw new Error("CA bundle is too large");
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!blocks?.length) throw new Error("CA bundle contains no PEM certificates");
  return blocks.map((block) => {
    const certificate = new X509Certificate(block);
    if (!certificate.ca) throw new Error("CA bundle contains a non-CA certificate");
    return certificate.toString().trim();
  });
}

async function readCertificates(path: string): Promise<string[]> {
  // CA paths may legitimately be symlinks to an administrator-managed bundle;
  // inspect the target so oversized bundles and non-regular files are rejected.
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_CA_BYTES) {
    throw new Error(`Invalid CA certificate file: ${path}`);
  }
  return parseCertificates(await readFile(path, "utf8"));
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw new Error(`Refusing unsafe CA bundle directory: ${path}`);
  }
  await chmod(path, 0o700);
}

/**
 * Prepare public roots + company CAs, without changing this process's trust store.
 * Bun loads CA environment variables at process startup, not at first fetch.
 */
export async function prepareCertificateBundle(
  options: CertificateOptions = {},
): Promise<CertificateBundle | undefined> {
  const environment = options.environment ?? process.env;
  const debug = options.debug ?? (() => {});
  // An explicit setting (including an empty one) belongs to the caller. This also
  // makes the restarted launcher a no-op, without a persistent/internal bypass flag.
  if (environment["NODE_EXTRA_CA_CERTS"] !== undefined) return undefined;

  let certificates: string[] | undefined;
  let source: string | undefined;
  const configuredFile = environment["SSL_CERT_FILE"];
  const userHome = environment["HOME"] || homedir();
  if (configuredFile !== undefined) {
    if (!configuredFile.trim()) return undefined;
    certificates = await readCertificates(configuredFile);
    source = configuredFile;
  } else {
    if ((options.platform ?? process.platform) === "darwin") {
      try {
        const pem = await (options.readKeychain ?? readZscalerKeychain)();
        if (pem) {
          certificates = parseCertificates(pem);
          source = "Zscaler Root CA from macOS System Keychain";
        }
      } catch {
        debug(
          "could not read a valid Zscaler Root CA from System Keychain; trying the local CA file",
        );
      }
    }
    if (!certificates) {
      const localFile = join(userHome, "certs", "ZscalerRootCertificate.crt");
      try {
        certificates = await readCertificates(localFile);
        source = localFile;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    }
  }

  const publicRoots = rootCertificates.map((cert) => new X509Certificate(cert).toString().trim());
  const pem = `${[...new Set([...publicRoots, ...certificates])].join("\n")}\n`;
  const home = resolveAxonPaths(environment, userHome).home;
  const directory = join(home, "certs");
  await ensurePrivateDirectory(home);
  await ensurePrivateDirectory(directory);
  const digest = createHash("sha256").update(pem).digest("hex");
  const path = join(directory, `combined-${digest}.pem`);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    // Atomic replacement never follows an existing destination symlink. Concurrent
    // launches write identical content to the same content-addressed destination.
    await writeFile(temporary, pem, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }

  return {
    path,
    source: source ?? "company CA",
    environment: {
      ...environment,
      NODE_EXTRA_CA_CERTS: path,
      SSL_CERT_FILE: configuredFile ?? path,
    },
  };
}

/** Run before telemetry, authentication, updates, or any other network work. */
export async function bootstrapCertificates(
  argumentsVector: readonly string[],
  options: CertificateOptions & {
    readonly restart?: (environment: NodeJS.ProcessEnv) => void;
    readonly warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const debug =
    options.debug ??
    ((message: string) => {
      if (isTrue(environment["AXON_DEBUG"])) {
        console.error(`${PRODUCT_IDENTITY.command}: TLS: ${message}`);
      }
    });
  try {
    const bundle = await prepareCertificateBundle({ ...options, environment, debug });
    if (!bundle) return;
    debug(`using ${bundle.source}; combined CA bundle: ${bundle.path}`);
    if (options.restart) {
      options.restart(bundle.environment);
      return;
    }
    if (!process.execve) throw new Error("This platform does not support an in-place restart");
    const args = BUILD_INFO.isSourceRun
      ? [process.execPath, ...process.execArgv, process.argv[1] ?? "", ...argumentsVector]
      : [process.execPath, ...argumentsVector];
    // execve preserves PID, cwd, terminal, exit/signal semantics, and user argv.
    // No parent launcher or shared temporary bundle remains behind.
    process.execve(process.execPath, args, bundle.environment);
  } catch (error) {
    (options.warn ?? console.error)(
      `${PRODUCT_IDENTITY.command}: could not prepare company CA certificates; keeping TLS verification enabled. ` +
        "Set NODE_EXTRA_CA_CERTS to an approved PEM CA bundle before starting Axon.",
    );
    debug(error instanceof Error ? error.message : "certificate setup failed");
  }
}
