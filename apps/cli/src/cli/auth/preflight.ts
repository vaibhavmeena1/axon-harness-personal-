import {
  classifyPiInvocation,
  currentPiInvocationEnvironment,
  isPiOffline,
  type PiInvocationEnvironment,
} from "../../harnesses/pi/setup/packages/invocation.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { loadEncryptedSession } from "./session.ts";

export interface SessionPreflightOptions {
  readonly interactive: boolean;
  readonly offline?: boolean;
  readonly loadSession?: typeof loadEncryptedSession;
  readonly login?: typeof runAuthLogin;
}

/** Local completion check only: API requests still validate the saved credential. */
export async function ensureDeputyDevSession(
  paths: DeputyDevPaths,
  options: SessionPreflightOptions,
): Promise<void> {
  const loadSession = options.loadSession ?? loadEncryptedSession;
  async function readSession(): Promise<string | undefined> {
    try {
      return await loadSession(paths);
    } catch {
      throw new LauncherError(
        "Saved DeputyDev session could not be read safely",
        LAUNCHER_EXIT_STATUS.profileFailure,
      );
    }
  }
  if (await readSession()) return;

  if (!options.interactive || options.offline) {
    throw new LauncherError(
      "DeputyDev login is required before running this command",
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: "Run ddcli auth login in an interactive terminal while online, then retry." },
    );
  }

  await (options.login ?? runAuthLogin)(paths, {});
  // Cancellation must not continue the command or provision Pi without a session.
  if (!(await readSession())) {
    throw new LauncherError(
      "DeputyDev login was not completed",
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: "Run ddcli auth login, then retry." },
    );
  }
}

export async function runPiSessionPreflight(
  paths: DeputyDevPaths,
  argumentsVector: readonly string[],
  environment: NodeJS.ProcessEnv,
  invocationEnvironment: PiInvocationEnvironment = currentPiInvocationEnvironment(environment),
): Promise<void> {
  const kind = classifyPiInvocation(argumentsVector, invocationEnvironment);
  if (kind === "administrative") return;
  await ensureDeputyDevSession(paths, {
    interactive: kind === "interactive",
    offline: isPiOffline(environment, argumentsVector),
  });
}
