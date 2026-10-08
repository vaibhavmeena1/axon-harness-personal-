import { chmod, lstat, mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const verifiedPackageStateSchema = z.strictObject({
  id: z.string(),
  identity: z.string(),
  configuredSource: z.string(),
  sourceKind: z.enum(["npm", "git"]),
  installedVersion: z.string().optional(),
  installedCommit: z.string().optional(),
  verifiedAt: z.string(),
});

const piPackageStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  manifestHash: z.string(),
  packages: z.record(z.string(), verifiedPackageStateSchema),
});

export type VerifiedPackageState = z.infer<typeof verifiedPackageStateSchema>;
export type PiPackageState = z.infer<typeof piPackageStateSchema>;

export function emptyPiPackageState(): PiPackageState {
  return {
    schemaVersion: 1,
    manifestHash: "",
    packages: {},
  };
}

export async function readPiPackageState(path: string): Promise<PiPackageState> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return emptyPiPackageState();
    }
    throw new Error(`could not inspect Pi package state: ${path}`, { cause: error });
  }

  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`Pi package state is not a regular file: ${path}`);
  }
  try {
    return piPackageStateSchema.parse(JSON.parse(await Bun.file(path).text()));
  } catch {
    // This file contains only derived Axon verification state. Rebuild a
    // corrupt regular file from settings and installed package metadata.
    return emptyPiPackageState();
  }
}

export async function writePiPackageState(path: string, state: PiPackageState): Promise<void> {
  const validated = piPackageStateSchema.parse(state);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}
