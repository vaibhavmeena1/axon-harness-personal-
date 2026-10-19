import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import type { AxonPaths } from "../../product/paths.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { loadEncryptedSession } from "./session.ts";
import { verifyEncryptedSession } from "./verification.ts";

export async function ensureAuthenticatedSession(
  paths: AxonPaths,
  options: { readonly offline?: boolean; readonly interactive?: boolean } = {},
): Promise<boolean> {
  // A saved token alone is not proof of access. Offline mode cannot bypass verification.
  if (options.offline) {
    throw new LauncherError(
      "Cannot verify your Axon session while offline",
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation: "Run axon or axon pi while online to verify your session before starting Pi.",
      },
    );
  }

  let encryptedSession: string | undefined;
  try {
    encryptedSession = await loadEncryptedSession(paths);
  } catch {
    console.error("Your saved Axon session could not be read safely.");
  }

  if (encryptedSession !== undefined) {
    const status = await verifyEncryptedSession(encryptedSession, paths);
    if (status === "VERIFIED") return true;
    console.error(
      status === "EXPIRED" ? "Your Axon session has expired." : "Your Axon session is invalid.",
    );
  } else {
    console.error("Sign in to Axon to continue.");
  }

  if (options.interactive === false || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new LauncherError("Axon login is required", LAUNCHER_EXIT_STATUS.profileFailure, {
      remediation: "Login from browser: run axon auth login --browser in a terminal.",
    });
  }

  // runAuthLogin presents a choice; it never opens a browser until selected.
  if (!(await runAuthLogin(paths, {}))) return false;
  const savedSession = await loadEncryptedSession(paths);
  if (
    savedSession !== undefined &&
    (await verifyEncryptedSession(savedSession, paths)) === "VERIFIED"
  ) {
    return true;
  }
  throw new LauncherError(
    "The browser session could not be verified",
    LAUNCHER_EXIT_STATUS.profileFailure,
    { remediation: "Run axon auth login and choose Login from browser to retry." },
  );
}
