import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type IdentitySource = "git_email" | "installation_id" | "deputydev_auth";

export interface TelemetryIdentity {
  readonly userId: string;
  readonly email?: string;
  readonly source: IdentitySource;
}

export interface IdentityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly cwd?: string;
  readonly readGitEmail?: () => string | undefined | Promise<string | undefined>;
}

interface StoredIdentity {
  installationId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeGitEmail(value: string | undefined): string | undefined {
  const email = value?.trim();
  return email &&
    email.length <= 320 &&
    ![...email].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
    ? email
    : undefined;
}

async function defaultGitEmail(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["config", "--get", "user.email"], {
      cwd,
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    return normalizeGitEmail(stdout);
  } catch {
    return undefined;
  }
}

export function resolveAgentDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return env["PI_CODING_AGENT_DIR"]?.trim() || join(homeDirectory, ".pi", "agent");
}

function parseStoredIdentity(raw: string): StoredIdentity | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("installationId" in value)) return undefined;
    const installationId = value.installationId;
    return typeof installationId === "string" && UUID_PATTERN.test(installationId)
      ? { installationId }
      : undefined;
  } catch {
    return undefined;
  }
}

async function readInstallationId(path: string): Promise<string | undefined> {
  try {
    const stored = parseStoredIdentity(await readFile(path, "utf8"));
    return stored?.installationId;
  } catch {
    return undefined;
  }
}

async function createInstallationId(path: string, directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const installationId = randomUUID();
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ installationId }, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await link(temporaryPath, path);
    return installationId;
  } catch (error: unknown) {
    const existing = await readInstallationId(path);
    if (existing) return existing;
    try {
      await rename(temporaryPath, path);
      return installationId;
    } catch {
      throw error;
    }
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function resolveIdentity(options: IdentityOptions = {}): Promise<TelemetryIdentity> {
  // Managed identity is rewritten by the backend. Do not send local Git PII in this mode.
  if ((options.env ?? process.env)["PI_ORG_OTEL_MANAGED_ENDPOINT"]) {
    return { userId: "managed", source: "deputydev_auth" };
  }
  const email = normalizeGitEmail(
    await (options.readGitEmail
      ? options.readGitEmail()
      : defaultGitEmail(options.cwd ?? process.cwd())),
  );
  if (email) return { userId: email, email, source: "git_email" };

  const env = options.env ?? process.env;
  const agentDirectory = resolveAgentDirectory(env, options.homeDir ?? homedir());
  const identityDirectory = join(agentDirectory, "pi-org-telemetry");
  const identityPath = join(identityDirectory, "identity.json");
  const existing = await readInstallationId(identityPath);
  const installationId = existing ?? (await createInstallationId(identityPath, identityDirectory));
  return { userId: installationId, source: "installation_id" };
}
