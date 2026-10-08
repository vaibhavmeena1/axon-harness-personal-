import { rm, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { SESSION_FILE_NAME } from "../auth/session.ts";

export interface UninstallOptions {
  readonly removeRuntimes?: boolean;
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStatus, rightStatus] = await Promise.all([stat(left), stat(right)]);
    return leftStatus.dev === rightStatus.dev && leftStatus.ino === rightStatus.ino;
  } catch {
    return false;
  }
}

function assertSafeManagedHome(paths: AxonPaths): void {
  const home = resolve(paths.home);
  if (home === parse(home).root || dirname(paths.managedBinary) !== paths.bin) {
    throw new LauncherError(
      `refusing to uninstall from unsafe managed home: ${paths.home}`,
      LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
      { remediation: `Check ${PRODUCT_IDENTITY.homeEnvironmentVariable} and rerun paths.` },
    );
  }
}

export async function runUninstall(paths: AxonPaths, options: UninstallOptions): Promise<void> {
  assertSafeManagedHome(paths);

  if (!(await sameFile(process.execPath, paths.managedBinary))) {
    throw new LauncherError(
      `refusing to remove an unmanaged executable; this process is not ${paths.managedBinary}`,
      LAUNCHER_EXIT_STATUS.unsupportedEnvironment,
      {
        remediation:
          "Run the managed binary directly, or use the package manager that installed this copy.",
      },
    );
  }

  await rm(paths.managedBinary, { force: true });
  await rm(paths.previousBinary, { force: true });
  console.log(`removed managed binary: ${paths.managedBinary}`);

  if (options.removeRuntimes === true) {
    await rm(paths.runtime, { force: true, recursive: true });
    await rm(paths.piRuntime, { force: true, recursive: true });
    console.log(`removed cached runtimes: ${paths.runtime}, ${paths.piRuntime}`);
  } else {
    console.log(`preserved cached runtimes: ${paths.runtime}, ${paths.piRuntime}`);
  }

  // The session file may also be used by the VS Code extension; uninstall never removes it.
  console.log(`preserved shared authentication file: ${join(paths.home, SESSION_FILE_NAME)}`);
}
