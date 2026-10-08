import type { AxonPaths } from "../../product/paths.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";
import { runAuthLogin } from "../commands/auth.ts";
import { loadEncryptedSession } from "./session.ts";
import { verifyEncryptedSession } from "./verification.ts";

const CONTROL_PATH = "/_axon/auth";
const UI_HEARTBEAT_MS = 10_000;
const RECOVERY_TIMEOUT_MS = 5 * 60_000;

interface PendingRecovery {
  readonly id: string;
  readonly expiresAt: number;
  readonly controller: AbortController;
  readonly result: Promise<boolean>;
  readonly finish: (
    authenticated: boolean,
    failure?: { outcome: "failed" | "cancelled"; reason: string },
  ) => void;
  state: "required" | "logging-in";
}

export interface SessionRecovery {
  recover(signal: AbortSignal): Promise<boolean>;
  handle(request: Request, url: URL): Promise<Response | undefined>;
  dispose(): void;
}

function controlResponse(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

/** Control requests are capability-protected by the relay and never expose the real session. */
export function createSessionRecovery(paths: AxonPaths): SessionRecovery {
  let connectedUntil = 0;
  let pending: PendingRecovery | undefined;
  let disposed = false;

  return {
    async recover(signal) {
      // No registered interactive UI means a scripted/RPC request must fail promptly.
      if (disposed || signal.aborted || Date.now() >= connectedUntil) return false;
      if (pending !== undefined) return pending.result;

      let resolveResult: (authenticated: boolean) => void = () => {};
      const result = new Promise<boolean>((resolve) => {
        resolveResult = resolve;
      });
      const controller = new AbortController();
      const startedAt = Date.now();
      emitProductEvent({ category: "auth", stage: "recovery", outcome: "pending" });
      const finish: PendingRecovery["finish"] = (authenticated, failure): void => {
        if (pending !== recovery) return;
        pending = undefined;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        controller.abort();
        emitProductEvent({
          category: "auth",
          stage: "recovery",
          outcome: authenticated ? "success" : (failure?.outcome ?? "cancelled"),
          ...(authenticated ? {} : { reason: failure?.reason ?? "cancelled" }),
          durationMs: Date.now() - startedAt,
        });
        resolveResult(authenticated);
      };
      const onAbort = (): void => finish(false);
      const timeout = setTimeout(
        () => finish(false, { outcome: "failed", reason: "timeout" }),
        RECOVERY_TIMEOUT_MS,
      );
      const recovery: PendingRecovery = {
        id: crypto.randomUUID(),
        expiresAt: Date.now() + RECOVERY_TIMEOUT_MS,
        controller,
        result,
        finish,
        state: "required",
      };
      pending = recovery;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) finish(false);
      return result;
    },
    async handle(request, url) {
      if (!url.pathname.startsWith(`${CONTROL_PATH}/`)) return undefined;
      if (disposed) return controlResponse({ detail: "Session ended" }, 410);

      if (url.pathname === `${CONTROL_PATH}/status` && request.method === "GET") {
        connectedUntil = Date.now() + UI_HEARTBEAT_MS;
        return controlResponse({
          recovery:
            pending === undefined
              ? null
              : { id: pending.id, state: pending.state, expiresAt: pending.expiresAt },
        });
      }
      if (request.method !== "POST") return controlResponse({ detail: "Not found" }, 404);
      const recovery = pending;
      if (recovery === undefined || url.searchParams.get("id") !== recovery.id) {
        return controlResponse({ detail: "Login request is no longer active" }, 409);
      }
      if (url.pathname === `${CONTROL_PATH}/cancel`) {
        recovery.finish(false);
        return controlResponse({ authenticated: false });
      }
      if (url.pathname !== `${CONTROL_PATH}/login`) {
        return controlResponse({ detail: "Not found" }, 404);
      }
      if (recovery.state !== "required") {
        return controlResponse({ detail: "Browser login is already in progress" }, 409);
      }

      // Run outside the managed-request queue: that request is waiting for this login.
      recovery.state = "logging-in";
      const signal = AbortSignal.any([recovery.controller.signal, request.signal]);
      let authenticated = false;
      try {
        await runAuthLogin(paths, {
          browser: true,
          quiet: true,
          signal,
        });
        const session = await loadEncryptedSession(paths);
        authenticated =
          session !== undefined &&
          (await verifyEncryptedSession(session)) === "VERIFIED" &&
          !signal.aborted;
      } catch {
        // Keep credentials, browser URLs, and upstream errors out of Pi's transcript.
      } finally {
        recovery.finish(authenticated, {
          outcome: signal.aborted ? "cancelled" : "failed",
          reason: signal.aborted ? "cancelled" : "unavailable",
        });
      }
      return controlResponse({ authenticated }, authenticated ? 200 : 401);
    },
    dispose() {
      disposed = true;
      connectedUntil = 0;
      pending?.finish(false);
    },
  };
}
