import {
  type AuthenticatedRequestRelay,
  startAuthenticatedRequestRelay,
} from "../../cli/auth/request-relay.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../../cli/auth/session.ts";
import { fetchClientConfig } from "../../cli/client-config.ts";
import type { HarnessAdapter } from "../../launcher/contracts.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";
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
import { createTelemetryOverrides, isTelemetryDisabled } from "./telemetry-environment.ts";
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
      let relay: AuthenticatedRequestRelay | undefined;
      let litellmOverrides: EnvironmentOverrides = {
        PI_DEPUTYDEV_AUTH_RELAY_URL: undefined,
        PI_DEPUTYDEV_AUTH_RELAY_KEY: undefined,
      };
      let telemetryOverrides: EnvironmentOverrides = {};
      if (setup.invocationKind !== "administrative") {
        let encryptedSession: string | undefined;
        try {
          encryptedSession = await loadEncryptedSession(context.paths);
        } catch {
          throw new LauncherError(
            "Saved DeputyDev session could not be read safely",
            LAUNCHER_EXIT_STATUS.profileFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} auth login --browser.` },
          );
        }
        telemetryOverrides = createTelemetryOverrides(
          context.environment,
          undefined,
          setup.offline,
        );
        if (
          encryptedSession &&
          setup.invocationKind === "interactive" &&
          !setup.offline &&
          !isTelemetryDisabled(context.environment)
        ) {
          const result = await fetchClientConfig(encryptedSession);
          // Persist rotation before passing the credential to the child. Config is
          // optional, so a failed local rotation must not prevent Pi launch.
          let telemetry = result.config?.telemetry;
          try {
            if (
              result.sessionRefreshToken &&
              (await refreshEncryptedSession(
                context.paths,
                encryptedSession,
                result.sessionRefreshToken,
              ))
            ) {
              encryptedSession = result.sessionRefreshToken;
            }
            const currentSession = await loadEncryptedSession(context.paths);
            // Another CLI/VS Code login may have switched users during the fetch.
            // Discard preferences obtained under the old credential in that case.
            if (currentSession !== encryptedSession) telemetry = undefined;
            encryptedSession = currentSession;
          } catch {
            /* Preserve the previous credential; no token diagnostics. */
          }
          telemetryOverrides = createTelemetryOverrides(context.environment, telemetry, false, {
            home: context.paths.home,
          });
        }
        // Pi receives only a per-launch loopback capability. The relay reads the
        // live session for each request and owns refresh persistence and recovery.
        relay = startAuthenticatedRequestRelay(context.paths);
        litellmOverrides = {
          LITELLM_API_KEY: relay.capability,
          LITELLM_BASE_URL: new URL("/litellm", relay.origin).toString(),
          PI_MODEL_RECOMMENDER_API_KEY: relay.capability,
          PI_MODEL_RECOMMENDER_URL: new URL(
            "/api/v1/model-recommendations",
            relay.origin,
          ).toString(),
          PI_DEPUTYDEV_AUTH_RELAY_URL: relay.origin,
          PI_DEPUTYDEV_AUTH_RELAY_KEY: relay.capability,
        };
      }
      return Object.freeze({
        executable: context.executable,
        arguments: [...resourceArguments, ...userArguments],
        environment: createPiEnvironment(
          context.environment,
          context.paths,
          litellmOverrides,
          telemetryOverrides,
        ),
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
