import { z } from "zod";

import { BUILD_INFO } from "../build-info.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";

export const CLIENT_CONFIG_TIMEOUT_MS = 700;
const MAX_CONFIG_BYTES = 16 * 1024;

const telemetrySchema = z.object({
  enabled: z.boolean(),
  endpoint: z.literal("/api/v1/otel").default("/api/v1/otel"),
  protocol: z.literal("http/protobuf").default("http/protobuf"),
  traceSampleRatio: z.number().finite().min(0).max(1).default(1),
  metricExportIntervalMs: z.number().int().min(1_000).max(300_000).default(10_000),
});
const configSchema = z.object({
  schemaVersion: z.literal(1),
  telemetry: telemetrySchema.optional(),
});

export type ClientConfig = z.infer<typeof configSchema>;
export type TelemetryConfig = z.infer<typeof telemetrySchema>;

export function parseClientConfig(value: unknown): ClientConfig {
  // Config can select policy, never a destination to which our session is sent.
  return configSchema.parse(value);
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.split(";")[0]?.trim().endsWith("/json")) {
    throw new Error("Expected JSON config");
  }
  if (Number(response.headers.get("content-length")) > MAX_CONFIG_BYTES || !response.body) {
    throw new Error("Invalid config size");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_CONFIG_BYTES) throw new Error("Config too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export interface ClientConfigResult {
  readonly config?: ClientConfig;
  readonly sessionRefreshToken?: string;
}

export interface ClientConfigFetchOptions {
  readonly serviceOrigin?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

/** No cache, redirects, or body/header logging. Only successful responses may rotate auth. */
export async function fetchClientConfig(
  encryptedSession: string,
  options: ClientConfigFetchOptions = {},
): Promise<ClientConfigResult> {
  let response: Response | undefined;
  try {
    response = await (options.fetcher ?? fetch)(
      resolveServiceUrl(
        options.serviceOrigin ?? BUILD_INFO.serviceOrigin,
        SERVICE_ENDPOINTS.cli.config,
      ),
      {
        headers: { accept: "application/json", authorization: `Bearer ${encryptedSession}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(options.timeoutMs ?? CLIENT_CONFIG_TIMEOUT_MS),
      },
    );
    if (!response.ok) return {};
    const refreshed = response.headers.get("x-session-refresh-token");
    const sessionRefreshToken =
      refreshed && refreshed.length <= 8192 && /^[\x21-\x7e]+$/.test(refreshed)
        ? refreshed
        : undefined;
    const rotation = sessionRefreshToken ? { sessionRefreshToken } : {};
    // Settings are optional, but an auth-service-issued rotation must not be
    // lost merely because a successful response has invalid/late config JSON.
    try {
      const config = parseClientConfig(await boundedJson(response));
      return { config, ...rotation };
    } catch {
      return rotation;
    }
  } catch {
    return {};
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}
