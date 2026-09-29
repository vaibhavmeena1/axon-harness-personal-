import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { PRODUCT_IDENTITY } from "./identity.ts";

export interface DeputyDevPaths {
  readonly home: string;
  readonly bin: string;
  readonly managedBinary: string;
  readonly previousBinary: string;
  readonly runtime: string;
  readonly runtimeCurrent: string;
  readonly pi: string;
  readonly piSessions: string;
  readonly piPackageState: string;
  readonly piPackageLock: string;
  readonly piInstallLock: string;
  readonly piRuntime: string;
  readonly piExecutableState: string;
  readonly piMcpSyncState: string;
  readonly materializationLock: string;
  readonly staged: string;
  readonly stagedBinary: string;
  readonly stagedMetadata: string;
  readonly locks: string;
  readonly launcherState: string;
  readonly updateState: string;
  readonly holdState: string;
}

export function resolveDeputyDevPaths(
  environment: NodeJS.ProcessEnv = process.env,
  userHome: string = homedir(),
): DeputyDevPaths {
  const configuredHome = environment[PRODUCT_IDENTITY.homeEnvironmentVariable]?.trim();
  const home = resolve(configuredHome || join(userHome, PRODUCT_IDENTITY.defaultHomeDirectoryName));
  const bin = join(home, "bin");
  const runtime = join(home, "runtime");
  const pi = join(home, "pi");
  const locks = join(home, "locks");
  const staged = join(home, "staged");

  return Object.freeze({
    home,
    bin,
    managedBinary: join(bin, PRODUCT_IDENTITY.command),
    previousBinary: join(bin, `${PRODUCT_IDENTITY.command}.prev`),
    runtime,
    runtimeCurrent: join(runtime, "current"),
    pi,
    piSessions: join(pi, "sessions"),
    piPackageState: join(home, "pi-packages.json"),
    piPackageLock: join(locks, "pi-packages.lock"),
    piInstallLock: join(locks, "pi-install.lock"),
    piRuntime: join(home, "pi-runtime"),
    piExecutableState: join(home, "pi-executable.json"),
    piMcpSyncState: join(home, "pi-mcp-sync.json"),
    materializationLock: join(locks, "materialization.lock"),
    staged,
    stagedBinary: join(staged, PRODUCT_IDENTITY.command),
    stagedMetadata: join(staged, "meta.json"),
    locks,
    launcherState: join(home, "state.json"),
    updateState: join(home, "update.json"),
    holdState: join(home, "hold.json"),
  });
}
