import { BUILD_INFO } from "../build-info.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import { fetchClientConfig, type TelemetryConfig } from "../cli/client-config.ts";
import { isPiOffline } from "../harnesses/pi/setup/packages/invocation.ts";
import type { TelemetryRuntime } from "../harnesses/pi/telemetry/src/telemetry-types.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import type { AxonPaths } from "../product/paths.ts";
import { hasProductEvents, subscribeProductEvents, takeProductEvents } from "./product-events.ts";

let runtime: TelemetryRuntime | undefined;
let stop: (() => void) | undefined;
let initialization: Promise<void> | undefined;
let closing: Promise<void> | undefined;

/** In-memory invocation state, never inferred from inherited managed env markers. */
export interface ProductTelemetryDecision {
  readonly offline: boolean;
  readonly policy?: TelemetryConfig | undefined;
}
let decision: ProductTelemetryDecision | undefined;

/** Called at the command boundary, after the preceding invocation has flushed. */
export function beginProductTelemetryInvocation(): void {
  decision = undefined;
}

/** Lazy managed-only telemetry: no SDK, config request or socket until policy allows export. */
export async function initializeProductTelemetry(
  paths: AxonPaths,
  policy?: TelemetryConfig,
  options: {
    serviceOrigin?: string;
    decision?: ProductTelemetryDecision;
  } = {},
): Promise<void> {
  if (closing) await closing;
  if (!initialization) {
    // Explicit startup resolution includes 'fetched, no accepted policy'. Reuse it
    // at shutdown instead of making another request or re-reading local opt-outs.
    if (options.decision) decision = options.decision;
    else if (policy) decision = { offline: isPiOffline(process.env, []), policy };
  }
  initialization ??= (async () => {
    try {
      if (!decision) {
        decision = { offline: isPiOffline(process.env, []) };
        if (!decision.offline) {
          let session = await loadEncryptedSession(paths);
          if (session) {
            const result = await fetchClientConfig(session, options);
            if (
              result.sessionRefreshToken &&
              (await refreshEncryptedSession(
                paths,
                session,
                result.sessionRefreshToken,
                AbortSignal.timeout(700),
              ))
            )
              session = result.sessionRefreshToken;
            if ((await loadEncryptedSession(paths)) === session)
              decision = { offline: false, policy: result.config?.telemetry };
          }
        }
      }
      const telemetry = decision?.policy;
      if (!decision || decision.offline || !telemetry?.enabled) return;
      const [{ resolveConfig }, { createOtelRuntime }, { recordProductEvent }] = await Promise.all([
        import("../harnesses/pi/telemetry/src/config.ts"),
        import("../harnesses/pi/telemetry/src/otel/runtime.ts"),
        import("../harnesses/pi/telemetry/src/product.ts"),
      ]);
      const endpoint = resolveServiceUrl(
        options.serviceOrigin ?? BUILD_INFO.serviceOrigin,
        SERVICE_ENDPOINTS.otel.base,
      );
      const config = resolveConfig({
        PI_ORG_OTEL_ENABLED: "true",
        PI_ORG_OTEL_MANAGED_ENDPOINT: endpoint,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        OTEL_SERVICE_NAME: "axon-cli",
        PI_ORG_OTEL_DIAGNOSTICS: "false",
        OTEL_TRACES_SAMPLER: "parentbased_traceidratio",
        OTEL_TRACES_SAMPLER_ARG: String(telemetry.traceSampleRatio),
        OTEL_METRIC_EXPORT_INTERVAL: String(telemetry.metricExportIntervalMs),
        OTEL_RESOURCE_ATTRIBUTES: `axon.cli.version=${encodeURIComponent(BUILD_INFO.version)}`,
      });
      if (!config) return;
      runtime = createOtelRuntime(config, { userId: "managed", source: "axon_auth" }, undefined, {
        quiet: true,
        managed: { endpoint, home: paths.home },
      });
      const current = runtime;
      stop = subscribeProductEvents((event) =>
        recordProductEvent(current, { ...event, version: event.version ?? BUILD_INFO.version }),
      );
    } catch {
      /* Product telemetry never blocks login, updates or a harness launch. */
    } finally {
      if (!runtime) takeProductEvents();
    }
  })();
  await initialization;
}

export function closeProductTelemetry(): Promise<void> {
  closing ??= (async () => {
    // Initialization can be in flight during command teardown. Do not leave a
    // late-created provider subscribed after the command has already closed.
    await initialization;
    stop?.();
    stop = undefined;
    const current = runtime;
    runtime = undefined;
    initialization = undefined;
    await current?.shutdown().catch(() => {});
  })().finally(() => {
    closing = undefined;
  });
  return closing;
}

export async function flushProductTelemetry(paths: AxonPaths, offline = false): Promise<void> {
  if (offline || decision?.offline) {
    takeProductEvents();
    await closeProductTelemetry();
    return;
  }
  if (!runtime && !hasProductEvents() && !initialization) return;
  try {
    await initializeProductTelemetry(paths);
    await closeProductTelemetry();
  } catch {
    /* Best effort; preserve the command's outcome. */
  } finally {
    initialization = undefined;
    takeProductEvents();
  }
}
