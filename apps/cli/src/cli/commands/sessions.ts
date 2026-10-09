import { confirm, isCancel, spinner } from "@clack/prompts";
import { z } from "zod";
import { BUILD_INFO } from "../../build-info.ts";
import { currentPiInvocationEnvironment } from "../../harnesses/pi/setup/packages/invocation.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { SERVICE_ENDPOINTS } from "../../product/endpoints.ts";
import { resolveAxonPaths } from "../../product/paths.ts";
import { BackupApi, BackupApiError } from "../../sessions/api.ts";
import { SessionBackups } from "../../sessions/backup.ts";
import { assertPiAdapter, listSchema, type RemoteSession } from "../../sessions/contracts.ts";
import { formatBackupTime, formatSessionList, formatSnapshotSize } from "../../sessions/display.ts";
import { restoreSession } from "../../sessions/restore.ts";
import { ensureAxonSession } from "../auth/preflight.ts";
import { runSessionMenu } from "./sessions-menu.ts";

export type SessionOperation = "list" | "restore" | "status" | "delete" | "retry";
export interface SessionOptions {
  cwd?: string;
  yes?: boolean;
  /** Share the menu's prompt/cancellation handling without skipping confirmation. */
  confirm?: typeof confirm;
}

function sessionFailure(error: unknown): LauncherError {
  if (error instanceof LauncherError) return error;
  return new LauncherError(
    error instanceof BackupApiError
      ? `Session operation returned HTTP ${error.status}`
      : "Session operation failed safely",
    LAUNCHER_EXIT_STATUS.profileFailure,
    {
      remediation:
        "Check Axon login, private storage, pinned Pi installation, administrator backup policy and the existing --cwd checkout; then retry. No active session was overwritten.",
    },
  );
}

async function listRemoteSessions(api: BackupApi): Promise<RemoteSession[]> {
  await api.owner();
  const sessions: RemoteSession[] = [];
  let path: string = SERVICE_ENDPOINTS.sessions.base;
  do {
    const page = listSchema.parse(await api.request(path));
    sessions.push(...page.sessions);
    path = page.next
      ? `${SERVICE_ENDPOINTS.sessions.base}?${new URLSearchParams(page.next).toString()}`
      : "";
  } while (path);
  return sessions;
}

export async function runSessionsInteractive(): Promise<void> {
  const invocation = currentPiInvocationEnvironment();
  if (invocation.ci || !invocation.stdinIsTty || !invocation.stdoutIsTty) {
    throw new LauncherError(
      "Interactive session management requires a terminal",
      LAUNCHER_EXIT_STATUS.usage,
      {
        remediation:
          "Run axon sessions in a terminal, or use sessions list/status/retry/restore/delete for scripts.",
      },
    );
  }
  const paths = resolveAxonPaths();
  await ensureAxonSession(paths, { interactive: true });
  const api = new BackupApi(paths, BUILD_INFO.serviceOrigin);
  try {
    await runSessionMenu({
      list: async () => {
        const loading = spinner();
        loading.start("Loading your backed-up sessions");
        try {
          const sessions = await listRemoteSessions(api);
          loading.stop(`${sessions.length} backed-up session${sessions.length === 1 ? "" : "s"}`);
          return sessions;
        } catch (error) {
          loading.error("Could not load session backups");
          throw error;
        }
      },
      run: runSessions,
    });
  } catch (error) {
    throw sessionFailure(error);
  }
}

export async function runSessions(
  operation: SessionOperation,
  id?: string,
  options: SessionOptions = {},
): Promise<void> {
  const paths = resolveAxonPaths();
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
    if (operation === "list") {
      console.log(
        formatSessionList(await listRemoteSessions(api), { columns: process.stdout.columns }),
      );
      return;
    }
    await api.owner();
    const sessionId = z.uuid().parse(id);
    if (operation === "delete") {
      if (!options.yes) {
        if (!process.stdin.isTTY) throw new Error("Deletion requires confirmation or --yes");
        const accepted = await (options.confirm ?? confirm)({
          message: "Delete this remote backup? Existing signed URLs expire within five minutes.",
          initialValue: false,
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
          `Session: ${session.display_name ?? "(no title)"}; latest backup: ${formatBackupTime(session.last_backup_at)}; ${formatSnapshotSize(session.snapshot?.raw_size_bytes)}`,
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
        const accepted = await (options.confirm ?? confirm)({
          message: "Download and restore this latest backup into a new local session?",
          initialValue: false,
        });
        return !isCancel(accepted) && accepted;
      },
    });
    if (restored)
      console.log(
        `Restored new local session: ${restored}\nLaunch from your chosen checkout: axon pi --session ${JSON.stringify(restored)}`,
      );
  } catch (error) {
    throw sessionFailure(error);
  }
}
