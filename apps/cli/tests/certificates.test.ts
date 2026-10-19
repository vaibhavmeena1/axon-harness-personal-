import { afterEach, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { rootCertificates } from "node:tls";

import { saveEncryptedSession } from "../src/cli/auth/session.ts";
import { createPiEnvironment } from "../src/harnesses/pi/environment.ts";
import {
  bootstrapCertificates,
  type CertificateOptions,
  prepareCertificateBundle,
} from "../src/launcher/certificates.ts";
import { createHarnessEnvironment } from "../src/launcher/environment.ts";
import { resolveAxonPaths } from "../src/product/paths.ts";

const roots: string[] = [];
const publicCA = rootCertificates[0] ?? "";
if (!publicCA) throw new Error("No bundled CA certificates");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "axon-certificates-"));
  roots.push(root);
  const environment: NodeJS.ProcessEnv = {
    HOME: join(root, "user"),
    AXON_HOME: join(root, "axon"),
  };
  const localCA = join(environment["HOME"] ?? "", "certs", "ZscalerRootCertificate.crt");
  return { root, environment, localCA };
}

async function writeCA(path: string, pem: string = publicCA) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, pem);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("company CA bundles", () => {
  test.each(["/explicit/extra.pem", ""])(
    "preserves explicit NODE_EXTRA_CA_CERTS=%j without discovery or writes",
    async (extra) => {
      const f = await fixture();
      f.environment["NODE_EXTRA_CA_CERTS"] = extra;
      f.environment["SSL_CERT_FILE"] = "/other/bundle.pem";
      const original = { ...f.environment };
      expect(
        await prepareCertificateBundle({
          environment: f.environment,
          platform: "darwin",
          readKeychain: async () => {
            throw new Error("must not discover certificates");
          },
        }),
      ).toBeUndefined();
      expect(f.environment).toEqual(original);
      await expect(lstat(join(f.root, "axon", "certs"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  test("explicit SSL_CERT_FILE wins over Keychain and local fallback", async () => {
    const f = await fixture();
    const configured = join(f.root, "explicit.pem");
    await writeCA(
      configured,
      `${publicCA}\n-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----`,
    );
    f.environment["SSL_CERT_FILE"] = configured;
    let keychainCalls = 0;
    const bundle = await prepareCertificateBundle({
      environment: f.environment,
      platform: "darwin",
      readKeychain: async () => {
        keychainCalls++;
        return "invalid";
      },
    });
    expect(keychainCalls).toBe(0);
    expect(bundle?.source).toBe(configured);
    expect(bundle?.environment["SSL_CERT_FILE"]).toBe(configured);
    expect(bundle?.environment["NODE_EXTRA_CA_CERTS"]).toBe(bundle?.path);
    expect(await readFile(bundle?.path ?? "", "utf8")).not.toContain("PRIVATE KEY");
    expect(f.environment["NODE_EXTRA_CA_CERTS"]).toBeUndefined();
  });

  test("preserves an explicitly empty SSL_CERT_FILE", async () => {
    const f = await fixture();
    f.environment["SSL_CERT_FILE"] = "";
    await writeCA(f.localCA);
    expect(
      await prepareCertificateBundle({ environment: f.environment, platform: "linux" }),
    ).toBeUndefined();
  });

  test("exports Zscaler from Keychain on macOS and combines it with public roots", async () => {
    const f = await fixture();
    let calls = 0;
    const bundle = await prepareCertificateBundle({
      environment: f.environment,
      platform: "darwin",
      readKeychain: async () => {
        calls++;
        return publicCA;
      },
    });
    expect(calls).toBe(1);
    expect(bundle?.source).toContain("macOS System Keychain");
    expect(bundle?.path).toMatch(/\/certs\/combined-[a-f0-9]{64}\.pem$/);
    const pem = await readFile(bundle?.path ?? "", "utf8");
    expect(pem).toContain(new X509Certificate(publicCA).toString().trim());
    expect(pem.match(/-----BEGIN CERTIFICATE-----/g)?.length).toBe(rootCertificates.length);
    expect((await lstat(join(f.root, "axon", "certs"))).mode & 0o777).toBe(0o700);
    expect((await lstat(bundle?.path ?? "")).mode & 0o777).toBe(0o600);
    expect(bundle?.environment["SSL_CERT_FILE"]).toBe(bundle?.path);
    expect(f.environment).toEqual({ HOME: join(f.root, "user"), AXON_HOME: join(f.root, "axon") });
  });

  test.each(["missing", "timeout", "malformed"])(
    "falls back to the local CA after %s Keychain lookup",
    async (failure) => {
      const f = await fixture();
      await writeCA(f.localCA);
      const bundle = await prepareCertificateBundle({
        environment: f.environment,
        platform: "darwin",
        readKeychain: async () => {
          if (failure === "timeout") throw new Error("timed out");
          return failure === "malformed" ? "not a certificate" : undefined;
        },
      });
      expect(bundle?.source).toBe(f.localCA);
    },
  );

  test("non-macOS uses the local file without querying Keychain", async () => {
    const f = await fixture();
    await writeCA(f.localCA);
    let calls = 0;
    const bundle = await prepareCertificateBundle({
      environment: f.environment,
      platform: "linux",
      readKeychain: async () => {
        calls++;
        return publicCA;
      },
    });
    expect(calls).toBe(0);
    expect(bundle?.source).toBe(f.localCA);
  });

  test("no company certificate means no bundle, restart, or trust changes", async () => {
    const f = await fixture();
    let restarted = false;
    await bootstrapCertificates([], {
      environment: f.environment,
      platform: "linux",
      restart: () => {
        restarted = true;
      },
    });
    expect(restarted).toBe(false);
    await expect(lstat(join(f.root, "axon", "certs"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("invalid explicit certificates are not silently replaced with discovered certificates", async () => {
    const f = await fixture();
    const configured = join(f.root, "invalid.pem");
    await writeCA(configured, "not a CA");
    f.environment["SSL_CERT_FILE"] = configured;
    await writeCA(f.localCA);
    await expect(
      prepareCertificateBundle({ environment: f.environment, platform: "linux" }),
    ).rejects.toThrow("no PEM certificates");
    const warnings: string[] = [];
    let restarted = false;
    await bootstrapCertificates([], {
      environment: f.environment,
      warn: (message) => warnings.push(message),
      restart: () => {
        restarted = true;
      },
    });
    expect(restarted).toBe(false);
    expect(warnings.join("\n")).toContain("keeping TLS verification enabled");
    expect(f.environment["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
  });

  test("bundle writes are atomic, content-addressed, and never follow destination symlinks", async () => {
    const f = await fixture();
    await writeCA(f.localCA);
    const options: CertificateOptions = { environment: f.environment, platform: "linux" };
    const first = await prepareCertificateBundle(options);
    const victim = join(f.root, "unrelated.txt");
    await writeFile(victim, "do not overwrite");
    await rm(first?.path ?? "");
    await symlink(victim, first?.path ?? "");
    const bundles = await Promise.all([
      prepareCertificateBundle(options),
      prepareCertificateBundle(options),
    ]);
    expect(bundles.map((bundle) => bundle?.path)).toEqual([first?.path, first?.path]);
    expect((await lstat(first?.path ?? "")).isSymbolicLink()).toBe(false);
    expect(await readFile(victim, "utf8")).toBe("do not overwrite");
  });

  test("refuses a symlinked bundle directory", async () => {
    const f = await fixture();
    await writeCA(f.localCA);
    await mkdir(join(f.root, "axon"));
    const other = join(f.root, "other");
    await mkdir(other);
    await symlink(other, join(f.root, "axon", "certs"));
    await expect(
      prepareCertificateBundle({ environment: f.environment, platform: "linux" }),
    ).rejects.toThrow("unsafe CA bundle directory");
  });

  test("npm and Pi inherit the bundle without enabling insecure TLS settings", async () => {
    const f = await fixture();
    await writeCA(f.localCA);
    let restarted: NodeJS.ProcessEnv | undefined;
    await bootstrapCertificates(["setup", "pi", "--sync-packages"], {
      environment: f.environment,
      platform: "linux",
      restart: (environment) => {
        restarted = environment;
      },
    });
    expect(restarted?.["NODE_EXTRA_CA_CERTS"]).toMatch(/combined-[a-f0-9]+\.pem$/);
    for (const environment of [
      createHarnessEnvironment(restarted),
      createPiEnvironment(restarted ?? {}, resolveAxonPaths(f.environment)),
    ]) {
      expect(environment["NODE_EXTRA_CA_CERTS"]).toBe(restarted?.["NODE_EXTRA_CA_CERTS"]);
      expect(environment["SSL_CERT_FILE"]).toBe(restarted?.["SSL_CERT_FILE"]);
      expect(environment["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined();
      expect(environment["npm_config_strict_ssl"]).toBeUndefined();
    }
    // The second invocation must not restart again or extract the certificate again.
    expect(
      await prepareCertificateBundle({ environment: restarted ?? {}, platform: "linux" }),
    ).toBeUndefined();
  });
});

async function capture(command: string[], environment?: NodeJS.ProcessEnv, cwd?: string) {
  const child = Bun.spawn(command, {
    ...(environment ? { env: environment } : {}),
    ...(cwd ? { cwd } : {}),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
    killSignal: "SIGKILL",
  });
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { status, stdout, stderr, pid: child.pid };
}

// Fresh-process tests are essential: Bun's fetch ignores CA env changes made
// after startup, and node:tls.setDefaultCACertificates does not configure fetch.
test.each(["source", "compiled"] as const)(
  "%s startup loads company CAs before HTTPS while rejecting unrelated certificates",
  async (mode) => {
    const f = await fixture();
    const key = join(f.root, "server.key");
    const cert = join(f.root, "server.pem");
    const generated = await capture([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=Axon TLS test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      key,
      "-out",
      cert,
    ]);
    expect(generated.status).toBe(0);
    await writeCA(f.localCA, await readFile(cert, "utf8"));
    const untrustedKey = join(f.root, "untrusted.key");
    const untrustedCert = join(f.root, "untrusted.pem");
    const unrelated = await capture([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=Unrelated TLS test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      untrustedKey,
      "-out",
      untrustedCert,
    ]);
    expect(unrelated.status).toBe(0);
    let verificationRequests = 0;
    const trustedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(key), cert: Bun.file(cert) },
      fetch(request) {
        if (new URL(request.url).pathname === "/api/v1/auth/verify-auth-token") {
          verificationRequests++;
          return Response.json({ status: "VERIFIED" });
        }
        return Response.json({ version: "1.3.0" });
      },
    });
    const unrelatedServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key: Bun.file(untrustedKey), cert: Bun.file(untrustedCert) },
      fetch: () => Response.json({ untrusted: true }),
    });
    try {
      const probe = join(f.root, "probe.ts");
      await writeFile(
        probe,
        `
import { bootstrapCertificates } from ${JSON.stringify(resolve(import.meta.dir, "../src/launcher/certificates.ts"))};
await bootstrapCertificates(process.argv.slice(2), { platform: "linux" });
let trusted, rejected = false;
try {
  trusted = (await fetch(process.env.TEST_TLS_URL, { signal: AbortSignal.timeout(5000) })).status;
} catch (error) { trusted = error.code ?? error.message; }
try {
  await fetch(process.env.TEST_UNTRUSTED_URL, { signal: AbortSignal.timeout(5000) });
} catch { rejected = true; }
let nodeTrusted;
if (process.env.TEST_NODE) {
  const child = Bun.spawn([process.env.TEST_NODE, "--input-type=module", "--eval", 'console.log((await fetch(process.env.TEST_TLS_URL)).status)'], { stdout: "pipe", stderr: "pipe" });
  nodeTrusted = (await new Response(child.stdout).text()).trim();
  if (await child.exited !== 0) throw new Error(await new Response(child.stderr).text());
}
console.log(JSON.stringify({ trusted, rejected, nodeTrusted, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), extraCA: process.env.NODE_EXTRA_CA_CERTS, insecure: process.env.NODE_TLS_REJECT_UNAUTHORIZED }));
`,
      );
      let command = [process.execPath, "--no-env-file", probe];
      if (mode === "compiled") {
        const executable = join(f.root, "probe");
        const build = await capture([
          process.execPath,
          "build",
          probe,
          "--compile",
          "--format=esm",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--define",
          'BUILD_VERSION="0.2.3"',
          "--outfile",
          executable,
        ]);
        expect({ status: build.status, stderr: build.status === 0 ? "" : build.stderr }).toEqual({
          status: 0,
          stderr: "",
        });
        command = [executable];
      }
      const environment = { ...process.env, ...f.environment };
      for (const name of [
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "NODE_TLS_REJECT_UNAUTHORIZED",
      ])
        delete environment[name];
      environment["TEST_TLS_URL"] = trustedServer.url.href;
      environment["TEST_UNTRUSTED_URL"] = unrelatedServer.url.href;
      const node = Bun.which("node");
      if (node) environment["TEST_NODE"] = node;
      const baseline = await capture(
        [
          process.execPath,
          "--no-env-file",
          "--eval",
          `try { await fetch(process.env.TEST_TLS_URL); console.log("unexpected success"); } catch { console.log("untrusted"); }`,
        ],
        environment,
      );
      expect(baseline.stdout.trim()).toBe("untrusted");
      const result = await capture(
        [...command, "--fixture-argument", "value with spaces"],
        environment,
        f.root,
      );
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        trusted: 200,
        rejected: true,
        pid: result.pid,
        ...(node ? { nodeTrusted: "200" } : {}),
        argv: ["--fixture-argument", "value with spaces"],
        cwd: await realpath(f.root),
      });
      expect(JSON.parse(result.stdout).extraCA).toContain(
        join(f.root, "axon", "certs", "combined-"),
      );
      expect(JSON.parse(result.stdout).insecure).toBeUndefined();

      // Exercise the real entrypoint too: its first authenticated HTTPS request
      // must happen after bootstrap, including in the compiled release layout.
      await saveEncryptedSession(resolveAxonPaths(f.environment), "tls-fixture-session");
      const entrypoint = resolve(import.meta.dir, "../src/index.ts");
      let cli = [process.execPath, "--no-env-file", entrypoint];
      if (mode === "compiled") {
        const executable = join(f.root, "axon-cli");
        const build = await capture([
          process.execPath,
          "build",
          entrypoint,
          "--compile",
          "--format=esm",
          "--bytecode",
          "--no-compile-autoload-dotenv",
          "--no-compile-autoload-bunfig",
          "--define",
          'BUILD_VERSION="0.2.3"',
          "--define",
          `BUILD_SERVICE_ORIGIN=${JSON.stringify(trustedServer.url.origin)}`,
          "--outfile",
          executable,
        ]);
        expect({ status: build.status, stderr: build.status === 0 ? "" : build.stderr }).toEqual({
          status: 0,
          stderr: "",
        });
        cli = [executable];
      }
      const status = await capture([...cli, "auth", "status"], {
        ...environment,
        SSL_CERT_FILE: f.localCA,
        AXON_SERVICE_ORIGIN: trustedServer.url.origin,
      });
      expect({ status: status.status, stderr: status.stderr }).toEqual({ status: 0, stderr: "" });
      expect(status.stdout.trim()).toBe("Axon session is valid.");
      expect(verificationRequests).toBe(1);
    } finally {
      await trustedServer.stop(true);
      await unrelatedServer.stop(true);
    }
  },
  60_000,
);
