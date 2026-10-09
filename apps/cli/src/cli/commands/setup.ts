import { synchronizePiMcpConfig } from "../../harnesses/pi/setup/mcp-config.ts";
import { synchronizePiPackages } from "../../harnesses/pi/setup/packages/sync.ts";
import { materializePiResources } from "../../harnesses/pi/setup/resources.ts";
import { loadHarnessAdapter, resolveHarnessRegistration } from "../../harnesses/registry.ts";
import type { HarnessLaunchContext, LaunchContext } from "../../launcher/contracts.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { resolveExecutablePath } from "../../launcher/executable.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { PRODUCT_IDENTITY } from "../../product/identity.ts";
import { AXON_MANIFEST, EMBEDDED_PI_RESOURCES } from "../../product/manifest.ts";
import { resolveAxonPaths } from "../../product/paths.ts";

export interface SetupOptions {
  readonly syncPackages?: boolean;
}

export async function runSetup(
  harnessToken: string,
  options: SetupOptions,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<void> {
  if (options.syncPackages !== true) {
    throw new LauncherError("setup requires an explicit operation", LAUNCHER_EXIT_STATUS.usage, {
      remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.`,
    });
  }

  const registration = resolveHarnessRegistration(harnessToken);
  if (registration?.id !== "pi") {
    throw new LauncherError(
      `setup currently supports only pi, received: ${harnessToken}`,
      LAUNCHER_EXIT_STATUS.usage,
      { remediation: `Run ${PRODUCT_IDENTITY.command} setup pi --sync-packages.` },
    );
  }

  const launchContext: LaunchContext = Object.freeze({
    cwd,
    environment,
    paths: resolveAxonPaths(environment),
  });
  const adapter = await loadHarnessAdapter(registration.id);
  // Explicit setup installs the isolated exact-version Pi runtime when absent.
  const executable =
    adapter.resolveExecutable === undefined
      ? (await resolveExecutablePath(registration, environment, cwd)).path
      : await adapter.resolveExecutable(launchContext, registration, {
          userArguments: [],
          allowInstall: true,
        });
  const context: HarnessLaunchContext = Object.freeze({
    ...launchContext,
    executable,
    registration,
  });

  const resources = await materializePiResources(context.paths, EMBEDDED_PI_RESOURCES);
  const packages = await synchronizePiPackages({
    allowInstall: true,
    context,
    manifest: AXON_MANIFEST,
  });
  const mcp = await synchronizePiMcpConfig({
    environment,
    force: true,
    stampPath: context.paths.piMcpSyncState,
  });

  for (const warning of packages.warnings) {
    console.error(`${PRODUCT_IDENTITY.command}: pi package warning: ${warning}`);
  }
  if (mcp.warning !== undefined) {
    console.error(`${PRODUCT_IDENTITY.command}: pi mcp warning: ${mcp.warning}`);
  }
  console.log(`Pi executable: ${executable}`);
  console.log(`Pi resources ready: ${resources.runtimeDirectory}`);
  console.log(
    packages.packages.length === 0
      ? "Pi required packages: none configured"
      : `Pi required packages ready: ${packages.packages.length}`,
  );
  console.log(
    `Pi MCP defaults: ${mcp.status}${
      mcp.addedServers.length === 0 ? "" : ` (added ${mcp.addedServers.join(", ")})`
    }; ${mcp.configPath}`,
  );
}
