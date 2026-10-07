export type OtlpProtocol = "grpc" | "http/protobuf";

export interface OrgTelemetryConfig {
  readonly protocol: OtlpProtocol;
  readonly signalProtocols?: Readonly<Record<"traces" | "metrics" | "logs", OtlpProtocol>>;
  readonly serviceName: string;
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly sampleRatio: number;
  readonly metricExportIntervalMs: number;
  readonly diagnostics: boolean;
  readonly maxQueueSize: number;
  readonly maxExportBatchSize: number;
  readonly scheduledDelayMs: number;
  readonly exportTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

function isFalse(value: string | undefined): boolean {
  return value === "0" || value?.toLowerCase() === "false" || value?.toLowerCase() === "no";
}

function endpointConfigured(env: NodeJS.ProcessEnv): boolean {
  if (env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim()) return true;
  return [
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  ].every((name) => Boolean(env[name]?.trim()));
}

function parseProtocol(value: string | undefined): OtlpProtocol | undefined {
  const protocol = value?.trim().toLowerCase() || "http/protobuf";
  return protocol === "grpc" || protocol === "http/protobuf" ? protocol : undefined;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function parseRatio(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

function resolveSampleRatio(env: NodeJS.ProcessEnv): number {
  const sampler = env["OTEL_TRACES_SAMPLER"]?.trim().toLowerCase();
  if (sampler === "always_off" || sampler === "parentbased_always_off") return 0;
  if (sampler === "traceidratio" || sampler === "parentbased_traceidratio") {
    return parseRatio(env["OTEL_TRACES_SAMPLER_ARG"], 1);
  }
  return 1;
}

export function parseResourceAttributes(value: string | undefined): Record<string, string> {
  const attributes: Record<string, string> = {};
  if (!value) return attributes;
  for (const item of value.split(",")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = item.slice(separator + 1).trim();
    try {
      attributes[name] = decodeURIComponent(rawValue);
    } catch {
      attributes[name] = rawValue;
    }
  }
  return attributes;
}

/**
 * Standard batch-processor knobs. Explicit values passed to the SDK override its own env-var
 * defaults, so they are parsed here. `OTEL_BLRP_*` (logs) falls back to `OTEL_BSP_*` (traces),
 * then to the managed defaults; both are bounded so a typo cannot create an unbounded queue.
 */
function batchSetting(
  env: NodeJS.ProcessEnv,
  suffix: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return parseBoundedInteger(
    env[`OTEL_BLRP_${suffix}`] ?? env[`OTEL_BSP_${suffix}`],
    fallback,
    minimum,
    maximum,
  );
}

/** Return undefined when managed OTLP configuration is absent or explicitly disabled. */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
): OrgTelemetryConfig | undefined {
  if (isFalse(env["PI_ORG_OTEL_ENABLED"]) || !endpointConfigured(env)) return undefined;

  const managed = Boolean(env["PI_ORG_OTEL_MANAGED_ENDPOINT"]);
  const protocol = managed ? "http/protobuf" : parseProtocol(env["OTEL_EXPORTER_OTLP_PROTOCOL"]);
  const traces = managed
    ? "http/protobuf"
    : parseProtocol(
        env["OTEL_EXPORTER_OTLP_TRACES_PROTOCOL"] ?? env["OTEL_EXPORTER_OTLP_PROTOCOL"],
      );
  const metrics = managed
    ? "http/protobuf"
    : parseProtocol(
        env["OTEL_EXPORTER_OTLP_METRICS_PROTOCOL"] ?? env["OTEL_EXPORTER_OTLP_PROTOCOL"],
      );
  const logs = managed
    ? "http/protobuf"
    : parseProtocol(env["OTEL_EXPORTER_OTLP_LOGS_PROTOCOL"] ?? env["OTEL_EXPORTER_OTLP_PROTOCOL"]);
  if (!traces || !metrics || !logs) return undefined;

  const maxQueueSize = batchSetting(env, "MAX_QUEUE_SIZE", 2_048, 64, 16_384);
  return {
    protocol: protocol ?? traces,
    signalProtocols: { traces, metrics, logs },
    serviceName: env["OTEL_SERVICE_NAME"]?.trim() || "pi-coding-agent",
    resourceAttributes: parseResourceAttributes(env["OTEL_RESOURCE_ATTRIBUTES"]),
    sampleRatio: resolveSampleRatio(env),
    metricExportIntervalMs: parseBoundedInteger(
      env["OTEL_METRIC_EXPORT_INTERVAL"],
      10_000,
      1_000,
      300_000,
    ),
    diagnostics: !isFalse(env["PI_ORG_OTEL_DIAGNOSTICS"]),
    maxQueueSize,
    maxExportBatchSize: Math.min(
      maxQueueSize,
      batchSetting(env, "MAX_EXPORT_BATCH_SIZE", 256, 1, 4_096),
    ),
    scheduledDelayMs: batchSetting(env, "SCHEDULE_DELAY", 1_000, 100, 60_000),
    exportTimeoutMs: batchSetting(env, "EXPORT_TIMEOUT", 3_000, 500, 60_000),
    shutdownTimeoutMs: 2_000,
  };
}
