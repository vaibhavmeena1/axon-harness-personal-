import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { BUILD_INFO, type BuildInfo } from "../build-info.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { withFileLock } from "../launcher/file-lock.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import { type DeputyDevPaths, resolveDeputyDevPaths } from "../product/paths.ts";
import { emitProductEvent, productFailureReason } from "../telemetry/product-events.ts";
import {
  assertReleaseVersion,
  downloadVerifiedRelease,
  latestReleaseVersion,
  type ReleaseClient,
} from "./release.ts";

const BACKGROUND_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FAILED_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const NO_UPDATE_ENV = "DEPUTYDEV_NO_UPDATE";
const CI_ENV = "CI";

export interface UpdateContext {
  readonly build: BuildInfo;
  readonly paths: DeputyDevPaths;
  readonly executable: string;
  readonly client: ReleaseClient;
  readonly verifySignature?: (path: string) => Promise<void>;
}

export function updateContext(): UpdateContext {
  return {
    build: BUILD_INFO,
    paths: resolveDeputyDevPaths(),
    executable: process.execPath,
    client: {
      baseUrl: resolveServiceUrl(BUILD_INFO.serviceOrigin, SERVICE_ENDPOINTS.release.base),
    },
  };
}

function assertSupported(context: UpdateContext): void {
  if (
    context.build.kind !== "binary" ||
    context.build.target !== "darwin-arm64" ||
    process.platform !== "darwin" ||
    process.arch !== "arm64"
  ) {
    throw new Error("updates require a managed macOS arm64 release binary");
  }
  assertReleaseVersion(context.build.version);
}

async function assertManagedInstallation(context: UpdateContext): Promise<void> {
  const { paths, executable } = context;
  const [home, bin, managed, running] = await Promise.all([
    lstat(paths.home),
    lstat(paths.bin),
    lstat(paths.managedBinary),
    stat(executable),
  ]);
  if (
    !home.isDirectory() ||
    home.isSymbolicLink() ||
    !bin.isDirectory() ||
    bin.isSymbolicLink() ||
    !managed.isFile() ||
    managed.isSymbolicLink() ||
    (process.getuid !== undefined &&
      (home.uid !== process.getuid() ||
        bin.uid !== process.getuid() ||
        managed.uid !== process.getuid())) ||
    (home.mode & 0o077) !== 0 ||
    (bin.mode & 0o077) !== 0 ||
    managed.dev !== running.dev ||
    managed.ino !== running.ino ||
    resolve(paths.managedBinary) === "/"
  ) {
    throw new Error("refusing to update an unsafe or unmanaged installation");
  }
}

async function verifyStagedBinary(
  context: UpdateContext,
  binary: string,
  version: string,
): Promise<void> {
  await chmod(binary, 0o755);
  if (context.verifySignature) {
    await context.verifySignature(binary);
  } else {
    const signature = Bun.spawn(["codesign", "--verify", "--verbose=2", binary], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 10_000,
    });
    if ((await signature.exited) !== 0)
      throw new Error("downloaded binary has an invalid code signature");
  }
  const probe = Bun.spawn([binary, "--version"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  const output = await new Response(probe.stdout).text();
  if ((await probe.exited) !== 0 || output.trim() !== version) {
    throw new Error("downloaded binary reports the wrong version");
  }
}

async function latest(context: UpdateContext): Promise<string> {
  assertSupported(context);
  return latestReleaseVersion(context.client);
}

export async function checkForUpdate(
  context: UpdateContext = updateContext(),
): Promise<string | undefined> {
  const startedAt = Date.now();
  try {
    const version = await latest(context);
    const available = Bun.semver.order(version, context.build.version) > 0;
    emitProductEvent({
      category: "update",
      stage: "check",
      outcome: "success",
      reason: available ? undefined : "up_to_date",
      version: context.build.version,
      durationMs: Date.now() - startedAt,
    });
    return available ? version : undefined;
  } catch (error) {
    emitProductEvent({
      category: "update",
      stage: "check",
      outcome: "failed",
      reason: productFailureReason(error),
      version: context.build.version,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

async function performUpdate(context: UpdateContext): Promise<string | undefined> {
  await assertManagedInstallation(context);
  const version = await checkForUpdate(context);
  if (!version) return undefined;

  // The staging directory lives on the same filesystem as the installed binary.
  const staging = await mkdtemp(join(context.paths.bin, ".ddcli-update-"));
  try {
    const binary = await downloadVerifiedRelease(context.client, version, staging);
    await verifyStagedBinary(context, binary, version);
    // Recheck the inode immediately before activation: a different updater or user may
    // have replaced the executable while we were downloading.
    await assertManagedInstallation(context);
    const backup = join(staging, "ddcli.prev");
    await copyFile(context.paths.managedBinary, backup);
    // Activate with one atomic rename; only then replace the previous backup.
    // If the backup cannot be installed, restore the original before reporting failure.
    await rename(binary, context.paths.managedBinary);
    try {
      await rename(backup, context.paths.previousBinary);
    } catch (error) {
      await rename(backup, context.paths.managedBinary);
      throw error;
    }
    return version;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installUpdate(
  context: UpdateContext = updateContext(),
): Promise<string | undefined> {
  const startedAt = Date.now();
  try {
    assertSupported(context);
    await assertManagedInstallation(context);
    const installed = await withFileLock(join(context.paths.locks, "update.lock"), () =>
      performUpdate(context),
    );
    emitProductEvent({
      category: "update",
      stage: "install",
      outcome: installed ? "success" : "skipped",
      reason: installed ? undefined : "up_to_date",
      version: installed ?? context.build.version,
      durationMs: Date.now() - startedAt,
    });
    return installed;
  } catch (error) {
    emitProductEvent({
      category: "update",
      stage: "install",
      outcome: "failed",
      reason: productFailureReason(error),
      version: context.build.version,
      durationMs: Date.now() - startedAt,
    });
    throw new LauncherError("could not update ddcli", LAUNCHER_EXIT_STATUS.updateFailure, {
      cause: error,
      remediation: "Keep using the current installation and retry ddcli update.",
    });
  }
}

async function nextCheckAt(path: string): Promise<number> {
  try {
    const state: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof state === "object" &&
      state !== null &&
      "nextCheckAt" in state &&
      typeof state.nextCheckAt === "number" &&
      Number.isFinite(state.nextCheckAt)
    ) {
      return state.nextCheckAt;
    }
  } catch {
    /* Missing/corrupt state means retry. */
  }
  return 0;
}

async function recordNextCheck(path: string, milliseconds: number): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ nextCheckAt: Date.now() + milliseconds }), {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runBackgroundUpdate(context: UpdateContext = updateContext()): Promise<void> {
  if (context.build.kind !== "binary" || process.env[NO_UPDATE_ENV] === "1" || process.env[CI_ENV])
    return;
  try {
    await assertManagedInstallation(context);
    await mkdir(context.paths.locks, { recursive: true, mode: 0o700 });
    await withFileLock(
      join(context.paths.locks, "update.lock"),
      async () => {
        if (Date.now() < (await nextCheckAt(context.paths.updateState))) return;
        await recordNextCheck(context.paths.updateState, FAILED_CHECK_INTERVAL_MS);
        const startedAt = Date.now();
        try {
          const installed = await performUpdate(context);
          emitProductEvent({
            category: "update",
            stage: "install",
            outcome: installed ? "success" : "skipped",
            reason: installed ? undefined : "up_to_date",
            version: installed ?? context.build.version,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          emitProductEvent({
            category: "update",
            stage: "install",
            outcome: "failed",
            reason: productFailureReason(error),
            version: context.build.version,
            durationMs: Date.now() - startedAt,
          });
          throw error;
        }
        await recordNextCheck(context.paths.updateState, BACKGROUND_CHECK_INTERVAL_MS);
      },
      { timeoutMs: 100 },
    );
  } catch {
    /* Best-effort worker never affects the user's completed command. */
  }
}

export function scheduleBackgroundUpdate(): void {
  if (
    BUILD_INFO.kind !== "binary" ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    process.env[NO_UPDATE_ENV] === "1" ||
    process.env[CI_ENV]
  )
    return;
  try {
    const worker = Bun.spawn([process.execPath, "__background-update"], {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    });
    worker.unref();
  } catch {
    /* An optional update must not affect harness exit status. */
  }
}
