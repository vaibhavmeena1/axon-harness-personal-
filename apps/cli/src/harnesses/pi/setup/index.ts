import type { HarnessLaunchContext } from "../../../launcher/contracts.ts";
import { isTrue } from "../../../launcher/debug-preview.ts";
import { LauncherError } from "../../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../../product/identity.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../../product/manifest.ts";
import { synchronizePiMcpConfig } from "./mcp-config.ts";
import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  type PiInvocationKind,
} from "./packages/invocation.ts";
import { synchronizePiPackages } from "./packages/sync.ts";
import { materializePiResources, type PiResourceMaterializationResult } from "./resources.ts";

const DEBUG_ENVIRONMENT_VARIABLE = "AXON_DEBUG";

export interface PiSetupResult {
  readonly invocationKind: PiInvocationKind;
  readonly offline: boolean;
  /** Present for every non-administrative launch. */
  readonly materialization?: PiResourceMaterializationResult;
}

interface PiSetupCheckResult {
  readonly summary: string;
  readonly warning?: string;
}

interface PiSetupCheck {
  readonly id: string;
  run(context: HarnessLaunchContext): Promise<PiSetupCheckResult>;
}

// Best-effort organization defaults. They run only for interactive, online
// launches so scripted, piped, CI, and offline sessions never wait on the network.
const PI_INTERACTIVE_SETUP_CHECKS: readonly PiSetupCheck[] = Object.freeze([
  {
    id: "mcp-config",
    async run(context) {
      const syncResult = await synchronizePiMcpConfig({
        environment: context.environment,
        stampPath: context.paths.piMcpSyncState,
      });
      const added =
        syncResult.addedServers.length === 0
          ? "no organization MCP servers added"
          : `added disabled MCP servers: ${syncResult.addedServers.join(", ")}`;

      return {
        summary: `${syncResult.status}; ${added}; path ${syncResult.configPath}`,
        ...(syncResult.warning === undefined ? {} : { warning: syncResult.warning }),
      };
    },
  },
]);

function printDebugResult(check: PiSetupCheck, result: PiSetupCheckResult): void {
  console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id}: ${result.summary}`);
  if (result.warning !== undefined) {
    console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id} warning: ${result.warning}`);
  }
}

async function prepareRequiredResources(
  context: HarnessLaunchContext,
  allowInstall: boolean,
  debug: boolean,
): Promise<PiResourceMaterializationResult> {
  try {
    const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
    const packages = await synchronizePiPackages({
      allowInstall,
      context,
      manifest: AXON_MANIFEST,
    });
    for (const warning of packages.warnings) {
      console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
    }
    if (debug) {
      console.error(
        `${PRODUCT_IDENTITY.command}: pi resources: ${resources.runtimeDirectory}; packages: ${packages.manifestHash}`,
      );
    }
    return resources;
  } catch (error) {
    if (error instanceof LauncherError) {
      throw error;
    }
    throw new LauncherError(
      "failed to prepare required Pi resources",
      LAUNCHER_EXIT_STATUS.materializationFailure,
      {
        cause: error,
        remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
      },
    );
  }
}

export async function preparePiSetup(
  context: HarnessLaunchContext,
  userArguments: readonly string[],
): Promise<PiSetupResult> {
  const debug = isTrue(context.environment[DEBUG_ENVIRONMENT_VARIABLE]);
  const invocationKind = classifyPiInvocation(
    userArguments,
    currentPiInvocationEnvironment(context.environment),
  );
  const offline = isPiOffline(context.environment, userArguments);

  if (invocationKind === "administrative") {
    return { invocationKind, offline };
  }

  const materialization = await prepareRequiredResources(
    context,
    invocationKind === "interactive" && !offline,
    debug,
  );

  if (invocationKind === "interactive" && !offline) {
    for (const check of PI_INTERACTIVE_SETUP_CHECKS) {
      try {
        const checkResult = await check.run(context);
        if (debug) {
          printDebugResult(check, checkResult);
        }
      } catch (error) {
        // Organization defaults are additive convenience configuration. A setup
        // check must never prevent Pi from starting or risk replacing user data.
        if (debug) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`${PRODUCT_IDENTITY.command}: pi setup ${check.id} failed: ${message}`);
        }
      }
    }
  } else if (debug) {
    console.error(
      `${PRODUCT_IDENTITY.command}: pi setup checks skipped (${offline ? "offline" : invocationKind})`,
    );
  }

  return { invocationKind, offline, materialization };
}
