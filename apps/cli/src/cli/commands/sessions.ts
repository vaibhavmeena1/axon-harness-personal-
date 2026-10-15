import { resolve } from "node:path";
import * as prompts from "@clack/prompts";
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
import {
  formatBackupTime,
  formatHomePath,
  formatSessionList,
  formatSessionTitle,
  formatSnapshotSize,
} from "../../sessions/display.ts";
import { restoreSession } from "../../sessions/restore.ts";
import { ensureAxonSession } from "../auth/preflight.ts";
import { runSessionMenu } from "./sessions-menu.ts";

export type SessionOperation = "list" | "restore" | "status" | "delete" | "retry";
/** Prompts the guided menu shares; without them, commands print plain lines for scripts. */
export type SessionCommandUI = Pick<typeof prompts, "confirm" | "note" | "spinner">;
export interface SessionOptions {
  cwd?: string;
  yes?: boolean;
  ui?: SessionCommandUI;
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
        const loading = prompts.spinner();
        loading.start("Loading backups");
        try {
          const sessions = await listRemoteSessions(api);
          loading.stop(`${sessions.length} backup${sessions.length === 1 ? "" : "s"} found`);
          return sessions;
        } catch (error) {
          loading.error("Could not load backups");
          throw error;
        }
      },
      run: runSessions,
    });
  } catch (error) {
    throw sessionFailure(error);
  }
}

function resumeCommands(checkout: string, sessionFile: string): [string, string] {
  return [`cd ${JSON.stringify(checkout)}`, `axon pi --session ${JSON.stringify(sessionFile)}`];
}

export async function runSessions(
  operation: SessionOperation,
  id?: string,
  options: SessionOptions = {},
): Promise<void> {
  const { ui } = options;
  const print = (message: string, title: string) =>
    ui ? ui.note(message, title) : console.log(message);
  const confirm = ui?.confirm ?? prompts.confirm;
  const paths = resolveAxonPaths();
  const api = new BackupApi(paths, BUILD_INFO.serviceOrigin);
  const backups = new SessionBackups(paths, api);
  try {
    if (operation === "retry") {
      const skipped = await backups.retry();
      print(
        "Compatible snapshots will retry at the next backup boundary; remote conflicts still require a fork." +
          (skipped
            ? `\n${skipped} local stream${skipped === 1 ? "" : "s"} could not be repaired and stay paused (files kept).`
            : ""),
        "Retry",
      );
      return;
    }
    if (operation === "status") {
      print(await backups.status(), "Backup status");
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
        const accepted = await confirm({
          message:
            "Delete this backup? Local sessions are kept; issued download links expire within 5 minutes.",
          initialValue: false,
        });
        if (accepted !== true) return;
      }
      await api.request(`${SERVICE_ENDPOINTS.sessions.base}/${sessionId}`, "DELETE");
      print("Backup deleted; storage cleanup finishes in the background.", "Deleted");
      return;
    }
    if (!options.cwd) throw new Error("Restore requires --cwd pointing to an existing checkout");
    const checkout = resolve(options.cwd);
    const progress = ui?.spinner();
    let restored: string | undefined;
    try {
      restored = await restoreSession(api, sessionId, checkout, {
        inspect: async (session) => {
          print(restoreSummary(session, checkout), "Restore");
          if (options.yes) return true;
          if (!process.stdin.isTTY || !process.stdout.isTTY)
            throw new Error("Use --yes for an explicit non-interactive restore");
          const accepted = await confirm({ message: "Restore this session?", initialValue: false });
          if (accepted === true) progress?.start("Downloading and verifying backup");
          return accepted === true;
        },
      });
    } catch (error) {
      progress?.error("Restore failed");
      throw error;
    }
    if (!restored) return;
    progress?.stop("Restored as a new local session");
    const resume = resumeCommands(checkout, restored);
    if (ui) ui.note(resume.join("\n"), "Resume it with");
    else
      console.log(
        `Restored as a new local session: ${restored}\nResume it with: ${resume.join(" && ")}`,
      );
  } catch (error) {
    throw sessionFailure(error);
  }
}

function restoreSummary(session: RemoteSession, checkout: string): string {
  const resume = assertPiAdapter(session);
  return [
    formatSessionTitle(session),
    `Last backup  ${formatBackupTime(session.last_backup_at)} · ${formatSnapshotSize(session.snapshot?.raw_size_bytes)}`,
    `Checkout     ${formatHomePath(checkout)}`,
    "",
    "Only the conversation is restored, as a new session.",
    "Files, credentials, attachments and config are not; tool calls are not re-run.",
    ...(resume.leaf_known
      ? []
      : ["", "The active branch is unknown, so Pi will resume from the latest entry."]),
  ].join("\n");
}
