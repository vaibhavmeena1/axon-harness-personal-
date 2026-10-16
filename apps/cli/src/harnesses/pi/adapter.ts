import {
  type AuthenticatedRequestRelay,
  startAuthenticatedRequestRelay,
} from "../../cli/auth/request-relay.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../../cli/auth/session.ts";
import { type ClientConfig, fetchClientConfig } from "../../cli/client-config.ts";
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
import {
  createCompactionOverrides,
  createLiteLLMClientOverrides,
  createModelRecommenderOverrides,
} from "./launch-preferences-environment.ts";
import { invalidateStalePiRelayModels } from "./model-cache.ts";
import {
  applyPiDefaults,
  applyPiProviderDefaults,
  axonThemeArguments,
} from "./settings-defaults.ts";
import { type PiSetupResult, preparePiSetup } from "./setup/index.ts";
import { inspectPiPackages } from "./setup/packages/doctor.ts";
import { createTelemetryOverrides } from "./telemetry-environment.ts";
import { createTerminalPermissionsOverrides } from "./terminal-permissions-environment.ts";
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
        PI_AXON_CONFIG_REFRESH_ENABLED: undefined,
      };
      let telemetryOverrides: EnvironmentOverrides = {};
      let webSearchOverrides: EnvironmentOverrides = {};
      let terminalPermissionsOverrides = createTerminalPermissionsOverrides();
      let featureOverrides: EnvironmentOverrides = {};
      if (setup.invocationKind !== "administrative") {
        try {
          await applyPiProviderDefaults(context.paths);
        } catch {
          throw new LauncherError(
            "Could not prepare DeputyDev's LiteLLM provider safely",
            LAUNCHER_EXIT_STATUS.profileFailure,
            { remediation: `Run ${PRODUCT_IDENTITY.command} doctor pi.` },
          );
        }
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
        let config: ClientConfig | undefined;
        // All startup preferences share this one bounded fetch, regardless of local switches.
        if (encryptedSession && !setup.offline) {
          const result = await fetchClientConfig(encryptedSession, {
            // Startup precedes the TUI, so this is the one place stderr diagnostics are safe.
            onInvalidSection: (section) =>
              console.error(
                `${PRODUCT_IDENTITY.command}: ignored invalid client config section: ${section}`,
              ),
          });
          // Persist rotation before passing the credential to the child. Config is
          // optional, so a failed local rotation must not prevent Pi launch.
          config = result.config;
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
              config = undefined;
            }
            encryptedSession = currentSession;
          } catch {
            // An unverifiable account invalidates every fetched preference, not just disk defaults.
            config = undefined;
            /* Preserve the previous credential; no token diagnostics. */
          }
          if (config?.pi !== undefined) {
            try {
              const expectedSession = encryptedSession;
              await applyPiDefaults(context.paths, config.pi, {
                // Recheck the account after waiting for the shared settings lock, as on reload.
                beforeWrite: async () => {
                  if ((await loadEncryptedSession(context.paths)) !== expectedSession) {
                    throw new Error("Pi defaults account changed during startup");
                  }
                },
              });
            } catch {
              // Optional defaults must not overwrite unsafe settings or block Pi launch.
              console.error(`${PRODUCT_IDENTITY.command}: could not apply managed Pi defaults`);
            }
            // Optional disk-write failure must not erase valid environment preferences,
            // but an account switch/read failure while waiting for that write must.
            try {
              const currentSession = await loadEncryptedSession(context.paths);
              if (currentSession !== encryptedSession) config = undefined;
              encryptedSession = currentSession;
            } catch {
              config = undefined;
            }
          }
        }
        telemetryOverrides = createTelemetryOverrides(
          context.environment,
          config?.telemetry,
          setup.offline,
          { home: context.paths.home },
        );
        await initializeProductTelemetry(context.paths, undefined, {
          decision: { offline: setup.offline, policy: config?.telemetry },
        });
        featureOverrides = {
          ...createCompactionOverrides(config?.compaction),
          ...createModelRecommenderOverrides(config?.modelRecommender),
          ...createLiteLLMClientOverrides(config?.litellmClient),
        };
        const effectiveProviderEnvironment = { ...context.environment, ...featureOverrides };
        // Pi receives only a per-launch loopback capability. The relay reads the
        // live session for each request and owns refresh persistence and recovery.
        relay = startAuthenticatedRequestRelay(context.paths, {
          allowPiConfigRefresh: !setup.offline,
        });
        // Startup discovery seeds fresh models, but Pi restores its cached catalog over
        // them. Old per-launch relay URLs would then hide otherwise available models.
        // Keep the cache intact whenever the provider will not discover replacements.
        if (
          encryptedSession &&
          !setup.offline &&
          effectiveProviderEnvironment["PI_OFFLINE"] === undefined &&
          effectiveProviderEnvironment["LITELLM_OFFLINE"] !== "1" &&
          Number.parseInt(
            effectiveProviderEnvironment["LITELLM_DISCOVERY_TIMEOUT_MS"] ?? "",
            10,
          ) !== 0
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
          config?.webSearch,
          setup.offline,
        );
        terminalPermissionsOverrides = createTerminalPermissionsOverrides(
          config?.terminalPermissions,
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
          PI_AXON_CONFIG_REFRESH_ENABLED: String(!setup.offline),
        };
      } else {
        // Administration is exempt even if spawning it produces startup observations.
        // Remember resolved absence so command teardown cannot initiate a config fetch.
        await initializeProductTelemetry(context.paths, undefined, {
          decision: { offline: setup.offline },
        });
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
          terminalPermissionsOverrides,
          featureOverrides,
        ),
        cwd: context.cwd,
        offline: setup.offline,
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
