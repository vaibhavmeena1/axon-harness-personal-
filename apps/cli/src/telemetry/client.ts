import { BUILD_INFO } from "../build-info.ts";
import { loadEncryptedSession, refreshEncryptedSession } from "../cli/auth/session.ts";
import { fetchClientConfig, type TelemetryConfig } from "../cli/client-config.ts";
import { isPiOffline } from "../harnesses/pi/setup/packages/invocation.ts";
import type { TelemetryRuntime } from "../harnesses/pi/telemetry/src/telemetry-types.ts";
import { isTelemetryDisabled } from "../harnesses/pi/telemetry-environment.ts";
import { resolveServiceUrl, SERVICE_ENDPOINTS } from "../product/endpoints.ts";
import type { AxonPaths } from "../product/paths.ts";
import { hasProductEvents, subscribeProductEvents, takeProductEvents } from "./product-events.ts";

let runtime: TelemetryRuntime | undefined;
let stop: (() => void) | undefined;
let initialization: Promise<void> | undefined;
let closing: Promise<void> | undefined;

/** Lazy managed-only telemetry: no SDK, config request or socket until policy allows export. */
export async function initializeProductTelemetry(
  paths: AxonPaths,
  policy?: TelemetryConfig,
  options: { serviceOrigin?: string } = {},
): Promise<void> {
  if (closing) await closing;
  if (isTelemetryDisabled(process.env) || isPiOffline(process.env, [])) {
    takeProductEvents();
    return;
  }
  initialization ??= (async () => {
    try {
      let telemetry = policy;
      if (!telemetry) {
        let session = await loadEncryptedSession(paths);
        if (!session) return;
        const result = await fetchClientConfig(session);
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
        if ((await loadEncryptedSession(paths)) !== session) return;
        telemetry = result.config?.telemetry;
      }
      if (!telemetry?.enabled) return;
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
  if (offline || isTelemetryDisabled(process.env)) {
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
