import { intro, isCancel, outro, select } from "@clack/prompts";

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
import { runBackgroundUpdate } from "../updater/update.ts";
import { ensureAuthenticatedSession } from "./auth/ensure-session.ts";
import { runLauncherProgram } from "./launcher-program.ts";

async function runInteractiveLauncher(): Promise<void> {
  const invocationEnvironment = currentPiInvocationEnvironment();
  if (
    invocationEnvironment.ci ||
    !invocationEnvironment.stdinIsTty ||
    !invocationEnvironment.stdoutIsTty
  ) {
    // Scripts get usage instead of an interactive prompt or an implicit Pi launch.
    await runLauncherProgram([]);
    return;
  }

  intro(PRODUCT_IDENTITY.displayName);
  if (
    !(await ensureAuthenticatedSession(resolveDeputyDevPaths(), {
      offline: isPiOffline(process.env, []),
      interactive: true,
    }))
  ) {
    outro("Login cancelled.");
    return;
  }

  const selectedHarness = await select({
    message: "What would you like to run?",
    options: [{ value: "pi", label: "Pi", hint: "Start the DeputyDev-managed coding agent" }],
  });
  if (isCancel(selectedHarness)) {
    outro("Cancelled.");
    return;
  }

  outro("Starting Pi...");
  // Recheck the live session after selection: it may change while the menu is open.
  await dispatch([selectedHarness]);
}

export async function dispatch(argumentsVector: readonly string[]): Promise<void> {
  const [head, ...harnessArguments] = argumentsVector;
  if (head === undefined) {
    await runInteractiveLauncher();
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

  // Launcher help and explicit auth commands do not require the interactive home menu.
  // Help, updates, diagnostics, and explicit auth commands remain usable while signed out.
  if (head === undefined && !(await ensureAuthenticatedSession(resolveAxonPaths()))) {
    return;
  }
  await runLauncherProgram(argumentsVector);
}
