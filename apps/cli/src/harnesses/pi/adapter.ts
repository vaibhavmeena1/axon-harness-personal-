import {
  type AuthenticatedRequestRelay,
  startAuthenticatedRequestRelay,
} from "../../cli/auth/request-relay.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../../cli/auth/session.ts";
import { fetchClientConfig, type WebSearchConfig } from "../../cli/client-config.ts";
import type { HarnessAdapter } from "../../launcher/contracts.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { closeProductTelemetry, initializeProductTelemetry } from "../../telemetry/client.ts";
import { createPiEnvironment } from "./environment.ts";
import {
  inspectPiRuntime,
  resolveConfiguredPiVersion,
  resolvePiExecutable,
} from "./installation.ts";
import { invalidateStalePiRelayModels } from "./model-cache.ts";
import { applyPiDefaults, axonThemeArguments } from "./settings-defaults.ts";
import { type PiSetupResult, preparePiSetup } from "./setup/index.ts";
import { inspectPiPackages } from "./setup/packages/doctor.ts";
import { createTelemetryOverrides } from "./telemetry-environment.ts";
import { resolvePiVersion } from "./version.ts";
import { createWebSearchOverrides } from "./web-search-environment.ts";

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
        PI_AXON_AUTH_RELAY_URL: undefined,
        PI_AXON_AUTH_RELAY_KEY: undefined,
      };
      let telemetryOverrides: EnvironmentOverrides = {};
      let webSearchOverrides: EnvironmentOverrides = {};
      if (setup.invocationKind !== "administrative") {
        let encryptedSession: string | undefined;
        try {
          encryptedSession = await loadEncryptedSession(context.paths);
        } catch {
          throw new LauncherError(
            "Saved Axon session could not be read safely",
            LAUNCHER_EXIT_STATUS.profileFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} auth login --browser.` },
          );
        }
        telemetryOverrides = createTelemetryOverrides(
          context.environment,
          undefined,
          setup.offline,
        );
        let webSearch: WebSearchConfig | undefined;
        // Pi defaults are independent of local telemetry and web-search switches.
        if (encryptedSession && !setup.offline) {
          const result = await fetchClientConfig(encryptedSession);
          // Persist rotation before passing the credential to the child. Config is
          // optional, so a failed local rotation must not prevent Pi launch.
          let telemetry = result.config?.telemetry;
          let piDefaults = result.config?.pi;
          webSearch = result.config?.webSearch;
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
            if (currentSession !== encryptedSession) {
              telemetry = undefined;
              piDefaults = undefined;
              webSearch = undefined;
            }
            encryptedSession = currentSession;
          } catch {
            // Do not persist preferences if we could not verify the current account.
            piDefaults = undefined;
            /* Preserve the previous credential; no token diagnostics. */
          }
          if (piDefaults !== undefined) {
            try {
              await applyPiDefaults(context.paths, piDefaults);
            } catch {
              // Optional defaults must not overwrite unsafe settings or block Pi launch.
              console.error(`${PRODUCT_IDENTITY.command}: could not apply managed Pi defaults`);
            }
          }
          telemetryOverrides = createTelemetryOverrides(context.environment, telemetry, false, {
            home: context.paths.home,
          });
          if (telemetry?.enabled) await initializeProductTelemetry(context.paths, telemetry);
        }
        // Pi receives only a per-launch loopback capability. The relay reads the
        // live session for each request and owns refresh persistence and recovery.
        relay = startAuthenticatedRequestRelay(context.paths);
        // Startup discovery seeds fresh models, but Pi restores its cached catalog over
        // them. Old per-launch relay URLs would then hide otherwise available models.
        // Keep the cache intact whenever the provider will not discover replacements.
        if (
          encryptedSession &&
          !setup.offline &&
          context.environment["PI_OFFLINE"] === undefined &&
          context.environment["LITELLM_OFFLINE"] !== "1" &&
          Number.parseInt(context.environment["LITELLM_DISCOVERY_TIMEOUT_MS"] ?? "", 10) !== 0
        ) {
          try {
            await invalidateStalePiRelayModels(context.paths, relay.origin);
          } catch {
            console.error(
              `${PRODUCT_IDENTITY.command}: could not clean the managed Pi model cache; run /litellm-refresh if models are unavailable`,
            );
          }
        }
        webSearchOverrides = createWebSearchOverrides(
          context.environment,
          relay,
          webSearch,
          setup.offline,
        );
        litellmOverrides = {
          LITELLM_API_KEY: relay.capability,
          LITELLM_BASE_URL: new URL("/litellm", relay.origin).toString(),
          PI_MODEL_RECOMMENDER_API_KEY: relay.capability,
          PI_MODEL_RECOMMENDER_URL: new URL(
            "/api/v1/model-recommendations",
            relay.origin,
          ).toString(),
          PI_AXON_AUTH_RELAY_URL: relay.origin,
          PI_AXON_AUTH_RELAY_KEY: relay.capability,
        };
      }
      const themeArguments =
        setup.invocationKind === "interactive"
          ? await axonThemeArguments(context.paths, context.cwd, userArguments)
          : [];
      return Object.freeze({
        executable: context.executable,
        arguments: [...resourceArguments, ...themeArguments, ...userArguments],
        environment: createPiEnvironment(
          context.environment,
          context.paths,
          litellmOverrides,
          telemetryOverrides,
          webSearchOverrides,
        ),
        cwd: context.cwd,
        ...(relay === undefined
          ? {}
          : {
              dispose: () => {
                relay.dispose();
                void closeProductTelemetry();
              },
            }),
      });
    },
    doctor: async (context) => [
      ...(await inspectPiRuntime(context)),
      ...(await inspectPiPackages(context)),
    ],
  };

  return Object.freeze(adapter);
}
