import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import type { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";

import piVersion from "../../pi-version.json";
import type { AxonPaths } from "../product/paths.ts";
import {
  emitProductEvent,
  measureProductOperation,
  observeProductEvent,
  type ProductEventObserver,
  productFailureReason,
} from "../telemetry/product-events.ts";
import { type BackupApi, storageUrl } from "./api.ts";
import {
  assertPiAdapter,
  downloadSchema,
  MAX_RAW_BYTES,
  MAX_STORED_BYTES,
  type RemoteSession,
  type Snapshot,
} from "./contracts.ts";
import { atomicJson, fileIntegrity, privateDirectory, syncDirectory } from "./files.ts";
import { validatePiJsonl } from "./pi-jsonl.ts";

export type PiManagerClass = typeof PiSessionManager;

export async function loadPinnedPi(paths: AxonPaths): Promise<PiManagerClass> {
  const packageRoot = join(
    paths.piRuntime,
    piVersion.version,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  let metadata: { version?: unknown };
  try {
    metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  } catch {
    throw new Error("Managed pinned Pi is unavailable; run axon setup pi --sync-packages first");
  }
  if (metadata.version !== piVersion.version)
    throw new Error("Managed Pi version does not match the restore adapter");
  const module = (await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href)) as {
    SessionManager: PiManagerClass;
  };
  return module.SessionManager;
}

function byteLimit(maximum: number): Transform {
  let size = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(size > maximum ? new Error("Backup exceeds declared size") : null, chunk);
    },
  });
}

export async function verifyArchive(
  stored: string,
  raw: string,
  snapshot: Snapshot,
): Promise<void> {
  const downloaded = await fileIntegrity(stored, MAX_STORED_BYTES);
  if (downloaded.hash !== snapshot.stored_sha256 || downloaded.size !== snapshot.stored_size_bytes)
    throw new Error("Stored archive checksum or size mismatch");
  const input = createReadStream(stored);
  const output = createWriteStream(raw, { flags: "wx", mode: 0o600 });
  if (snapshot.encoding === "gzip")
    await pipeline(
      input,
      createGunzip(),
      byteLimit(Math.min(snapshot.raw_size_bytes, MAX_RAW_BYTES)),
      output,
    );
  else await pipeline(input, byteLimit(snapshot.raw_size_bytes), output);
  const uncompressed = await fileIntegrity(raw, MAX_RAW_BYTES);
  if (uncompressed.hash !== snapshot.raw_sha256 || uncompressed.size !== snapshot.raw_size_bytes)
    throw new Error("Raw archive checksum or size mismatch");
  const handle = await open(raw, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function forkArchive(
  raw: string,
  cwd: string,
  destination: string,
  session: RemoteSession,
  Manager: PiManagerClass,
): Promise<string> {
  const resume = assertPiAdapter(session);
  const original = await validatePiJsonl(raw, session.harness_session_id, resume);
  // Backups made before first-message titles may have legitimately stored a null name.
  const displayName =
    session.display_name === null && session.snapshot?.display_name === null
      ? original.nativeDisplayName
      : original.displayName;
  if (displayName !== session.display_name || displayName !== session.snapshot?.display_name)
    throw new Error("Display name does not match session archive");
  const chosenCwd = await realpath(resolve(cwd));
  if (!(await lstat(chosenCwd)).isDirectory())
    throw new Error("Restore destination checkout must exist");
  const directory = await mkdtemp(join(destination, ".restore-"));
  await chmod(directory, 0o700);
  const working = join(directory, "source.jsonl");
  try {
    await copyFile(raw, working);
    await chmod(working, 0o600);
    const fork = Manager.forkFrom(working, chosenCwd, directory);
    const source = Manager.open(working);
    if (resume.leaf_known) {
      if (resume.selected_leaf_id === null) fork.resetLeaf();
      else fork.branch(resume.selected_leaf_id);
      fork.appendCustomEntry("axon.restore", {
        source_session_id: session.id,
        leaf_known: true,
        selected_leaf_id: resume.selected_leaf_id,
      });
    }
    const path = fork.getSessionFile();
    if (!path || fork.getSessionId() === original.nativeId || fork.getCwd() !== chosenCwd)
      throw new Error("Pi did not create a checkout-bound fork");
    const entries = fork.getEntries();
    const oldEntries = source.getEntries();
    if (
      oldEntries.length !== original.entries ||
      entries.length !== oldEntries.length + (resume.leaf_known ? 1 : 0) ||
      oldEntries.some((entry, i) => JSON.stringify(entry) !== JSON.stringify(entries[i]))
    )
      throw new Error("Pi restore did not preserve the complete entry tree");
    const reopened = Manager.open(path);
    if (resume.leaf_known && reopened.getLeafEntry()?.parentId !== resume.selected_leaf_id)
      throw new Error("Restored leaf selection was not durable");
    await chmod(path, 0o600);
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const published = join(destination, basename(path));
    // Atomic create-only publication; even a filename collision cannot replace a live session.
    await link(path, published);
    await syncDirectory(destination);
    return published;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface RestoreOptions {
  readonly manager?: PiManagerClass;
  readonly inspect?: (session: RemoteSession) => Promise<boolean>;
  readonly observer?: ProductEventObserver;
}

async function restoreSessionInternal(
  api: BackupApi,
  id: string,
  cwd: string,
  options: RestoreOptions = {},
): Promise<string | undefined> {
  const owner = await api.owner();
  const download = downloadSchema.parse(await api.request(api.endpoint("download", id)));
  const resume = assertPiAdapter(download.session); // Dispatch before any filesystem mutation.
  const snapshot = download.session.snapshot;
  if (!snapshot) throw new Error("No committed backup to restore");
  const Manager = options.manager ?? (await loadPinnedPi(api.paths));
  const checkout = await realpath(resolve(cwd));
  if (!(await lstat(checkout)).isDirectory()) throw new Error("Restore checkout must exist");
  if (options.inspect && !(await options.inspect(download.session))) return undefined;
  const root = join(api.paths.home, "session-backups");
  await privateDirectory(api.paths.home);
  await privateDirectory(root);
  const archives = join(root, "archives");
  await privateDirectory(archives);
  const archive = await mkdtemp(join(archives, "restore-"));
  await chmod(archive, 0o700);
  let verified = false;
  try {
    const stored = join(archive, "payload");
    const raw = join(archive, "original.jsonl");
    await measureProductOperation(
      { category: "restore", stage: "download", bytes: snapshot.stored_size_bytes },
      async () => {
        const response = await api.fetcher(storageUrl(download.url), {
          redirect: "error",
          signal: AbortSignal.timeout(120_000),
        });
        if (!response.ok || !response.body) throw new Error("Archive download failed");
        await pipeline(
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
          byteLimit(snapshot.stored_size_bytes),
          createWriteStream(stored, { flags: "wx", mode: 0o600 }),
        );
      },
      options.observer,
    );
    await measureProductOperation(
      { category: "restore", stage: "verify", bytes: snapshot.raw_size_bytes },
      async () => {
        await verifyArchive(stored, raw, snapshot);
        await validatePiJsonl(raw, download.session.harness_session_id, resume);
      },
      options.observer,
    );
    await atomicJson(join(archive, "provenance.json"), {
      owner,
      backend: api.origin,
      session_id: id,
      object_id: download.object_id,
      snapshot: download.session.snapshot,
    });
    verified = true; // Keep the original verified archive even if native restore fails.
    await privateDirectory(api.paths.pi);
    await privateDirectory(api.paths.piSessions);
    const published = await measureProductOperation(
      { category: "restore", stage: "fork" },
      () => forkArchive(raw, checkout, api.paths.piSessions, download.session, Manager),
      options.observer,
    );
    // No remote client stream identity is reused. First capture allocates a destination-device stream.
    await atomicJson(join(archive, "local-fork.json"), {
      local_session_file: published,
      source_session_id: id,
      object_id: download.object_id,
      selected_cwd: checkout,
    });
    return published;
  } finally {
    if (!verified) await rm(archive, { recursive: true, force: true });
  }
}

export async function restoreSession(
  api: BackupApi,
  id: string,
  cwd: string,
  options: RestoreOptions = {},
): Promise<string | undefined> {
  const startedAt = Date.now();
  const observer = options.observer ?? emitProductEvent;
  try {
    const result = await restoreSessionInternal(api, id, cwd, options);
    observeProductEvent(observer, {
      category: "restore",
      stage: "request",
      outcome: result ? "success" : "cancelled",
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    observeProductEvent(observer, {
      category: "restore",
      stage: "request",
      outcome: "failed",
      reason: productFailureReason(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
