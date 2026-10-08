import { constants, type Stats } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

import type { AxonPaths } from "../../product/paths.ts";

const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const CACHE_TIMEOUT_MS = 700;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStaleRelayModel(value: unknown, relayOrigin: string): boolean {
  if (!isObject(value) || value["provider"] !== "litellm" || typeof value["baseUrl"] !== "string") {
    return false;
  }
  try {
    const url = new URL(value["baseUrl"]);
    // Match the launcher's exact relay shape, not arbitrary local LiteLLM endpoints.
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/litellm(?:\/v1)?\/?$/.test(url.pathname) &&
      url.origin !== relayOrigin
    );
  } catch {
    return false;
  }
}

async function inspectCache(path: string): Promise<Stats> {
  const status = await lstat(path);
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.size > MAX_CACHE_BYTES ||
    (process.getuid !== undefined && status.uid !== process.getuid())
  ) {
    throw new Error("Unsafe Pi model cache");
  }
  return status;
}

function sameRevision(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/** Remove only obsolete Axon relay URLs; fresh discovery remains authoritative. */
export async function invalidateStalePiRelayModels(
  paths: AxonPaths,
  relayOrigin: string,
): Promise<number> {
  const relay = new URL(relayOrigin);
  if (
    relay.protocol !== "http:" ||
    relay.hostname !== "127.0.0.1" ||
    !relay.port ||
    relay.username ||
    relay.password ||
    relay.pathname !== "/" ||
    relay.search ||
    relay.hash
  ) {
    throw new Error("Invalid Axon relay origin");
  }
  const path = join(paths.pi, "models-store.json");
  try {
    for (const directory of [paths.home, paths.pi]) {
      const status = await lstat(directory);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw new Error("Unsafe Pi model cache directory");
      }
    }
    await inspectCache(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
    throw error;
  }

  // Pi's FileModelsStore uses this same proper-lockfile directory and stale timeout.
  // No retries: another session refreshing its catalog must not stall a launch.
  const signal = AbortSignal.timeout(CACHE_TIMEOUT_MS);
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: 0,
    stale: 30_000,
    onCompromised: (error) => {
      compromised = error;
    },
  });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const checkLock = () => {
    signal.throwIfAborted();
    if (compromised !== undefined) throw compromised;
  };
  try {
    checkLock();
    // Read only after locking, so concurrent provider updates are preserved.
    const status = await inspectCache(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let content: string;
    try {
      if (!sameRevision(status, await handle.stat())) throw new Error("Pi model cache changed");
      const buffer = Buffer.alloc(status.size + 1);
      let length = 0;
      while (length < buffer.length) {
        checkLock();
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length !== status.size) throw new Error("Pi model cache changed");
      content = buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    const cache: unknown = JSON.parse(content.replace(/^\uFEFF/, ""));
    if (!isObject(cache)) throw new Error("Invalid Pi model cache");
    const entry = cache["litellm"];
    if (entry === undefined) return 0;
    if (!isObject(entry) || !Array.isArray(entry["models"])) {
      throw new Error("Invalid LiteLLM model cache");
    }
    const models = entry["models"].filter((model) => !isStaleRelayModel(model, relay.origin));
    const removed = entry["models"].length - models.length;
    if (removed === 0) return 0;
    if (models.length === 0) delete cache["litellm"];
    else cache["litellm"] = { ...entry, models };

    const temporary = await open(temporaryPath, "wx", 0o600);
    try {
      await temporary.writeFile(`${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await temporary.chmod(status.mode & 0o777);
    } finally {
      await temporary.close();
    }
    checkLock();
    if (!sameRevision(status, await inspectCache(path))) throw new Error("Pi model cache changed");
    await rename(temporaryPath, path);
    return removed;
  } finally {
    try {
      await rm(temporaryPath, { force: true });
    } finally {
      await release();
    }
  }
}
