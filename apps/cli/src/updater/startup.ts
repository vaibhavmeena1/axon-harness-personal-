import { BUILD_INFO } from "../build-info.ts";
import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  type PiInvocationEnvironment,
} from "../harnesses/pi/setup/packages/invocation.ts";
import { spawnHarness } from "../launcher/spawn-harness.ts";
import { installUpdate, type UpdateContext, updateContext } from "./update.ts";

interface StartupUpdateOptions {
  readonly context?: UpdateContext;
  readonly environment?: NodeJS.ProcessEnv;
  readonly invocation?: PiInvocationEnvironment;
  readonly restart?: (context: UpdateContext, argumentsVector: readonly string[]) => Promise<void>;
  readonly warn?: (message: string) => void;
}

/** Check every eligible launch, independently of the old background-check throttle. */
export async function runStartupUpdate(
  argumentsVector: readonly string[],
  options: StartupUpdateOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const invocation = options.invocation ?? currentPiInvocationEnvironment(environment);
  const build = options.context?.build ?? BUILD_INFO;
  if (
    build.kind !== "binary" ||
    build.target !== "darwin-arm64" ||
    environment["AXON_NO_UPDATE"] === "1" ||
    classifyPiInvocation(argumentsVector, invocation) !== "interactive" ||
    isPiOffline(environment, argumentsVector)
  ) {
    return;
  }

  const context = options.context ?? updateContext();
  const warn = options.warn ?? console.error;
  try {
    // Metadata must fail quickly on an unavailable service. Downloads retain their
    // longer timeout and all existing checksum/signature/managed-path checks.
    const installed = await installUpdate({
      ...context,
      client: { ...context.client, metadataTimeoutMs: 3_000 },
    });
    if (!installed) return;
    warn(`axon: updated to ${installed}; continuing with the new version.`);
  } catch {
    warn(
      "axon: could not check for or install updates; continuing with the current version. Retry with axon update.",
    );
    return;
  }

  try {
    const restart = options.restart ?? restartUpdatedLauncher;
    await restart(context, ["pi", ...argumentsVector]);
  } catch {
    warn(
      "axon: could not start the updated launcher; continuing with the current version. Restart axon to retry.",
    );
  }
}

async function restartUpdatedLauncher(
  context: UpdateContext,
  argumentsVector: readonly string[],
): Promise<void> {
  // Reuse inherited stdio/cwd, signal forwarding, and child exit propagation.
  // The new launcher compares its own embedded version with latest, so it does
  // not recurse for the release we just installed. No persistent bypass flag.
  await spawnHarness({
    executable: context.paths.managedBinary,
    arguments: argumentsVector,
    cwd: process.cwd(),
    environment: process.env,
  });
}
