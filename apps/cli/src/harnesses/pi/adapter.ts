import type { HarnessAdapter } from "../../launcher/contracts.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { createPiEnvironment } from "./environment.ts";
import {
  inspectPiRuntime,
  resolveConfiguredPiVersion,
  resolvePiExecutable,
} from "./installation.ts";
import { type PiSetupResult, preparePiSetup } from "./setup/index.ts";
import { inspectPiPackages } from "./setup/packages/doctor.ts";
import { resolvePiVersion } from "./version.ts";

export function createPiAdapter(): HarnessAdapter {
  let setup: PiSetupResult | undefined;

  const adapter: HarnessAdapter = {
    id: "pi",
    exactVersion: (context) => resolveConfiguredPiVersion(context.environment),
    resolveExecutable: (context, registration, options) =>
      resolvePiExecutable(context, registration, options),
    probeVersion: (context, executable) => resolvePiVersion(executable, context),
    prepare: async (context, userArguments) => {
      setup = await preparePiSetup(context, userArguments);
    },
    buildLaunchSpec: (context, userArguments) => {
      if (setup === undefined) {
        return Promise.reject(
          new LauncherError(
            "pi launch was built before setup ran",
            LAUNCHER_EXIT_STATUS.materializationFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} doctor pi.` },
          ),
        );
      }
      // Ordinary sessions reference the immutable, verified runtime directory
      // that setup materialized. Administration is forwarded untouched.
      const resourceArguments = setup.materialization?.arguments ?? [];
      return Promise.resolve(
        Object.freeze({
          executable: context.executable,
          arguments: [...resourceArguments, ...userArguments],
          environment: createPiEnvironment(context.environment, context.paths),
          cwd: context.cwd,
        }),
      );
    },
    doctor: async (context) => [
      ...(await inspectPiRuntime(context)),
      ...(await inspectPiPackages(context)),
    ],
  };

  return Object.freeze(adapter);
}
