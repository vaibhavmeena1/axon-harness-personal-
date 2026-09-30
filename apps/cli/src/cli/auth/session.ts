import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

/** Merge only our token into the shared session file and atomically set owner-only permissions. */
export async function saveEncryptedSession(
  paths: DeputyDevPaths,
  encryptedSession: string,
): Promise<void> {
  const destination = sessionPath(paths);
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await assertRegularDirectory(paths.home);

  // The session file can be shared with the VS Code binary: retain unrelated keys.
  // Replace permissive existing permissions with 0600 when saving a new token.
  const existingData = await readSessionFile(destination);
  const data = { ...existingData, [AUTH_TOKEN_KEY]: encryptedSession };
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}
