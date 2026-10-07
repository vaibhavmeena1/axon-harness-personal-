import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface FileLockOptions {
  readonly retryDelayMs?: number;
  readonly staleAfterMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface LockOwner {
  readonly createdAt: number;
  readonly pid: number;
  readonly token: string;
}

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_AFTER_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const OWNER_FILE = "owner.json";

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(`${lockPath}/${OWNER_FILE}`, "utf8"),
    ) as Partial<LockOwner>;
    return typeof parsed.createdAt === "number" &&
      typeof parsed.pid === "number" &&
      typeof parsed.token === "string"
      ? { createdAt: parsed.createdAt, pid: parsed.pid, token: parsed.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFileSystemError(error, "EPERM");
  }
}

async function removeStaleLock(lockPath: string, staleAfterMs: number): Promise<boolean> {
  let lockStatus: Awaited<ReturnType<typeof stat>>;
  try {
    lockStatus = await stat(lockPath);
  } catch (error) {
    return isFileSystemError(error, "ENOENT");
  }

  const getUserId = process.getuid;
  if (getUserId !== undefined && lockStatus.uid !== getUserId()) {
    throw new Error(`refusing to remove lock owned by uid ${lockStatus.uid}: ${lockPath}`);
  }

  const owner = await readOwner(lockPath);
  const age = Date.now() - (owner?.createdAt ?? lockStatus.mtimeMs);
  if (age < staleAfterMs || (owner !== undefined && isProcessAlive(owner.pid))) {
    return false;
  }

  // Re-read before rename so a lock replaced while it was inspected is not removed.
  const latestOwner = await readOwner(lockPath);
  if (owner?.token !== latestOwner?.token) {
    return false;
  }

  const stalePath = `${lockPath}.stale.${process.pid}.${crypto.randomUUID()}`;
  try {
    await rename(lockPath, stalePath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return true;
    }
    return false;
  }
  await rm(stalePath, { force: true, recursive: true });
  return true;
}

async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions,
): Promise<() => Promise<void>> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const owner: LockOwner = {
    createdAt: Date.now(),
    pid: process.pid,
    token: crypto.randomUUID(),
  };

  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });

  while (true) {
    options.signal?.throwIfAborted();
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await writeFile(`${lockPath}/${OWNER_FILE}`, `${JSON.stringify(owner)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
      } catch (error) {
        await rm(lockPath, { force: true, recursive: true });
        throw error;
      }

      return async () => {
        const currentOwner = await readOwner(lockPath);
        if (currentOwner?.token === owner.token) {
          await rm(lockPath, { force: true, recursive: true });
        }
      };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) {
        throw error;
      }
    }

    if (await removeStaleLock(lockPath, staleAfterMs)) {
      continue;
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for lock: ${lockPath}`);
    }
    await sleep(retryDelayMs, undefined, { signal: options.signal });
  }
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    options.signal?.throwIfAborted();
    return await operation();
  } finally {
    await release();
  }
}
