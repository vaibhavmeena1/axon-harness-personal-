import { startAuthenticatedRequestRelay } from "../../cli/auth/request-relay.ts";
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
    buildLaunchSpec: async (context, userArguments) => {
      if (setup === undefined) {
        throw new LauncherError(
          "pi launch was built before setup ran",
          LAUNCHER_EXIT_STATUS.materializationFailure,
          { remediation: `Run ${PRODUCT_IDENTITY.command} doctor pi.` },
        );
      }
      // Ordinary sessions reference the immutable, verified runtime directory
      // that setup materialized. Administration is forwarded untouched.
      const resourceArguments = setup.materialization?.arguments ?? [];
      const relay =
        setup.invocationKind === "administrative"
          ? undefined
          : startAuthenticatedRequestRelay(context.paths);
      // Pi holds only a per-launch loopback capability. ddcli loads the real
      // session immediately before every managed request, including discovery.
      const litellmOverrides =
        relay === undefined
          ? {}
          : {
              LITELLM_API_KEY: relay.capability,
              LITELLM_BASE_URL: `${relay.origin}/litellm`,
              PI_MODEL_RECOMMENDER_API_KEY: relay.capability,
              PI_MODEL_RECOMMENDER_URL: `${relay.origin}/api/v1/model-recommendations`,
              // PI_* survives the final harness environment sanitization; DEPUTYDEV_*
              // is reserved for launcher-only configuration and would be stripped.
              PI_DEPUTYDEV_AUTH_RELAY_URL:
                setup.invocationKind === "interactive" ? relay.origin : undefined,
              PI_DEPUTYDEV_AUTH_RELAY_KEY:
                setup.invocationKind === "interactive" ? relay.capability : undefined,
            };
      return Object.freeze({
        executable: context.executable,
        arguments: [...resourceArguments, ...userArguments],
        environment: createPiEnvironment(context.environment, context.paths, litellmOverrides),
        cwd: context.cwd,
        ...(relay === undefined ? {} : { dispose: relay.dispose }),
      });
    },
    doctor: async (context) => [
      ...(await inspectPiRuntime(context)),
      ...(await inspectPiPackages(context)),
    ],
  };

  return Object.freeze(adapter);
}
