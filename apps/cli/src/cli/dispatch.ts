import { resolveHarnessRegistration } from "../harnesses/registry.ts";
import { LauncherError } from "../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../launcher/exit-status.ts";
import { launchRegisteredHarness } from "../launcher/launch-harness.ts";
import { resolveDeputyDevPaths } from "../product/paths.ts";
import { runBackgroundUpdate } from "../updater/update.ts";
import { runPiSessionPreflight } from "./auth/preflight.ts";
import { runLauncherProgram } from "./launcher-program.ts";

export async function dispatch(argumentsVector: readonly string[]): Promise<void> {
  const [head, ...harnessArguments] = argumentsVector;
  if (head === "__background-update") {
    await runBackgroundUpdate();
    return;
  }
  const registration = head === undefined ? undefined : resolveHarnessRegistration(head);

  if (registration !== undefined) {
    if (registration.id === "pi" && harnessArguments[0] === "update") {
      throw new LauncherError(
        "ddcli pi update is disabled: DeputyDev pins its own Pi executable",
        LAUNCHER_EXIT_STATUS.usage,
        {
          remediation:
            "Upgrade ddcli for a reviewed Pi version change; use pi directly for your separate global installation.",
        },
      );
    }
    await runPiSessionPreflight(resolveDeputyDevPaths(), harnessArguments, process.env);
    await launchRegisteredHarness(registration, harnessArguments);
    return;
  }

  await runLauncherProgram(argumentsVector);
}
