import { loadHarnessAdapter } from "../harnesses/registry.ts";
import { resolveDeputyDevPaths } from "../product/paths.ts";
import type { HarnessLaunchContext, HarnessRegistration, LaunchSpec } from "./contracts.ts";
import { isTrue, printDebugLaunchPreview } from "./debug-preview.ts";
import { createHarnessEnvironment } from "./environment.ts";
import { LauncherError } from "./errors.ts";
import { resolveExecutablePath } from "./executable.ts";
import { LAUNCHER_EXIT_STATUS } from "./exit-status.ts";
import { spawnHarness } from "./spawn-harness.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "DEPUTYDEV_DEBUG";

export async function launchRegisteredHarness(
  registration: HarnessRegistration,
  userArguments: readonly string[],
): Promise<never> {
  const cwd = process.cwd();
  const inheritedEnvironment = process.env;
  const paths = resolveDeputyDevPaths(inheritedEnvironment);
  const adapter = await loadHarnessAdapter(registration.id);
  const executable =
    adapter.resolveExecutable === undefined
      ? (await resolveExecutablePath(registration, inheritedEnvironment, cwd)).path
      : await adapter.resolveExecutable(
          Object.freeze({ cwd, environment: inheritedEnvironment, paths }),
          registration,
          { userArguments, allowInstall: true },
        );

  const context: HarnessLaunchContext = Object.freeze({
    cwd,
    environment: inheritedEnvironment,
    paths,
    registration,
    executable,
  });

  try {
    await adapter.prepare(context, userArguments);
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }

    throw new LauncherError(
      `failed to prepare the ${registration.id} harness`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: `Run ddcli doctor ${registration.id}.` },
    );
  }

  let specification: LaunchSpec;
  try {
    specification = await adapter.buildLaunchSpec(context, userArguments);
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }

    throw new LauncherError(
      `failed to build the ${registration.id} launch command`,
      LAUNCHER_EXIT_STATUS.profileFailure,
      { cause: error, remediation: `Run ddcli doctor ${registration.id}.` },
    );
  }

  if (specification.executable !== executable) {
    specification.dispose?.();
    throw new LauncherError(
      `${registration.id} adapter attempted to replace the allowlisted executable`,
      LAUNCHER_EXIT_STATUS.executableUnavailable,
      { remediation: `Run ddcli doctor ${registration.id}.` },
    );
  }

  if (isTrue(inheritedEnvironment[DEBUG_ENVIRONMENT_VARIABLE])) {
    printDebugLaunchPreview({
      harness: registration.id,
      executable: specification.executable,
      arguments: specification.arguments,
      cwd: specification.cwd,
    });
  }

  return spawnHarness({
    ...specification,
    environment: createHarnessEnvironment(specification.environment),
  });
}
