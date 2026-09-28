import { resolveHarnessRegistration } from "../harnesses/registry.ts";
import { launchRegisteredHarness } from "../launcher/launch-harness.ts";
import { runBackgroundUpdate } from "../updater/update.ts";
import { runLauncherProgram } from "./launcher-program.ts";

export async function dispatch(argumentsVector: readonly string[]): Promise<void> {
  const [head, ...harnessArguments] = argumentsVector;
  if (head === "__background-update") {
    await runBackgroundUpdate();
    return;
  }
  const registration = head === undefined ? undefined : resolveHarnessRegistration(head);

  if (registration !== undefined) {
    await launchRegisteredHarness(registration, harnessArguments);
    return;
  }

  await runLauncherProgram(argumentsVector);
}
