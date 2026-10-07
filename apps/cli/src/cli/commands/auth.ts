import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { isCancel, select } from "@clack/prompts";

import { BUILD_INFO } from "../../build-info.ts";
import { LauncherError } from "../../launcher/errors.ts";
import { LAUNCHER_EXIT_STATUS } from "../../launcher/exit-status.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../../product/endpoints.ts";
import type { DeputyDevPaths } from "../../product/paths.ts";
import { emitProductEvent } from "../../telemetry/product-events.ts";
import { loadEncryptedSession, saveEncryptedSession } from "../auth/session.ts";
import { verifyEncryptedSession } from "../auth/verification.ts";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const POLL_INTERVAL_MS = 2_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AuthLoginOptions {
  readonly browser?: boolean;
  /** Pi owns the terminal during in-chat login; report progress through its UI instead. */
  readonly quiet?: boolean;
  readonly signal?: AbortSignal;
}

interface LoginStart {
  readonly session_id: string;
  readonly browser_url: string;
}

function loginEndpoint(): string {
  return resolveServiceUrl(BUILD_INFO.serviceOrigin, SERVICE_ENDPOINTS.auth.browserLogin);
}

function parseBrowserUrl(value: string, sessionId: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.endsWith("/external-auth") ||
    url.searchParams.get("unique_session_id") !== sessionId ||
    url.searchParams.get("is_external_auth_request") !== "CLI"
  ) {
    throw new Error("Invalid browser login URL");
  }
  return url.toString();
}

async function startBrowserLogin(endpoint: string, signal?: AbortSignal): Promise<LoginStart> {
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.any([
      ...(signal === undefined ? [] : [signal]),
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]),
  });
  if (!response.ok) throw new Error(`Login request returned HTTP ${response.status}`);

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") throw new Error("Invalid login response");
  const login = payload as Partial<LoginStart>;
  if (
    typeof login.session_id !== "string" ||
    !SESSION_ID_PATTERN.test(login.session_id) ||
    typeof login.browser_url !== "string"
  ) {
    throw new Error("Invalid login response");
  }
  return {
    session_id: login.session_id,
    browser_url: parseBrowserUrl(login.browser_url, login.session_id),
  };
}

async function pollEncryptedSession(
  endpoint: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<string> {
  while (!signal.aborted) {
    const response = await fetch(`${endpoint}/${encodeURIComponent(sessionId)}`, {
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    }).catch(() => undefined);
    // Retry temporary outages until the overall login deadline, not just the first failure.
    if (!response || response.status === 429 || response.status >= 500) {
      await response?.body?.cancel();
      await sleep(POLL_INTERVAL_MS, undefined, { signal });
      continue;
    }
    if (!response.ok) throw new Error(`Session request returned HTTP ${response.status}`);

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") throw new Error("Invalid session response");
    const session = payload as { status?: unknown; encrypted_session_data?: unknown };
    if (session.status === "AUTHENTICATED") {
      if (typeof session.encrypted_session_data !== "string" || !session.encrypted_session_data) {
        throw new Error("Session response has no encrypted credential");
      }
      return session.encrypted_session_data;
    }
    if (session.status !== "PENDING") throw new Error("Browser login was not approved");
    await sleep(POLL_INTERVAL_MS, undefined, { signal });
  }
  throw new Error("Browser login timed out");
}

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Could not open the browser"));
    });
  });
}

async function runAuthLoginInternal(
  paths: DeputyDevPaths,
  options: AuthLoginOptions,
): Promise<boolean> {
  if (!options.browser) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new LauncherError(
        "Browser login requires an interactive terminal",
        LAUNCHER_EXIT_STATUS.usage,
        { remediation: "Run ddcli auth login --browser to skip the selection prompt." },
      );
    }
    const choice = await select({
      message: "Sign in to DeputyDev",
      options: [{ value: "browser", label: "Login from browser" }],
    });
    if (isCancel(choice)) return false;
  }

  const endpoint = loginEndpoint();
  try {
    const login = await startBrowserLogin(endpoint, options.signal);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ]);
    const timeout = setTimeout(() => controller.abort(), LOGIN_TIMEOUT_MS);
    try {
      // Start the CLI-side polling before asking the OS to open the browser.
      const polling = pollEncryptedSession(endpoint, login.session_id, signal);
      void polling.catch(() => {});
      signal.throwIfAborted();
      await openBrowser(login.browser_url);
      if (!options.quiet) console.log("Complete login in your browser; waiting for approval...");
      const encryptedSession = await polling;
      signal.throwIfAborted();
      await saveEncryptedSession(paths, encryptedSession);
      if (!options.quiet) console.log("DeputyDev encrypted session saved locally.");
      return true;
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  } catch {
    // Never include upstream responses, browser URLs, or session data in CLI errors.
    throw new LauncherError(
      "Browser login failed or timed out",
      LAUNCHER_EXIT_STATUS.profileFailure,
      { remediation: "Check the browser login page and auth service, then retry." },
    );
  }
}

export async function runAuthLogin(
  paths: DeputyDevPaths,
  options: AuthLoginOptions,
): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const authenticated = await runAuthLoginInternal(paths, options);
    emitProductEvent({
      category: "auth",
      stage: "login",
      outcome: authenticated ? "success" : "cancelled",
      durationMs: Date.now() - startedAt,
    });
    return authenticated;
  } catch (error) {
    emitProductEvent({
      category: "auth",
      stage: "login",
      outcome: options.signal?.aborted ? "cancelled" : "failed",
      reason: options.signal?.aborted ? "cancelled" : "unavailable",
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

export async function runAuthStatus(paths: DeputyDevPaths): Promise<void> {
  try {
    const encryptedSession = await loadEncryptedSession(paths);
    if (encryptedSession === undefined) {
      console.log("No saved DeputyDev browser session. Run ddcli auth login to sign in.");
      return;
    }
    const status = await verifyEncryptedSession(encryptedSession);
    console.log(
      status === "VERIFIED"
        ? "DeputyDev session is valid."
        : `DeputyDev session is ${status === "EXPIRED" ? "expired" : "invalid"}. Run ddcli auth login to sign in.`,
    );
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError(
      "Saved DeputyDev session could not be read safely",
      LAUNCHER_EXIT_STATUS.profileFailure,
    );
  }
}
