import type { DeputyDevPaths } from "../../product/paths.ts";

export function printPaths(paths: DeputyDevPaths): void {
  const entries = [
    ["home", paths.home],
    ["managed binary", paths.managedBinary],
    ["previous binary", paths.previousBinary],
    ["runtime", paths.runtime],
    ["active runtime", paths.runtimeCurrent],
    ["Pi agent directory", paths.pi],
    ["Pi session directory", paths.piSessions],
    ["Pi package state", paths.piPackageState],
    ["Pi package lock", paths.piPackageLock],
    ["staged binary", paths.stagedBinary],
    ["staged metadata", paths.stagedMetadata],
    ["locks", paths.locks],
    ["launcher state", paths.launcherState],
    ["update state", paths.updateState],
    ["rollback hold", paths.holdState],
  ] as const;

  for (const [label, path] of entries) {
    console.log(`${label}: ${path}`);
  }
}
