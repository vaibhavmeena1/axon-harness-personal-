import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "deputydev-status";
const AUTH_POLL_INTERVAL_MS = 1_000;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;

interface RecoveryStatus {
  readonly id: string;
  readonly state: "required" | "logging-in";
  readonly expiresAt: number;
}

function authRelayConfiguration(): { origin: string; capability: string } | undefined {
  const origin = Reflect.get(process.env, "PI_DEPUTYDEV_AUTH_RELAY_URL") as string | undefined;
  const capability = Reflect.get(process.env, "PI_DEPUTYDEV_AUTH_RELAY_KEY") as string | undefined;
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
    const url = new URL(`/_deputydev/auth/${action}`, config.origin);
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
    ctx.ui.setStatus("deputydev-auth", "Session expired — login required");
    try {
      const choice = await ctx.ui.select(
        "Your DeputyDev session expired. Sign in to continue this chat.",
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
      ctx.ui.setStatus("deputydev-auth", "Waiting for browser login…");
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
      ctx.ui.setStatus("deputydev-auth", undefined);
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
    ctx.ui.setStatus("deputydev-auth", undefined);
  };
}

export default function deputyDevExtension(pi: ExtensionAPI): void {
  let stopRecovery: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    stopRecovery?.();
    stopRecovery = watchSessionRecovery(ctx);
  });
  pi.on("session_shutdown", () => {
    stopRecovery?.();
    stopRecovery = undefined;
  });

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { message?: unknown };
    const message = typeof data.message === "string" ? data.message : "DeputyDev is active";
    return new Text(theme.fg("accent", message), 1, 0);
  });

  pi.registerCommand("deputydev-status", {
    description: "Show the active DeputyDev integration status",
    handler: async () => {
      pi.appendEntry(ENTRY_TYPE, {
        message: "DeputyDev-managed Pi resources are active",
      });
    },
  });
}
