import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "../../launcher/file-lock.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";

const AUTH_TOKEN_KEY = "extension_auth_token";
export const SESSION_FILE_NAME = "264325ba-cbd0-47d5-9269-ac4bd19067c2.json";
const MAX_SESSION_FILE_BYTES = 1024 * 1024;

function sessionPath(paths: DeputyDevPaths): string {
  return join(paths.home, SESSION_FILE_NAME);
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const directoryStatus = await lstat(directory);
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error("Managed session directory is not a regular directory");
  }
}

async function readSessionFile(destination: string): Promise<Record<string, unknown> | undefined> {
  try {
    const fileStatus = await lstat(destination);
    if (
      !fileStatus.isFile() ||
      fileStatus.isSymbolicLink() ||
      fileStatus.size > MAX_SESSION_FILE_BYTES
    ) {
      throw new Error("Saved session is not a regular file");
    }
    const payload: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Saved session file is not a JSON object");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** Read the shared DeputyDev token without exposing it in CLI output or Pi history. */
export async function loadEncryptedSession(paths: DeputyDevPaths): Promise<string | undefined> {
  const destination = sessionPath(paths);
  try {
    await assertRegularDirectory(dirname(destination));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  // The VS Code binary may own this shared file with different permissions.
  const payload = await readSessionFile(destination);
  const encryptedSession = payload?.[AUTH_TOKEN_KEY];
  if (encryptedSession === undefined) return undefined;
  if (typeof encryptedSession !== "string" || !encryptedSession) {
    throw new Error("Saved session token is invalid");
  }
  return encryptedSession;
}

/** Caller holds the shared CLI writer lock. Retain unrelated VS Code keys. */
async function writeEncryptedSession(
  paths: DeputyDevPaths,
  encryptedSession: string,
): Promise<void> {
  const destination = sessionPath(paths);

  // The session file can be shared with the VS Code binary: retain unrelated keys.
  // Replace permissive existing permissions with 0600 when saving a new token.
  const existingData = await readSessionFile(destination);
  const data = { ...existingData, [AUTH_TOKEN_KEY]: encryptedSession };
  const serialized = `${JSON.stringify(data)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_SESSION_FILE_BYTES) {
    throw new Error("Saved session file is too large");
  }
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Merge our credential atomically with owner-only permissions and serialized CLI writes. */
export async function saveEncryptedSession(
  paths: DeputyDevPaths,
  encryptedSession: string,
): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(paths.home);
  await withFileLock(join(paths.home, ".session.lock"), () =>
    writeEncryptedSession(paths, encryptedSession),
  );
}

/** A response to an older request must not overwrite a newer CLI login. */
export async function refreshEncryptedSession(
  paths: DeputyDevPaths,
  expectedSession: string,
  refreshedSession: string,
): Promise<boolean> {
  await assertRegularDirectory(paths.home);
  return withFileLock(
    join(paths.home, ".session.lock"),
    async () => {
      if ((await loadEncryptedSession(paths)) !== expectedSession) return false;
      await writeEncryptedSession(paths, refreshedSession);
      return true;
    },
    { timeoutMs: 100 },
  );
}
