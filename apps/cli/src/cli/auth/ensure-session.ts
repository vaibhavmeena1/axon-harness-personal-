import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { loadEncryptedSession } from "./session.ts";
import { verifyEncryptedSession } from "./verification.ts";

export async function ensureAuthenticatedSession(
  paths: DeputyDevPaths,
  options: { readonly offline?: boolean; readonly interactive?: boolean } = {},
): Promise<boolean> {
  let encryptedSession: string | undefined;
  try {
    encryptedSession = await loadEncryptedSession(paths);
  } catch {
    console.error("Your saved DeputyDev session could not be read safely.");
  }

  if (encryptedSession !== undefined) {
    // Offline sessions may use saved state, but must never contact the auth service.
    if (options.offline) return true;
    const status = await verifyEncryptedSession(encryptedSession);
    if (status === "VERIFIED") return true;
    console.error(
      status === "EXPIRED"
        ? "Your DeputyDev session has expired."
        : "Your DeputyDev session is invalid.",
    );
  } else {
    console.error("Sign in to DeputyDev to continue.");
  }

  if (
    options.offline ||
    options.interactive === false ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  ) {
    throw new LauncherError("DeputyDev login is required", LAUNCHER_EXIT_STATUS.profileFailure, {
      remediation: "Login from browser: run ddcli auth login --browser in a terminal.",
    });
  }

  // runAuthLogin presents a choice; it never opens a browser until selected.
  if (!(await runAuthLogin(paths, {}))) return false;
  const savedSession = await loadEncryptedSession(paths);
  if (savedSession !== undefined && (await verifyEncryptedSession(savedSession)) === "VERIFIED") {
    return true;
  }
  throw new LauncherError(
    "The browser session could not be verified",
    LAUNCHER_EXIT_STATUS.profileFailure,
    { remediation: "Run ddcli auth login and choose Login from browser to retry." },
  );
}
