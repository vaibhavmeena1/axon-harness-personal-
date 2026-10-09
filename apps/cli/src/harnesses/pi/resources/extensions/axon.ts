import {
  type AppKeybinding,
  type ExtensionAPI,
  type ExtensionContext,
  keyText,
  type Theme,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "axon-status";
// Keep this bus contract in sync with session-backup/index.ts; this extension ships standalone.
const BACKUP_HEADER_CHANNEL = "axon:backup-status";
const BACKUP_LABELS = {
  checking: "checking…",
  syncing: "syncing…",
  saved: "saved",
  pending: "pending",
  paused: "paused",
  off: "off",
  ready: "on",
} as const;
type BackupHeaderState = keyof typeof BACKUP_LABELS;

/** Compact, responsive branding; all colors and shortcuts follow Pi's active settings. */
function createAxonHeader(theme: Theme, backupState: () => BackupHeaderState | undefined) {
  const rawVersion = process.env["PI_AXON_CLI_VERSION"];
  const version =
    rawVersion && /^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,79}$/.test(rawVersion) ? ` v${rawVersion}` : "";
  let expanded = false;

  const hint = (action: AppKeybinding, description: string): string | undefined => {
    const key = keyText(action);
    return key ? rawHint(key, description) : undefined;
  };
  const rawHint = (key: string, description: string): string =>
    theme.fg("accent", key) + theme.fg("muted", ` ${description}`);

  return {
    setExpanded(value: boolean) {
      expanded = value;
    },
    invalidate() {},
    render(width: number): string[] {
      if (width <= 0) return [];
      const padding = width > 2 ? 1 : 0;
      const contentWidth = width - padding * 2;
      const showLogo = width >= 48;
      const title = theme.fg("accent", "Axon") + theme.fg("dim", version);
      const attribution = theme.fg("dim", `Powered by Pi v${VERSION}`);
      const withBackup = (line: string): string => {
        const state = backupState();
        if (state === undefined) return line;
        const color =
          state === "saved" || state === "ready"
            ? "success"
            : state === "paused" || state === "pending"
              ? "warning"
              : state === "checking" || state === "syncing"
                ? "accent"
                : "dim";
        const badge = theme.fg("dim", "Backup: ") + theme.fg(color, BACKUP_LABELS[state]);
        const available = contentWidth - visibleWidth(badge) - 2;
        // Preserve the wordmark (and the entire logo when present) before showing a badge.
        const minimumTitleWidth = showLogo ? 14 : 4;
        if (available < minimumTitleWidth) return line;
        const left = truncateToWidth(line, available, available === minimumTitleWidth ? "" : "…");
        return left + " ".repeat(contentWidth - visibleWidth(left) - visibleWidth(badge)) + badge;
      };
      const brand = showLogo
        ? [
            withBackup(theme.fg("accent", "   ●      ") + title),
            theme.fg("accent", "  ╱ ╲     ") +
              theme.fg("muted", "TATA 1mg · Your coding workspace"),
            theme.fg("accent", " ●───●    ") + attribution,
          ]
        : [withBackup(title), theme.fg("muted", "TATA 1mg"), attribution];
      const separator = theme.fg("dim", " · ");
      // Keep each shortcut intact when possible, wrapping rather than dropping later actions.
      const wrapHints = (hints: string[]): string[] => {
        const lines: string[] = [];
        let current = "";
        for (const item of hints) {
          if (current && visibleWidth(current + separator + item) <= contentWidth) {
            current += separator + item;
          } else {
            if (current) lines.push(current);
            const wrapped = wrapTextWithAnsi(item, contentWidth);
            lines.push(...wrapped.slice(0, -1));
            current = wrapped.at(-1) ?? "";
          }
        }
        if (current) lines.push(current);
        return lines;
      };
      const shortcuts = [
        hint("app.interrupt", "interrupt"),
        hint("app.model.select", "models"),
        ...(expanded
          ? [
              hint("app.clear", "clear / twice to exit"),
              hint("app.exit", "exit (empty editor)"),
              hint("app.thinking.cycle", "thinking level"),
              hint("app.thinking.toggle", "show/hide thinking"),
              hint("app.editor.external", "external editor"),
              hint("app.message.followUp", "queue follow-up"),
              hint("app.clipboard.pasteImage", "attach files/images"),
            ]
          : []),
        rawHint("/", "commands"),
        rawHint("!", "shell"),
      ].filter((value): value is string => value !== undefined);
      const help = [
        hint("app.tools.expand", expanded ? "less" : "more"),
        rawHint("/hotkeys", "all shortcuts"),
      ].filter((value): value is string => value !== undefined);
      const lines = [
        ...brand,
        "",
        ...(expanded
          ? shortcuts.flatMap((item) => wrapTextWithAnsi(item, contentWidth))
          : wrapHints(shortcuts)),
        ...wrapHints(help),
      ];
      return lines.map((line) =>
        line ? " ".repeat(padding) + truncateToWidth(line, contentWidth) : "",
      );
    },
  };
}
const AUTH_POLL_INTERVAL_MS = 1_000;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;

interface RecoveryStatus {
  readonly id: string;
  readonly state: "required" | "logging-in";
  readonly expiresAt: number;
}

function authRelayConfiguration(): { origin: string; capability: string } | undefined {
  const origin = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_URL") as string | undefined;
  const capability = Reflect.get(process.env, "PI_AXON_AUTH_RELAY_KEY") as string | undefined;
  if (!origin || !capability) return undefined;
  try {
    const url = new URL(origin);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return { origin: url.origin, capability };
  } catch {
    return undefined;
  }
}

/** Polling runs independently of Pi's model request, which the relay can pause for login. */
function watchSessionRecovery(ctx: ExtensionContext): () => void {
  const config = authRelayConfiguration();
  if (!ctx.hasUI || config === undefined) return () => {};

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handledRecovery: string | undefined;
  let activePrompt: { id: string; controller: AbortController } | undefined;
  let busy = false;

  const authRequest = (action: string, method = "GET", id?: string): Promise<Response> => {
    const url = new URL(`/_axon/auth/${action}`, config.origin);
    if (id !== undefined) url.searchParams.set("id", id);
    return fetch(url, {
      method,
      headers: { Authorization: `Bearer ${config.capability}` },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(action === "login" ? 5 * 60_000 : AUTH_REQUEST_TIMEOUT_MS),
      ]),
    });
  };

  const offerLogin = async (recovery: RecoveryStatus): Promise<void> => {
    const promptController = new AbortController();
    activePrompt = { id: recovery.id, controller: promptController };
    const signal = AbortSignal.any([
      controller.signal,
      promptController.signal,
      ...(ctx.signal === undefined ? [] : [ctx.signal]),
    ]);
    ctx.ui.setStatus("axon-auth", "Session expired — login required");
    try {
      const choice = await ctx.ui.select(
        "Your Axon session expired. Sign in to continue this chat.",
        ["Login from browser", "Not now (keep chat open)"],
        { signal, timeout: Math.max(1, recovery.expiresAt - Date.now()) },
      );
      activePrompt = undefined;
      if (choice !== "Login from browser" || signal.aborted) {
        await authRequest("cancel", "POST", recovery.id);
        if (!controller.signal.aborted) {
          ctx.ui.notify(
            "Login cancelled. Your chat is still open; sign in and retry when ready.",
            "warning",
          );
        }
        return;
      }
      ctx.ui.setStatus("axon-auth", "Waiting for browser login…");
      ctx.ui.notify(
        "Complete login in your browser. This chat will continue after approval.",
        "info",
      );
      const response = await authRequest("login", "POST", recovery.id);
      const payload: unknown = await response.json();
      const authenticated =
        response.ok &&
        payload !== null &&
        typeof payload === "object" &&
        "authenticated" in payload &&
        payload.authenticated === true;
      if (!controller.signal.aborted) {
        ctx.ui.notify(
          authenticated
            ? "Signed in. Continuing your chat…"
            : "Login failed or timed out. Your chat is still open; retry to sign in again.",
          authenticated ? "info" : "warning",
        );
      }
    } catch {
      if (!controller.signal.aborted) {
        await authRequest("cancel", "POST", recovery.id).catch(() => {});
        ctx.ui.notify(
          "Login could not complete. Your chat is still open; retry when ready.",
          "warning",
        );
      }
    } finally {
      activePrompt = undefined;
      ctx.ui.setStatus("axon-auth", undefined);
    }
  };

  const poll = async (): Promise<void> => {
    try {
      const response = await authRequest("status");
      if (!response.ok) return;
      const payload: unknown = await response.json();
      const recovery = (payload as { recovery?: Partial<RecoveryStatus> } | null)?.recovery;
      // Dismiss a stale dialog if Pi cancelled the waiting request or its deadline elapsed.
      if (activePrompt !== undefined && activePrompt.id !== recovery?.id) {
        activePrompt.controller.abort();
      }
      if (
        !busy &&
        recovery?.state === "required" &&
        typeof recovery.id === "string" &&
        typeof recovery.expiresAt === "number" &&
        recovery.id !== handledRecovery
      ) {
        handledRecovery = recovery.id;
        busy = true;
        void offerLogin(recovery as RecoveryStatus).finally(() => {
          busy = false;
        });
      }
    } catch {
      // A transient loopback failure must not interrupt the chat or spam notifications.
    } finally {
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), AUTH_POLL_INTERVAL_MS);
    }
  };
  void poll();
  return () => {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    ctx.ui.setStatus("axon-auth", undefined);
  };
}

export default function axonExtension(pi: ExtensionAPI): void {
  let stopRecovery: (() => void) | undefined;
  let backupState: BackupHeaderState | undefined;
  let refreshHeader: (() => void) | undefined;
  pi.events.on(BACKUP_HEADER_CHANNEL, (data) => {
    if (typeof data !== "string" || !Object.hasOwn(BACKUP_LABELS, data)) return;
    backupState = data as BackupHeaderState;
    refreshHeader?.();
  });
  pi.on("session_start", (_event, ctx) => {
    stopRecovery?.();
    stopRecovery = watchSessionRecovery(ctx);
    if (ctx.mode === "tui") {
      ctx.ui.setHeader((tui, theme) => {
        const component = createAxonHeader(theme, () => backupState);
        const refresh = () => {
          component.invalidate();
          tui.requestRender();
        };
        refreshHeader = refresh;
        return {
          ...component,
          dispose() {
            if (refreshHeader === refresh) refreshHeader = undefined;
          },
        };
      });
    }
  });
  pi.on("session_shutdown", () => {
    refreshHeader = undefined;
    backupState = undefined;
    stopRecovery?.();
    stopRecovery = undefined;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "Axon is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  pi.registerCommand("axon-status", {
    description: "Show the active Axon integration status",
    handler: async () => {
      pi.appendEntry(ENTRY_TYPE, {
        message: "Axon-managed Pi resources are active",
      });
    },
  });
}
