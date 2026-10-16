import { intro } from "@clack/prompts";

import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
} from "../harnesses/pi/setup/packages/invocation.ts";
import { resolveHarnessRegistration } from "../harnesses/registry.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { launchRegisteredHarness } from "../launcher/launch-harness.ts";
import { PRODUCT_IDENTITY } from "../product/identity.ts";
import { resolveAxonPaths } from "../product/paths.ts";
import { runStartupUpdate } from "../updater/startup.ts";
import { runBackgroundUpdate } from "../updater/update.ts";
import { ensureAuthenticatedSession } from "./auth/ensure-session.ts";
import { runLauncherProgram } from "./launcher-program.ts";

async function runDefaultHarness(): Promise<void> {
  const invocationEnvironment = currentPiInvocationEnvironment();
  if (
    !invocationEnvironment.ci &&
    invocationEnvironment.stdinIsTty &&
    invocationEnvironment.stdoutIsTty
  ) {
    intro(PRODUCT_IDENTITY.displayName);
  }

  // Bare axon and axon pi share one verification and browser-login path.
  // Noninteractive runs still validate, but never prompt for browser login.
  await dispatch(["pi"]);
}

export async function dispatch(argumentsVector: readonly string[]): Promise<void> {
  const [head, ...harnessArguments] = argumentsVector;
  if (head === undefined) {
    await runDefaultHarness();
    return;
  }
  if (head === "__background-update") {
    await runBackgroundUpdate();
    return;
  }
  const registration = resolveHarnessRegistration(head);

  if (registration !== undefined) {
    if (registration.id === "pi" && harnessArguments[0] === "update") {
      throw new LauncherError(
        "axon pi update is disabled: Axon pins its own Pi executable",
        LAUNCHER_EXIT_STATUS.usage,
        {
          remediation:
            "Upgrade axon for a reviewed Pi version change; use pi directly for your separate global installation.",
        },
      );
    }
    await runStartupUpdate(harnessArguments);
    const paths = resolveAxonPaths();
    const invocationKind = classifyPiInvocation(harnessArguments);
    // No Pi command may resolve, install, or launch its executable before verification.
    if (
      !(await ensureAuthenticatedSession(paths, {
        offline: isPiOffline(process.env, harnessArguments),
        interactive: invocationKind === "interactive",
      }))
    ) {
      return;
    }
    await launchRegisteredHarness(registration, harnessArguments);
    return;
  }

  // Launcher commands retain their own authentication and usage handling.
  await runLauncherProgram(argumentsVector);
}
