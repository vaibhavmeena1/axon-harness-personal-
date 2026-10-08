import { confirm, isCancel } from "@clack/prompts";
import { z } from "zod";
import { BUILD_INFO } from "../../build-info.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { SERVICE_ENDPOINTS } from "../../product/endpoints.ts";
import { resolveDeputyDevPaths } from "../../product/paths.ts";
import { BackupApi, BackupApiError } from "../../sessions/api.ts";
import { BACKUP_PRIVACY_NOTICE, SessionBackups } from "../../sessions/backup.ts";
import { assertPiAdapter, listSchema } from "../../sessions/contracts.ts";
import { restoreSession } from "../../sessions/restore.ts";

export async function runSessions(
  operation: "list" | "restore" | "enable" | "disable" | "status" | "delete" | "retry",
  id?: string,
  options: { cwd?: string; yes?: boolean; acceptSensitiveData?: boolean } = {},
): Promise<void> {
  const paths = resolveDeputyDevPaths();
  const api = new BackupApi(paths, BUILD_INFO.serviceOrigin);
  const backups = new SessionBackups(paths, api);
  try {
    if (operation === "retry") {
      const skipped = await backups.retry();
      console.log(
        "Compatible snapshots re-enabled for retry at the next lifecycle boundary; remote conflicts still require a fork" +
          (skipped
            ? `; ${skipped} local streams could not be repaired and remain paused (files retained)`
            : ""),
      );
      return;
    }
    if (operation === "status") {
      console.log(await backups.status());
      return;
    }
    if (operation === "disable") {
      await backups.disable();
      console.log("Session backups disabled; pending snapshots retained privately");
      return;
    }
    if (operation === "enable") {
      console.log(BACKUP_PRIVACY_NOTICE);
      if (!options.acceptSensitiveData) {
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          throw new Error("Use --accept-sensitive-data to explicitly opt in without a terminal");
        const accepted = await confirm({
          message: "Enable automatic sensitive session backups for the signed-in account?",
        });
        if (isCancel(accepted) || !accepted) return;
      }
      await backups.enable();
      console.log(
        "Session backups enabled; capture occurs only at lifecycle boundaries and explicit backup commands",
      );
      return;
    }
    await api.owner();
    if (operation === "list") {
      let path: string = SERVICE_ENDPOINTS.sessions.base;
      do {
        const page = listSchema.parse(await api.request(path));
        for (const session of page.sessions)
          console.log(
            `${session.id}\t${session.display_name === null ? "(untitled)" : JSON.stringify(session.display_name)}\t${session.harness}/${session.session_format}\t${session.last_backup_at}\t${session.snapshot?.raw_size_bytes ?? 0} bytes`,
          );
        path = page.next
          ? `${SERVICE_ENDPOINTS.sessions.base}?${new URLSearchParams(page.next).toString()}`
          : "";
      } while (path);
      return;
    }
    const sessionId = z.uuid().parse(id);
    if (operation === "delete") {
      if (!options.yes) {
        if (!process.stdin.isTTY) throw new Error("Deletion requires confirmation or --yes");
        const accepted = await confirm({
          message: "Delete this remote backup? Existing signed URLs expire within five minutes.",
        });
        if (isCancel(accepted) || !accepted) return;
      }
      await api.request(`${SERVICE_ENDPOINTS.sessions.base}/${sessionId}`, "DELETE");
      console.log("Remote session hidden; object cleanup is asynchronous");
      return;
    }
    if (!options.cwd) throw new Error("Restore requires --cwd pointing to an existing checkout");
    const restored = await restoreSession(api, sessionId, options.cwd, {
      inspect: async (session) => {
        const resume = assertPiAdapter(session);
        console.log(
          `Session: ${session.display_name === null ? "(untitled)" : JSON.stringify(session.display_name)}; latest backup: ${session.last_backup_at}; ${session.snapshot?.raw_size_bytes} bytes`,
        );
        if (!resume.leaf_known)
          console.log(
            "Warning: selected leaf unknown; Pi will use its normal last-entry selection",
          );
        console.log(
          "Restore creates a new conversation fork. Checkout files, credentials, external attachments and configuration are not restored; old tool calls are not replayed.",
        );
        if (options.yes) return true;
        if (!process.stdin.isTTY || !process.stdout.isTTY)
          throw new Error("Use --yes for an explicit non-interactive restore");
        const accepted = await confirm({
          message: "Download and restore this latest backup into a new local session?",
        });
        return !isCancel(accepted) && accepted;
      },
    });
    if (restored)
      console.log(
        `Restored new local session: ${restored}\nLaunch from your chosen checkout: ddcli pi --session ${JSON.stringify(restored)}`,
      );
  } catch (error) {
    throw new LauncherError(
      error instanceof BackupApiError
        ? `Session operation returned HTTP ${error.status}`
        : "Session operation failed safely",
      LAUNCHER_EXIT_STATUS.profileFailure,
      {
        remediation:
          "Check DeputyDev login, private storage, pinned Pi installation, consent and the existing --cwd checkout; then retry. No active session was overwritten.",
      },
    );
  }
}
