import { isAbsolute } from "node:path";

import { BUILD_INFO } from "../../build-info.ts";
import type { TelemetryConfig } from "../../cli/client-config.ts";
import type { EnvironmentOverrides } from "../../launcher/environment.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../../product/endpoints.ts";

export function isTelemetryDisabled(environment: NodeJS.ProcessEnv): boolean {
  const value = (Reflect.get(environment, "PI_ORG_OTEL_ENABLED") as string | undefined)
    ?.trim()
    .toLowerCase();
  return value === "false" || value === "0" || value === "no";
}

export interface ManagedTelemetryOptions {
  readonly home: string;
  readonly serviceOrigin?: string;
}

/** Internal markers are never inherited into the env-fallback path. */
const CLEAR_MANAGED = {
  PI_ORG_OTEL_MANAGED_ENDPOINT: undefined,
  PI_ORG_OTEL_MANAGED_HOME: undefined,
};

export function createTelemetryOverrides(
  environment: NodeJS.ProcessEnv,
  telemetry?: TelemetryConfig,
  offline = false,
  managed?: ManagedTelemetryOptions,
): EnvironmentOverrides {
  if (offline) return { ...CLEAR_MANAGED, PI_ORG_OTEL_ENABLED: "false" };
  if (!telemetry)
    return isTelemetryDisabled(environment)
      ? { ...CLEAR_MANAGED, PI_ORG_OTEL_ENABLED: "false" }
      : { ...CLEAR_MANAGED };
  if (!telemetry.enabled || !managed || !isAbsolute(managed.home))
    return { ...CLEAR_MANAGED, PI_ORG_OTEL_ENABLED: "false" };

  const endpoint = resolveServiceUrl(
    managed.serviceOrigin ?? BUILD_INFO.serviceOrigin,
    SERVICE_ENDPOINTS.otel.base,
  );
  // Remove all inherited destination/credential/TLS overrides. Managed exporters
  // read the safely stored session for each batch; no session is put in OTEL headers.
  const overrides: Record<string, string | undefined> = {
    PI_ORG_OTEL_ENABLED: "true",
    PI_ORG_OTEL_MANAGED_ENDPOINT: endpoint,
    PI_ORG_OTEL_MANAGED_HOME: managed.home,
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
    OTEL_TRACES_SAMPLER_ARG: String(telemetry.traceSampleRatio),
    OTEL_METRIC_EXPORT_INTERVAL: String(telemetry.metricExportIntervalMs),
  };
  const transportFields = [
    "HEADERS",
    "INSECURE",
    "CERTIFICATE",
    "CLIENT_KEY",
    "CLIENT_CERTIFICATE",
  ];
  for (const field of transportFields) overrides[`OTEL_EXPORTER_OTLP_${field}`] = undefined;
  for (const signal of ["TRACES", "METRICS", "LOGS"]) {
    for (const suffix of ["ENDPOINT", "PROTOCOL", ...transportFields])
      overrides[`OTEL_EXPORTER_OTLP_${signal}_${suffix}`] = undefined;
  }
  return overrides;
}
