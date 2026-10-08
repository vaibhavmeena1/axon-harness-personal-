import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as prompts from "@clack/prompts";

import type { RemoteSession } from "../../sessions/contracts.ts";
import {
  formatBackupTime,
  formatSessionTitle,
  formatSnapshotSize,
} from "../../sessions/display.ts";
import type { runSessions } from "./sessions.ts";

type MenuAction = "restore" | "delete" | "status" | "retry" | "exit";
export type SessionMenuUI = Pick<
  typeof prompts,
  "select" | "autocomplete" | "text" | "confirm" | "intro" | "outro" | "cancel" | "note"
>;

interface SessionMenuServices {
  list(): Promise<RemoteSession[]>;
  run: typeof runSessions;
}

function checkoutPath(value: string, cwd: string): string {
  const path = value.trim() || cwd;
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(cwd, path);
}

/** Presentation only: mutations and latest-snapshot confirmation stay in the existing commands. */
export async function runSessionMenu(
  services: SessionMenuServices,
  options: { ui?: SessionMenuUI; cwd?: string; columns?: number } = {},
): Promise<void> {
  const ui = options.ui ?? prompts;
  const cwd = options.cwd ?? process.cwd();
  const columns = options.columns ?? process.stdout.columns ?? 100;
  function cancelled(value: unknown): value is symbol {
    if (!prompts.isCancel(value)) return false;
    ui.cancel("Session management cancelled.");
    return true;
  }

  ui.intro("Axon sessions");
  while (true) {
    const action = await ui.select<MenuAction>({
      message: "What would you like to do?",
      options: [
        {
          value: "restore",
          label: "Browse & restore sessions",
          hint: "Restore as a new local conversation",
        },
        { value: "delete", label: "Delete a backup", hint: "Local sessions are kept" },
        { value: "status", label: "Backup status" },
        {
          value: "retry",
          label: "Retry pending backups",
          hint: "Re-enable retry at the next backup boundary",
        },
        { value: "exit", label: "Done" },
      ],
    });
    if (cancelled(action)) return;
    if (action === "exit") {
      ui.outro("Done.");
      return;
    }
    if (action === "status" || action === "retry") {
      await services.run(action);
      continue;
    }

    const sessions = await services.list();
    if (!sessions.length) {
      ui.note(
        "No backed-up sessions yet. In managed Pi, /axon-backup-now requests a checkpoint when administrator policy enables backups.",
        "Sessions",
      );
      continue;
    }
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const selection = await ui.autocomplete<string>({
      message: action === "restore" ? "Choose a session to restore" : "Choose a backup to delete",
      placeholder: "Search by title, date or session ID",
      maxItems: 8,
      options: [
        ...sessions.map((session) => ({
          value: session.id,
          label: formatSessionTitle(session, Math.max(20, columns - 8)),
          hint: `${formatBackupTime(session.last_backup_at)} · ${formatSnapshotSize(session.snapshot?.raw_size_bytes)} · ${session.id.slice(0, 8)}`,
        })),
        { value: "back", label: "Back to menu" },
      ],
      filter: (search, option) =>
        option.value === "back" ||
        `${formatSessionTitle(byId.get(option.value) ?? { display_name: null })} ${option.value} ${option.hint ?? ""}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    });
    if (cancelled(selection)) return;
    if (selection === "back") continue;
    const session = byId.get(selection);
    if (!session) throw new Error("Selected session is not in the owned backup list");
    ui.note(
      [
        formatSessionTitle(session),
        `ID: ${session.id}`,
        `Latest backup: ${formatBackupTime(session.last_backup_at)}`,
        `Size: ${formatSnapshotSize(session.snapshot?.raw_size_bytes)}`,
      ].join("\n"),
      "Selected session",
    );

    let destination: string | undefined;
    if (action === "restore") {
      const directory = await ui.text({
        message: "Restore into which existing checkout?",
        placeholder: cwd,
        defaultValue: cwd,
        validate: (value) => {
          try {
            return statSync(checkoutPath(value ?? "", cwd)).isDirectory()
              ? undefined
              : "Choose an existing checkout directory.";
          } catch {
            return "Choose an existing checkout directory.";
          }
        },
      });
      if (cancelled(directory)) return;
      destination = checkoutPath(directory, cwd);
    }

    let confirmationCancelled = false;
    await services.run(action, session.id, {
      ...(destination ? { cwd: destination } : {}),
      confirm: async (settings) => {
        const answer = await ui.confirm(settings);
        confirmationCancelled = prompts.isCancel(answer);
        return answer;
      },
    });
    if (confirmationCancelled) {
      ui.cancel("Session management cancelled.");
      return;
    }
  }
}
