import { timingSafeEqual } from "node:crypto";

import { BUILD_INFO } from "../../build-info.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";
import { loadEncryptedSession, saveEncryptedSession } from "./session.ts";
import { createSessionRecovery, type SessionRecovery } from "./session-recovery.ts";
import { verifyEncryptedSession } from "./verification.ts";

const REMOVED_REQUEST_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "x-session-refresh-token",
  "x-auth-context",
  "x-encrypted-session-data",
];
const REMOVED_RESPONSE_HEADERS = [
  "authorization",
  "api-key",
  "x-api-key",
  "set-cookie",
  "content-length",
  "content-encoding",
  "connection",
  "transfer-encoding",
  "new_session_data",
  "x-session-refresh-token",
  "x-auth-context",
  "x-encrypted-session-data",
];

export interface AuthenticatedRequestRelay {
  readonly origin: string;
  readonly capability: string;
  dispose(): void;
}

function relayError(status: number, message: string): Response {
  return Response.json(
    {
      detail: message,
      error: {
        message,
        type: status === 401 ? "authentication_error" : "gateway_error",
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function matchesCapability(value: string, expected: string): boolean {
  const supplied = Buffer.from(value);
  const required = Buffer.from(expected);
  return supplied.length === required.length && timingSafeEqual(supplied, required);
}

function authorizedLocalRequest(request: Request, capability: string): boolean {
  // OpenAI uses Authorization; native Anthropic requests may use x-api-key.
  const authorization = request.headers.get("authorization");
  const apiKey = request.headers.get("x-api-key");
  if (authorization === null && apiKey === null) return false;
  return (
    (authorization === null || matchesCapability(authorization, `Bearer ${capability}`)) &&
    (apiKey === null || matchesCapability(apiKey, capability))
  );
}

async function forwardManagedRequest(
  request: Request,
  url: URL,
  paths: DeputyDevPaths,
  recovery: SessionRecovery,
): Promise<Response> {
  // Only the bounded request body is replayable. Successful response/SSE bodies stay streaming.
  const body =
    request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (body !== undefined && body.byteLength > 10 * 1024 * 1024) {
    return relayError(413, "DeputyDev request is too large.");
  }
  // Recommendations have their own short-lived picker. Recover on the ensuing model
  // request instead of opening a second dialog over that picker.
  const supportsRecovery = url.pathname.startsWith("/litellm/");
  const loginRequired = (): Response =>
    relayError(
      401,
      "Your DeputyDev session is invalid or expired. Your chat is still open. Run ddcli auth login in another terminal, then retry here.",
    );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    request.signal.throwIfAborted();
    let encryptedSession: string | undefined;
    try {
      // Never cache the real credential in Pi's environment or in this relay.
      encryptedSession = await loadEncryptedSession(paths);
    } catch {
      // An explicitly selected login can repair invalid saved session data.
    }
    if (encryptedSession === undefined) {
      if (attempt === 0 && supportsRecovery && (await recovery.recover(request.signal))) continue;
      return loginRequired();
    }

    const headers = new Headers(request.headers);
    for (const name of REMOVED_REQUEST_HEADERS) headers.delete(name);
    headers.set("Authorization", `Bearer ${encryptedSession}`);
    headers.set("X-Harness-Id", "pi");

    let upstream: Response;
    try {
      upstream = await fetch(new URL(`${url.pathname}${url.search}`, BUILD_INFO.serviceOrigin), {
        method: request.method,
        headers,
        body,
        redirect: "error",
        cache: "no-store",
        signal: request.signal,
      });
    } catch {
      return relayError(502, "DeputyDev is temporarily unavailable. Check connectivity and retry.");
    }

    const refreshedSession = upstream.headers.get("x-session-refresh-token");
    // Authentication may rotate the session even if the model returns an error.
    if (refreshedSession) {
      try {
        // Conditional atomic persistence prevents a late response replacing a newer login.
        await saveEncryptedSession(paths, refreshedSession, encryptedSession);
      } catch {
        await upstream.body?.cancel();
        return relayError(503, "Your refreshed DeputyDev session could not be saved safely.");
      }
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel();
      if (!supportsRecovery) return loginRequired();
      try {
        // A refresh or another terminal's login may already have replaced this
        // credential. Retry once with it before offering another browser login.
        const latestSession = await loadEncryptedSession(paths);
        if (attempt === 0 && latestSession !== undefined && latestSession !== encryptedSession) {
          continue;
        }
        // A model-provider 401 with a valid DeputyDev session is not a reason to log in again.
        if ((await verifyEncryptedSession(encryptedSession)) === "VERIFIED") {
          return relayError(
            401,
            "The model service rejected this request; your DeputyDev session is still valid.",
          );
        }
      } catch {
        return relayError(
          503,
          "Could not verify your DeputyDev session. Check connectivity and retry.",
        );
      }
      if (attempt === 0 && (await recovery.recover(request.signal))) continue;
      return loginRequired();
    }

    const responseHeaders = new Headers(upstream.headers);
    for (const name of REMOVED_RESPONSE_HEADERS) responseHeaders.delete(name);
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }
  return loginRequired();
}

/** A per-launch, capability-protected loopback transport owned by ddcli, not a provider fork. */
export function startAuthenticatedRequestRelay(paths: DeputyDevPaths): AuthenticatedRequestRelay {
  const capability = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const recovery = createSessionRecovery(paths);
  let pendingRequest = Promise.resolve();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 0,
    maxRequestBodySize: 10 * 1024 * 1024,
    error() {
      return relayError(503, "DeputyDev could not process this request safely");
    },
    async fetch(request) {
      if (!authorizedLocalRequest(request, capability)) {
        return relayError(401, "Invalid local DeputyDev request credential");
      }
      const url = new URL(request.url);
      // Control calls must bypass the queue so Pi can approve login while a model request waits.
      const controlResponse = await recovery.handle(request, url);
      if (controlResponse !== undefined) return controlResponse;
      const allowed =
        url.pathname.startsWith("/litellm/") ||
        (url.pathname === "/api/v1/model-recommendations" && request.method === "POST") ||
        (url.pathname === "/api/v1/web-search" && request.method === "POST");
      if (!allowed) return relayError(404, "DeputyDev endpoint is not available");

      // Serialize only until response headers arrive: streams remain concurrent,
      // while subsequent requests observe a token rotated by the auth service.
      const previousRequest = pendingRequest;
      let releaseRequest: () => void = () => {};
      pendingRequest = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      await previousRequest;
      try {
        return await forwardManagedRequest(request, url, paths, recovery);
      } catch {
        // Do not let Bun's development error page disclose request headers or locals.
        return relayError(503, "DeputyDev could not process this request safely");
      } finally {
        releaseRequest();
      }
    },
  });

  return Object.freeze({
    origin: server.url.origin,
    capability,
    dispose: () => {
      recovery.dispose();
      void server.stop(true);
    },
  });
}
