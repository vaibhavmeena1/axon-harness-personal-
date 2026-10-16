import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as prompts from "@clack/prompts";

import type { RemoteSession } from "../../sessions/contracts.ts";
import {
  formatHomePath,
  formatLocalBackupTime,
  formatSessionTitle,
  formatSnapshotSize,
} from "../../sessions/display.ts";
import type { runSessions } from "./sessions.ts";

type MenuAction = "restore" | "delete" | "status" | "retry" | "exit";
export type SessionMenuUI = Pick<
  typeof prompts,
  "select" | "autocomplete" | "text" | "confirm" | "intro" | "outro" | "cancel" | "note" | "spinner"
>;

interface SessionMenuServices {
  list(): Promise<RemoteSession[]>;
  run: typeof runSessions;
}

const BACK = "back";

function checkoutPath(value: string, cwd: string): string {
  const path = value.trim() || cwd;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(cwd, path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Presentation only: mutations and latest-snapshot confirmation stay in the existing commands. */
export async function runSessionMenu(
  services: SessionMenuServices,
  options: { ui?: SessionMenuUI; cwd?: string; columns?: number } = {},
): Promise<void> {
  const ui = options.ui ?? prompts;
  const cwd = options.cwd ?? process.cwd();
  const columns = options.columns ?? process.stdout.columns ?? 100;
  let cancelledInCommand = false;
  // Commands reuse the menu's prompts; a cancelled confirmation exits the whole menu.
  const commandUI = {
    note: ui.note,
    spinner: ui.spinner,
    confirm: async (settings: Parameters<typeof prompts.confirm>[0]) => {
      const answer = await ui.confirm(settings);
      cancelledInCommand = prompts.isCancel(answer);
      return answer;
    },
  };
  function cancelled(value: unknown): value is symbol {
    if (!prompts.isCancel(value)) return false;
    ui.cancel("Session management cancelled.");
    return true;
  }

  async function pickSession(action: "restore" | "delete"): Promise<string | symbol> {
    const sessions = await services.list();
    if (!sessions.length) {
      ui.note(
        "No backups yet. In managed Pi, /axon-backup-now requests a checkpoint when your administrator enables backups.",
        "Sessions",
      );
      return BACK;
    }
    const titles = new Map(sessions.map((session) => [session.id, formatSessionTitle(session)]));
    return ui.autocomplete<string>({
      message: action === "restore" ? "Which session?" : "Which backup should be deleted?",
      placeholder: "Type to search by title, date or ID",
      maxItems: 8,
      options: [
        ...sessions.map((session) => ({
          value: session.id,
          label: formatSessionTitle(session, Math.max(20, columns - 8)),
          hint: `${formatLocalBackupTime(session.last_backup_at)} · ${formatSnapshotSize(session.snapshot?.raw_size_bytes)} · ${session.id.slice(0, 8)}`,
        })),
        { value: BACK, label: "← Back" },
      ],
      filter: (search, option) =>
        option.value === BACK ||
        `${titles.get(option.value) ?? ""} ${option.value} ${option.hint ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    });
  }

  ui.intro("Axon sessions");
  while (true) {
    const action = await ui.select<MenuAction>({
      message: "What would you like to do?",
      options: [
        { value: "restore", label: "Restore a session", hint: "continue a backup locally" },
        { value: "delete", label: "Delete a backup", hint: "local sessions are kept" },
        { value: "status", label: "Backup status" },
        { value: "retry", label: "Retry paused backups" },
        { value: "exit", label: "Exit" },
      ],
    });
    if (cancelled(action)) return;
    if (action === "exit") {
      ui.outro("Done.");
      return;
    }
    if (action === "status" || action === "retry") {
      await services.run(action, undefined, { ui: commandUI });
      continue;
    }

    const sessionId = await pickSession(action);
    if (cancelled(sessionId)) return;
    if (sessionId === BACK) continue;

    let destination: string | undefined;
    if (action === "restore") {
      const directory = await ui.text({
        message: "Restore into which checkout?",
        placeholder: `${formatHomePath(cwd)} (current directory)`,
        defaultValue: cwd,
        validate: (value) =>
          isDirectory(checkoutPath(value ?? "", cwd))
            ? undefined
            : "Choose an existing checkout directory.",
      });
      if (cancelled(directory)) return;
      destination = checkoutPath(directory, cwd);
    }

    await services.run(action, sessionId, {
      ...(destination ? { cwd: destination } : {}),
      ui: commandUI,
    });
    if (cancelledInCommand) {
      ui.cancel("Session management cancelled.");
      return;
    }
  }
}
