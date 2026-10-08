import { createHash } from "node:crypto";
import { z } from "zod";
import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import {
  fillEndpointTemplate,
  resolveServiceUrl,
  SERVICE_ENDPOINTS,
} from "../product/endpoints.ts";
import type { AxonPaths } from "../product/paths.ts";

export class BackupApiError extends Error {
  constructor(readonly status: number) {
    super(`Backup API returned HTTP ${status}`);
  }
}

export const statusSchema = z.object({
  enabled: z.boolean(),
  owner_user_team_id: z.string().regex(/^[1-9][0-9]*$/),
});

export class BackupApi {
  private verifiedToken: string | undefined;
  private responseToken: string | undefined;

  constructor(
    readonly paths: AxonPaths,
    readonly origin: string,
    readonly fetcher: typeof fetch = fetch,
  ) {}

  async request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const token = await loadEncryptedSession(this.paths);
    if (!token) throw new BackupApiError(401);
    if (path !== SERVICE_ENDPOINTS.sessions.status && token !== this.verifiedToken) {
      throw new Error("Credential changed; verify the backup owner before continuing");
    }
    let response: Response;
    try {
      response = await this.fetcher(resolveServiceUrl(this.origin, path), {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Backup request failed or timed out; snapshot remains pending");
    }
    const refreshed = response.headers.get("x-session-refresh-token");
    if (refreshed) await refreshEncryptedSession(this.paths, token, refreshed);
    // If a login changed during a request, do not chain its response under a different account.
    const expected = refreshed || token;
    if ((await loadEncryptedSession(this.paths)) !== expected)
      throw new Error("Axon account changed; backup paused");
    this.responseToken = expected;
    if (path !== SERVICE_ENDPOINTS.sessions.status) this.verifiedToken = expected;
    if (!response.ok) {
      await response.body?.cancel();
      throw new BackupApiError(response.status);
    }
    if (response.status === 204) return undefined;
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing backup API response");
    const pieces: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) throw new Error("Backup API response is too large");
        pieces.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(pieces).toString("utf8"));
    } catch {
      throw new Error("Invalid backup API response");
    }
  }

  async policy(signal?: AbortSignal): Promise<z.infer<typeof statusSchema>> {
    const result = statusSchema.parse(
      await this.request(SERVICE_ENDPOINTS.sessions.status, "GET", undefined, signal),
    );
    this.verifiedToken = result.enabled ? this.responseToken : undefined;
    return result;
  }

  async owner(signal?: AbortSignal): Promise<string> {
    const result = await this.policy(signal);
    if (!result.enabled) throw new BackupApiError(503);
    return result.owner_user_team_id;
  }

  credentialFingerprint(): string {
    if (!this.verifiedToken) throw new Error("Backup owner has not been verified");
    return createHash("sha256").update(this.verifiedToken).digest("hex");
  }

  endpoint(kind: "upload" | "finalize" | "download", id: string): string {
    return fillEndpointTemplate(SERVICE_ENDPOINTS.sessions[kind], { id });
  }
}

export function storageUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Unsafe object storage URL");
  return url.toString();
}
