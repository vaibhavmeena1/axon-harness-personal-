import { chmod, lstat, mkdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { BUILD_INFO } from "../../../build-info.ts";
import { withFileLock } from "../../../launcher/file-lock.ts";
import type { EmbeddedPiResource } from "../../../product/manifest.ts";
import type { AxonPaths } from "../../../product/paths.ts";

interface PreparedResource {
  readonly bytes: Uint8Array;
  readonly destination: string;
  readonly hash: string;
  readonly id: string;
  readonly type: EmbeddedPiResource["type"];
}

export interface PiResourceMaterializationResult {
  readonly arguments: readonly string[];
  readonly hash: string;
  readonly runtimeDirectory: string;
}

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function validateDestination(destination: string): void {
  const parts = destination.split(/[\\/]/);
  if (
    destination.startsWith("/") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`unsafe embedded Pi resource destination: ${destination}`);
  }
}

async function prepareResources(
  resources: readonly EmbeddedPiResource[],
): Promise<readonly PreparedResource[]> {
  const prepared: PreparedResource[] = [];
  for (const resource of resources) {
    validateDestination(resource.destination);
    const bytes = new Uint8Array(await Bun.file(resource.sourcePath).arrayBuffer());
    prepared.push({
      bytes,
      destination: resource.destination,
      hash: hashBytes(bytes),
      id: resource.id,
      type: resource.type,
    });
  }
  return prepared;
}

function resourceSetHash(resources: readonly PreparedResource[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  for (const resource of resources) {
    hasher.update(`${resource.id}\0${resource.type}\0${resource.destination}\0${resource.hash}\0`);
  }
  return hasher.digest("hex");
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}

async function hasSafeResourceParents(
  runtimeDirectory: string,
  destination: string,
): Promise<boolean> {
  const parts = relative(runtimeDirectory, dirname(destination)).split(/[\\/]/).filter(Boolean);
  let current = runtimeDirectory;
  for (const part of ["", ...parts]) {
    current = part === "" ? current : join(current, part);
    try {
      const status = await lstat(current);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function verifyRuntime(
  runtimeDirectory: string,
  resources: readonly PreparedResource[],
): Promise<boolean> {
  for (const resource of resources) {
    const destination = join(runtimeDirectory, resource.destination);
    if (!(await hasSafeResourceParents(runtimeDirectory, destination))) {
      return false;
    }
    if (!(await isRegularFile(destination))) {
      return false;
    }
    const bytes = new Uint8Array(await Bun.file(destination).arrayBuffer());
    if (hashBytes(bytes) !== resource.hash) {
      return false;
    }
  }
  return true;
}

async function currentPointsTo(paths: AxonPaths, runtimeDirectory: string): Promise<boolean> {
  try {
    const status = await lstat(paths.runtimeCurrent);
    if (!status.isSymbolicLink()) {
      return false;
    }
    const target = await readlink(paths.runtimeCurrent);
    return resolve(dirname(paths.runtimeCurrent), target) === resolve(runtimeDirectory);
  } catch {
    return false;
  }
}

async function activateRuntime(paths: AxonPaths, runtimeDirectory: string): Promise<void> {
  try {
    const currentStatus = await lstat(paths.runtimeCurrent);
    if (!currentStatus.isSymbolicLink()) {
      throw new Error(`active runtime path is not a symlink: ${paths.runtimeCurrent}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const temporaryLink = `${paths.runtimeCurrent}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const target = relative(dirname(paths.runtimeCurrent), runtimeDirectory);
  try {
    await symlink(target, temporaryLink, "dir");
    await rename(temporaryLink, paths.runtimeCurrent);
  } finally {
    await rm(temporaryLink, { force: true });
  }
}

async function materializeRuntime(
  paths: AxonPaths,
  runtimeDirectory: string,
  resources: readonly PreparedResource[],
  manifestHash: string,
): Promise<void> {
  const temporaryDirectory = join(
    paths.runtime,
    `.materialize-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    for (const resource of resources) {
      const destination = join(temporaryDirectory, resource.destination);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await Bun.write(destination, resource.bytes);
      await chmod(destination, 0o644);
    }
    await Bun.write(
      join(temporaryDirectory, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          hash: manifestHash,
          resources: resources.map(({ bytes: _bytes, ...resource }) => resource),
        },
        null,
        2,
      )}\n`,
    );

    if (!(await verifyRuntime(temporaryDirectory, resources))) {
      throw new Error("embedded Pi resource verification failed before activation");
    }

    try {
      await rename(temporaryDirectory, runtimeDirectory);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

/**
 * Pi receives explicit resource flags that point into one immutable,
 * content-addressed runtime directory. `runtime/current` is kept for inspection
 * only; a concurrent launcher of another version may repoint it at any time.
 */
export function createPiResourceArguments(
  runtimeDirectory: string,
  resources: readonly Pick<EmbeddedPiResource, "destination" | "type">[],
): readonly string[] {
  const flags = {
    extension: "--extension",
    skill: "--skill",
    prompt: "--prompt-template",
    theme: "--theme",
  } as const;
  return resources.flatMap((resource) => [
    flags[resource.type],
    join(runtimeDirectory, resource.destination),
  ]);
}

export async function materializePiResources(
  paths: AxonPaths,
  resources: readonly EmbeddedPiResource[],
): Promise<PiResourceMaterializationResult> {
  const prepared = await prepareResources(resources);
  const hash = resourceSetHash(prepared);
  const runtimeDirectory = join(paths.runtime, `${BUILD_INFO.version}-${hash.slice(0, 16)}`);

  await mkdir(paths.home, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });

  const ready =
    (await verifyRuntime(runtimeDirectory, prepared)) &&
    (await currentPointsTo(paths, runtimeDirectory));
  if (!ready) {
    await withFileLock(paths.materializationLock, async () => {
      if (!(await verifyRuntime(runtimeDirectory, prepared))) {
        await materializeRuntime(paths, runtimeDirectory, prepared, hash);
      }
      if (!(await verifyRuntime(runtimeDirectory, prepared))) {
        throw new Error(`could not verify materialized Pi resources: ${runtimeDirectory}`);
      }
      if (!(await currentPointsTo(paths, runtimeDirectory))) {
        await activateRuntime(paths, runtimeDirectory);
      }
    });
  }

  return Object.freeze({
    arguments: createPiResourceArguments(runtimeDirectory, prepared),
    hash,
    runtimeDirectory,
  });
}
