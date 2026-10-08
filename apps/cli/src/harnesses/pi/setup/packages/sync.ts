import { lstat } from "node:fs/promises";

import type { HarnessLaunchContext } from "../../../../launcher/contracts.ts";
import { LauncherError } from "../../../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../../../launcher/exit-status.ts";
import { withFileLock } from "../../../../launcher/file-lock.ts";
import { PRODUCT_IDENTITY } from "../../../../product/identity.ts";
import { AXON_MANIFEST } from "../../../../product/manifest.ts";
import { createPiEnvironment } from "../../environment.ts";
import { type InstalledPackageInspection, inspectInstalledPackage } from "./inspect.ts";
import {
  type AxonManifest,
  hashAxonManifest,
  type NormalizedPiPackage,
  normalizePiPackage,
  resolveInstalledIdentityPath,
} from "./manifest.ts";
import {
  findPackageSetting,
  isUnmodifiedManagedSetting,
  piSettingsPath,
  readPiSettings,
  reconcilePackageSettings,
  writePiSettings,
} from "./settings.ts";
import {
  emptyPiPackageState,
  type PiPackageState,
  readPiPackageState,
  type VerifiedPackageState,
  writePiPackageState,
} from "./state.ts";

export type PiPackageAction = "install" | "remove";

export interface PiPackageActionRequest {
  readonly action: PiPackageAction;
  readonly source: string;
}

export type PiPackageActionRunner = (
  request: PiPackageActionRequest,
) => Promise<{ readonly exitCode: number }>;

export interface PiPackageSyncOptions {
  readonly allowInstall: boolean;
  readonly context: HarnessLaunchContext;
  readonly manifest?: AxonManifest;
  readonly now?: () => Date;
  readonly runAction?: PiPackageActionRunner;
}

export interface PiPackageSyncResult {
  readonly changed: boolean;
  readonly manifestHash: string;
  readonly packages: readonly VerifiedPackageState[];
  readonly warnings: readonly string[];
}

interface LocalSnapshot {
  readonly inspections: ReadonlyMap<string, InstalledPackageInspection>;
  readonly settings: Awaited<ReturnType<typeof readPiSettings>>;
  readonly state: PiPackageState;
}

function describeAction(request: PiPackageActionRequest): string {
  return `${request.action === "install" ? "Installing" : "Removing"} ${request.source}`;
}

async function runPiPackageAction(
  context: HarnessLaunchContext,
  request: PiPackageActionRequest,
): Promise<{ readonly exitCode: number }> {
  console.error(`${PRODUCT_IDENTITY.command}: ${describeAction(request)}...`);
  const subprocess = Bun.spawn([context.executable, request.action, request.source], {
    cwd: context.cwd,
    env: createPiEnvironment(context.environment, context.paths),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const forwardingHandlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    const handler = (): void => {
      if (subprocess.exitCode === null && subprocess.signalCode === null) {
        subprocess.kill(signal);
      }
    };
    forwardingHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  try {
    const exitCode = await subprocess.exited;
    if (subprocess.signalCode !== null) {
      throw new Error(`Pi package ${request.action} terminated by signal ${subprocess.signalCode}`);
    }
    return { exitCode };
  } finally {
    for (const [signal, handler] of forwardingHandlers) {
      process.off(signal, handler);
    }
  }
}

function packageStateMatchesInspection(
  state: VerifiedPackageState | undefined,
  packageEntry: NormalizedPiPackage,
  inspection: InstalledPackageInspection,
): boolean {
  return (
    state !== undefined &&
    state.id === packageEntry.id &&
    state.identity === packageEntry.identity &&
    state.configuredSource === packageEntry.configuredSource &&
    state.sourceKind === packageEntry.sourceKind &&
    state.installedVersion === inspection.installedVersion &&
    state.installedCommit === inspection.installedCommit
  );
}

async function inspectLocalState(
  context: HarnessLaunchContext,
  packages: readonly NormalizedPiPackage[],
): Promise<LocalSnapshot> {
  const [state, settings, inspectionEntries] = await Promise.all([
    readPiPackageState(context.paths.piPackageState),
    readPiSettings(piSettingsPath(context.paths.pi)),
    Promise.all(
      packages.map(
        async (packageEntry) =>
          [
            packageEntry.identity,
            await inspectInstalledPackage(packageEntry, context.paths.pi),
          ] as const,
      ),
    ),
  ]);
  return {
    inspections: new Map(inspectionEntries),
    settings,
    state,
  };
}

function isRecordedFallbackCurrent(
  snapshot: LocalSnapshot,
  packageEntry: NormalizedPiPackage,
  inspection: InstalledPackageInspection,
): boolean {
  const state = snapshot.state.packages[packageEntry.identity];
  if (
    packageEntry.versionPolicy.kind !== "exact" ||
    state === undefined ||
    state.id !== packageEntry.id ||
    state.identity !== packageEntry.identity ||
    state.sourceKind !== packageEntry.sourceKind ||
    state.configuredSource === packageEntry.configuredSource ||
    findPackageSetting(snapshot.settings, packageEntry.identity) !== state.configuredSource ||
    !inspection.valid
  ) {
    return false;
  }
  if (packageEntry.sourceKind === "npm") {
    return (
      inspection.installedVersion === state.installedVersion &&
      inspection.installedVersion !== undefined &&
      !packageEntry.revokedVersions.includes(inspection.installedVersion)
    );
  }
  return (
    inspection.installedCommit !== undefined && inspection.installedCommit === state.installedCommit
  );
}

function currentFallbackWarnings(
  snapshot: LocalSnapshot,
  packages: readonly NormalizedPiPackage[],
): readonly string[] {
  return packages.flatMap((packageEntry) => {
    const inspection = snapshot.inspections.get(packageEntry.identity);
    return inspection !== undefined && isRecordedFallbackCurrent(snapshot, packageEntry, inspection)
      ? [
          `using last verified ${packageEntry.id} version ${inspection.installedVersion ?? inspection.installedCommit}`,
        ]
      : [];
  });
}

function isSnapshotCurrent(
  snapshot: LocalSnapshot,
  packages: readonly NormalizedPiPackage[],
  manifestHash: string,
  acceptRecordedFallback: boolean,
): boolean {
  if (packages.length === 0 && Object.keys(snapshot.state.packages).length === 0) {
    return true;
  }
  if (snapshot.state.manifestHash !== manifestHash) {
    return false;
  }
  if (Object.keys(snapshot.state.packages).length !== packages.length) {
    return false;
  }

  return packages.every((packageEntry) => {
    const inspection = snapshot.inspections.get(packageEntry.identity);
    const setting = findPackageSetting(snapshot.settings, packageEntry.identity);
    if (inspection === undefined) {
      return false;
    }
    return (
      (inspection.satisfiesPolicy === true &&
        setting === packageEntry.configuredSource &&
        packageStateMatchesInspection(
          snapshot.state.packages[packageEntry.identity],
          packageEntry,
          inspection,
        )) ||
      (acceptRecordedFallback && isRecordedFallbackCurrent(snapshot, packageEntry, inspection))
    );
  });
}

function verifiedState(
  packageEntry: NormalizedPiPackage,
  configuredSource: string,
  inspection: InstalledPackageInspection,
  now: Date,
): VerifiedPackageState {
  return {
    id: packageEntry.id,
    identity: packageEntry.identity,
    configuredSource,
    sourceKind: packageEntry.sourceKind,
    ...(inspection.installedVersion === undefined
      ? {}
      : { installedVersion: inspection.installedVersion }),
    ...(inspection.installedCommit === undefined
      ? {}
      : { installedCommit: inspection.installedCommit }),
    verifiedAt: now.toISOString(),
  };
}

export function canUseExactFallback(
  packageEntry: NormalizedPiPackage,
  inspection: InstalledPackageInspection,
  previous: VerifiedPackageState | undefined,
): previous is VerifiedPackageState {
  if (packageEntry.versionPolicy.kind !== "exact" || previous === undefined || !inspection.valid) {
    return false;
  }
  if (packageEntry.sourceKind === "npm") {
    return (
      inspection.installedVersion !== undefined &&
      inspection.installedVersion === previous.installedVersion &&
      !packageEntry.revokedVersions.includes(inspection.installedVersion)
    );
  }
  return (
    inspection.installedCommit !== undefined &&
    inspection.installedCommit === previous.installedCommit
  );
}

function packageFailure(packageEntry: NormalizedPiPackage, reason: string): LauncherError {
  return new LauncherError(
    `required Pi package ${packageEntry.id} is unavailable: ${reason}`,
    LAUNCHER_EXIT_STATUS.profileFailure,
    {
      remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
    },
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removeDroppedPackages(
  packages: readonly NormalizedPiPackage[],
  snapshot: LocalSnapshot,
  piAgentDirectory: string,
  runAction: PiPackageActionRunner,
  warnings: string[],
): Promise<{
  readonly removedIdentities: ReadonlySet<string>;
  readonly retainedState: Readonly<Record<string, VerifiedPackageState>>;
}> {
  const desiredIdentities = new Set(packages.map((entry) => entry.identity));
  const removedIdentities = new Set<string>();
  const retainedState: Record<string, VerifiedPackageState> = {};

  for (const previous of Object.values(snapshot.state.packages)) {
    if (desiredIdentities.has(previous.identity)) {
      continue;
    }
    if (
      !isUnmodifiedManagedSetting(snapshot.settings, previous.identity, previous.configuredSource)
    ) {
      warnings.push(`preserved user-modified package ${previous.identity}`);
      continue;
    }

    try {
      const result = await runAction({ action: "remove", source: previous.configuredSource });
      if (result.exitCode !== 0) {
        throw new Error(`Pi remove exited with code ${result.exitCode}`);
      }
      const installedPath = resolveInstalledIdentityPath(previous.identity, piAgentDirectory);
      if (await pathExists(installedPath)) {
        throw new Error(`Pi remove left package files at ${installedPath}`);
      }
      removedIdentities.add(previous.identity);
    } catch (error) {
      warnings.push(
        `could not remove retired package ${previous.identity}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      retainedState[previous.identity] = previous;
    }
  }

  return { removedIdentities, retainedState };
}

async function synchronizeLocked(
  options: PiPackageSyncOptions,
  packages: readonly NormalizedPiPackage[],
  manifestHash: string,
): Promise<PiPackageSyncResult> {
  const snapshot = await inspectLocalState(options.context, packages);
  if (isSnapshotCurrent(snapshot, packages, manifestHash, !options.allowInstall)) {
    return {
      changed: false,
      manifestHash,
      packages: Object.values(snapshot.state.packages),
      warnings: currentFallbackWarnings(snapshot, packages),
    };
  }

  const runAction =
    options.runAction ?? ((request) => runPiPackageAction(options.context, request));
  const now = options.now?.() ?? new Date();
  const warnings: string[] = [];
  const desiredSources = new Map<string, string>();
  const nextPackageState: Record<string, VerifiedPackageState> = {};
  const removed = await removeDroppedPackages(
    packages,
    snapshot,
    options.context.paths.pi,
    runAction,
    warnings,
  );
  Object.assign(nextPackageState, removed.retainedState);

  for (const packageEntry of packages) {
    let inspection = await inspectInstalledPackage(packageEntry, options.context.paths.pi);
    let activeSource = packageEntry.configuredSource;

    if (!inspection.satisfiesPolicy) {
      const previous = snapshot.state.packages[packageEntry.identity];
      if (!options.allowInstall) {
        if (!canUseExactFallback(packageEntry, inspection, previous)) {
          throw packageFailure(packageEntry, inspection.reason ?? "installation is required");
        }
        activeSource = previous.configuredSource;
        warnings.push(
          `using last verified ${packageEntry.id} version ${inspection.installedVersion ?? inspection.installedCommit}`,
        );
      } else {
        let installError: unknown;
        try {
          const result = await runAction({
            action: "install",
            source: packageEntry.configuredSource,
          });
          if (result.exitCode !== 0) {
            throw new Error(`Pi install exited with code ${result.exitCode}`);
          }
          inspection = await inspectInstalledPackage(packageEntry, options.context.paths.pi);
          if (!inspection.satisfiesPolicy) {
            throw new Error(inspection.reason ?? "installed package failed verification");
          }
        } catch (error) {
          installError = error;
        }

        if (installError !== undefined) {
          inspection = await inspectInstalledPackage(packageEntry, options.context.paths.pi);
          if (!canUseExactFallback(packageEntry, inspection, previous)) {
            throw packageFailure(
              packageEntry,
              installError instanceof Error ? installError.message : String(installError),
            );
          }
          activeSource = previous.configuredSource;
          warnings.push(
            `could not install ${packageEntry.configuredSource}; using last verified ${inspection.installedVersion ?? inspection.installedCommit}`,
          );
        }
      }
    }

    if (!inspection.valid) {
      throw packageFailure(packageEntry, inspection.reason ?? "installed package is invalid");
    }
    desiredSources.set(packageEntry.identity, activeSource);
    nextPackageState[packageEntry.identity] = verifiedState(
      packageEntry,
      activeSource,
      inspection,
      now,
    );
  }

  // Pi install/remove may have changed settings. Re-read before the narrow merge.
  const latestSettings = await readPiSettings(piSettingsPath(options.context.paths.pi));
  const reconciled = reconcilePackageSettings(
    latestSettings,
    desiredSources,
    removed.removedIdentities,
  );
  if (reconciled.changed) {
    await writePiSettings(latestSettings, reconciled.config);
  }

  const nextState: PiPackageState = {
    ...emptyPiPackageState(),
    manifestHash,
    packages: nextPackageState,
  };
  await writePiPackageState(options.context.paths.piPackageState, nextState);

  return {
    changed: true,
    manifestHash,
    packages: Object.values(nextPackageState),
    warnings,
  };
}

export async function synchronizePiPackages(
  options: PiPackageSyncOptions,
): Promise<PiPackageSyncResult> {
  const manifest = options.manifest ?? AXON_MANIFEST;
  const packages = manifest.pi.packages.map(normalizePiPackage);
  const manifestHash = hashAxonManifest(manifest);
  const initialSnapshot = await inspectLocalState(options.context, packages);
  if (isSnapshotCurrent(initialSnapshot, packages, manifestHash, !options.allowInstall)) {
    return {
      changed: false,
      manifestHash,
      packages: Object.values(initialSnapshot.state.packages),
      warnings: currentFallbackWarnings(initialSnapshot, packages),
    };
  }

  return withFileLock(options.context.paths.piPackageLock, () =>
    synchronizeLocked(options, packages, manifestHash),
  );
}
