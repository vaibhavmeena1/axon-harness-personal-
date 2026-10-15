import { z } from "zod";
import { BUILD_INFO } from "../build-info.ts";
import { isSingleCommandPrefix } from "../harnesses/pi/resources/extensions/terminal-permissions.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import { emitProductEvent } from "../telemetry/product-events.ts";

export const CLIENT_CONFIG_TIMEOUT_MS = 700;
const MAX_CONFIG_BYTES = 16 * 1024;

const telemetrySchema = z.object({
  enabled: z.boolean(),
  endpoint: z.literal("/api/v1/otel").default("/api/v1/otel"),
  protocol: z.literal("http/protobuf").default("http/protobuf"),
  traceSampleRatio: z.number().finite().min(0).max(1).default(1),
  metricExportIntervalMs: z.number().int().min(1_000).max(300_000).default(10_000),
});
const webSearchSchema = z.strictObject({
  enabled: z.boolean(),
  model: z.string().min(1).max(256),
  allowedModels: z.array(z.string().min(1).max(256)).max(33),
  timeoutMs: z.number().int().min(1_000).max(300_000),
  maxQueryCharacters: z.number().int().min(1).max(100_000),
  maxResultCharacters: z.number().int().min(1).max(100_000),
  maxOutputTokens: z.number().int().min(1).max(65_536),
  maxSources: z.number().int().min(1).max(100),
  temperature: z.number().finite().min(0).max(2),
  thinkingLevel: z.enum(["low", "medium", "high"]).nullish(),
  searchContextSize: z.enum(["low", "medium", "high"]).nullish(),
  useUrlContext: z.boolean(),
  requireGrounding: z.boolean(),
});
const commandPrefixSchema = z
  .string()
  .min(1)
  .max(96)
  // The extension measures UTF-16 code units, regardless of Zod's length semantics.
  .refine((value) => value.length <= 96, "Command prefixes must be at most 96 characters")
  .refine(
    (value) =>
      value.trim().length > 0 &&
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && (code < 127 || code > 159);
      }),
    "Command prefixes must not be blank or contain control characters",
  )
  .refine(
    isSingleCommandPrefix,
    "Command prefixes must contain a single command with supported shell syntax",
  );
const terminalPermissionsSchema = z.strictObject({
  yoloMode: z.boolean(),
  allowYoloMode: z.boolean(),
  autoApproveCommands: z.array(commandPrefixSchema).max(32),
  requireApprovalCommands: z.array(commandPrefixSchema).max(32),
  blockedCommands: z.array(commandPrefixSchema).max(32),
  approvalTimeoutMs: z.number().int().min(1_000).max(300_000),
});
// Partial launch preferences have no operational defaults. Null means no override.
function optionalOverride<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === null ? undefined : value), schema.optional());
}
function hasNoControlCharacters(value: string): boolean {
  return Array.from(value).every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && (code < 127 || code > 159);
  });
}
// An empty or null default leaves the user's saved Pi model untouched.
const piDefaultText = z.preprocess(
  (value) => (value === null || value === "" ? undefined : value),
  z
    .string()
    .refine(
      (value) =>
        value === value.trim() && Array.from(value).length <= 256 && hasNoControlCharacters(value),
      "Expected trimmed text without control characters",
    )
    .optional(),
);
const piSchema = z
  .strictObject({
    codemodeEnabled: z.boolean(),
    litellmMcpEnabled: z.boolean(),
    defaultProvider: piDefaultText,
    defaultModel: piDefaultText,
  })
  // Pi only uses a saved default when both are set.
  .refine(
    (pi) => (pi.defaultProvider === undefined) === (pi.defaultModel === undefined),
    "defaultProvider and defaultModel must be set together",
  );
const positiveInteger = z.number().int().min(1).max(2_147_483_647);
const countdown = z.number().int().min(1).max(300_000);
const compactionSchema = z.strictObject({
  enabled: optionalOverride(z.boolean()),
  model: optionalOverride(
    z.string().refine((value) => {
      const slash = value.indexOf("/");
      return (
        value === value.trim() &&
        Array.from(value).length <= 256 &&
        slash > 0 &&
        value.slice(0, slash).trim().length > 0 &&
        value.slice(slash + 1).trim().length > 0 &&
        hasNoControlCharacters(value)
      );
    }, "Expected a trimmed provider/model-id without control characters"),
  ),
  thresholdTokens: optionalOverride(positiveInteger),
  maxOutputTokens: optionalOverride(positiveInteger),
  timeoutMs: optionalOverride(positiveInteger),
});
const modelRecommenderSchema = z.strictObject({
  enabled: optionalOverride(z.boolean()),
  timeoutMs: optionalOverride(countdown),
  autoSelectMs: optionalOverride(countdown),
});
const litellmClientSchema = z.strictObject({
  discoveryTimeoutMs: optionalOverride(z.number().int().min(0).max(300_000)),
  defaultContextWindow: optionalOverride(positiveInteger),
});
const featureSchemas = {
  pi: piSchema,
  telemetry: telemetrySchema,
  webSearch: webSearchSchema,
  terminalPermissions: terminalPermissionsSchema,
  compaction: compactionSchema.nullish(),
  modelRecommender: modelRecommenderSchema.nullish(),
  litellmClient: litellmClientSchema.nullish(),
};
const envelopeSchema = z.object({ schemaVersion: z.literal(1) });

export type ClientConfig = { schemaVersion: 1 } & {
  [K in keyof typeof featureSchemas]?: NonNullable<z.infer<(typeof featureSchemas)[K]>>;
};
export type CompactionConfig = z.infer<typeof compactionSchema>;
export type ModelRecommenderConfig = z.infer<typeof modelRecommenderSchema>;
export type LiteLLMClientConfig = z.infer<typeof litellmClientSchema>;
export type PiConfig = z.infer<typeof piSchema>;
export type TelemetryConfig = z.infer<typeof telemetrySchema>;
export type WebSearchConfig = z.infer<typeof webSearchSchema>;
export type TerminalPermissionsConfig = z.infer<typeof terminalPermissionsSchema>;

export type ClientConfigSection = keyof typeof featureSchemas;

/** Receives only the section name: never validation inputs, unknown keys, or secret values. */
export type InvalidSectionHandler = (section: ClientConfigSection) => void;

export function parseClientConfig(
  value: unknown,
  onInvalidSection?: InvalidSectionHandler,
): ClientConfig {
  // Config can select policy, never a destination to which our session is sent.
  const config: ClientConfig = envelopeSchema.parse(value);
  for (const [name, schema] of Object.entries(featureSchemas)) {
    const raw = Reflect.get(value as object, name);
    if (raw === undefined) continue;
    const result = schema.safeParse(raw);
    if (!result.success) {
      // The caller decides whether to report: the terminal may belong to a running TUI.
      onInvalidSection?.(name as ClientConfigSection);
      continue;
    }
    if (result.data == null) continue;
    const supplied = Object.fromEntries(
      Object.entries(result.data).filter(([, entry]) => entry !== undefined),
    );
    if (Object.keys(supplied).length > 0) Object.assign(config, { [name]: supplied });
  }
  return config;
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
  readonly fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;
  readonly timeoutMs?: number;
  readonly onInvalidSection?: InvalidSectionHandler;
}

/** No cache, redirects, or body/header logging. Only successful responses may rotate auth. */
export async function fetchClientConfig(
  encryptedSession: string,
  options: ClientConfigFetchOptions = {},
): Promise<ClientConfigResult> {
  let response: Response | undefined;
  const startedAt = Date.now();
  const signal = AbortSignal.timeout(options.timeoutMs ?? CLIENT_CONFIG_TIMEOUT_MS);
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
        signal,
      },
    );
    if (!response.ok) {
      emitProductEvent({
        category: "config",
        stage: "fetch",
        outcome: "failed",
        reason: response.status >= 500 ? "http_5xx" : "http_4xx",
        durationMs: Date.now() - startedAt,
      });
      return {};
    }
    const refreshed = response.headers.get("x-session-refresh-token");
    const sessionRefreshToken =
      refreshed && refreshed.length <= 8192 && /^[\x21-\x7e]+$/.test(refreshed)
        ? refreshed
        : undefined;
    const rotation = sessionRefreshToken ? { sessionRefreshToken } : {};
    // Settings are optional, but an auth-service-issued rotation must not be
    // lost merely because a successful response has invalid/late config JSON.
    try {
      const config = parseClientConfig(await boundedJson(response), options.onInvalidSection);
      emitProductEvent({
        category: "config",
        stage: "fetch",
        outcome: "success",
        durationMs: Date.now() - startedAt,
      });
      return { config, ...rotation };
    } catch {
      emitProductEvent({
        category: "config",
        stage: "fetch",
        outcome: "failed",
        reason: signal.aborted ? "timeout" : "invalid_response",
        durationMs: Date.now() - startedAt,
      });
      return rotation;
    }
  } catch (error) {
    emitProductEvent({
      category: "config",
      stage: "fetch",
      outcome: "failed",
      reason:
        signal.aborted || (error instanceof Error && /abort|timeout/i.test(error.name))
          ? "timeout"
          : "network",
      durationMs: Date.now() - startedAt,
    });
    return {};
  } finally {
    await response?.body?.cancel().catch(() => {});
  }
}
