import { chmod, lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { LaunchContext } from "../../launcher/contracts.ts";
import { parseFirstSemVer } from "../../launcher/version.ts";
import { createPiEnvironment } from "./environment.ts";

export type PiVersionProber = (
  executable: string,
  environment: NodeJS.ProcessEnv,
) => Promise<string | undefined>;

export interface PiVersionResolutionOptions {
  readonly probe?: PiVersionProber;
  readonly now?: () => Date;
}

const PROBE_TIMEOUT_MS = 5_000;

const executableRecordSchema = z.strictObject({
  size: z.number(),
  mtimeMs: z.number(),
  version: z.string(),
  checkedAt: z.string(),
});

const executableStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  executables: z.record(z.string(), executableRecordSchema),
});

type PiExecutableState = z.infer<typeof executableStateSchema>;

function emptyState(): PiExecutableState {
  return { schemaVersion: 1, executables: {} };
}

async function readState(path: string): Promise<PiExecutableState> {
  try {
    const status = await lstat(path);
    if (!status.isFile() || status.isSymbolicLink()) {
      return emptyState();
    }
    return executableStateSchema.parse(JSON.parse(await Bun.file(path).text()));
  } catch {
    // Derived cache only; a missing or corrupt file costs one `pi --version`.
    return emptyState();
  }
}

async function writeState(path: string, state: PiExecutableState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporaryPath, `${JSON.stringify(state, null, 2)}\n`);
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  } catch {
    // Best effort cache.
  }
}

/** Run `<executable> --version` with the isolated, offline Pi environment. */
export async function probePiVersion(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const subprocess = Bun.spawn([executable, "--version"], {
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      subprocess.exited,
    ]);
    return exitCode === 0 ? parseFirstSemVer(stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the version of a Pi executable, caching by path, size, and mtime in
 * `${AXON_HOME}/pi-executable.json` so warm launches do not spawn Pi twice.
 * Unknown versions are never cached.
 */
export async function resolvePiVersion(
  executable: string,
  context: LaunchContext,
  options: PiVersionResolutionOptions = {},
): Promise<string | undefined> {
  let fileStatus: Awaited<ReturnType<typeof stat>>;
  try {
    fileStatus = await stat(executable);
  } catch {
    return undefined;
  }

  const statePath = context.paths.piExecutableState;
  const state = await readState(statePath);
  const cached = state.executables[executable];
  if (
    cached !== undefined &&
    cached.size === fileStatus.size &&
    cached.mtimeMs === fileStatus.mtimeMs
  ) {
    return cached.version;
  }

  const probe = options.probe ?? probePiVersion;
  const version = await probe(
    executable,
    createPiEnvironment(context.environment, context.paths, { PI_OFFLINE: "1" }),
  );
  if (version === undefined) {
    return undefined;
  }

  await writeState(statePath, {
    schemaVersion: 1,
    executables: {
      ...state.executables,
      [executable]: {
        size: fileStatus.size,
        mtimeMs: fileStatus.mtimeMs,
        version,
        checkedAt: (options.now?.() ?? new Date()).toISOString(),
      },
    },
  });
  return version;
}
