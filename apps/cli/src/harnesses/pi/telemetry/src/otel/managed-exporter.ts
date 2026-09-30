import { isAbsolute } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  createOtlpNetworkExportDelegate,
  ExporterMetrics,
  type ExportResponse,
  type IExporterTransport,
  OTLPExporterBase,
} from "@opentelemetry/otlp-exporter-base";
import {
  type IExporterMetricsHelper,
  type ISerializer,
  LogsExporterMetricsHelper,
  MetricsExporterMetricsHelper,
  ProtobufLogsSerializer,
  ProtobufMetricsSerializer,
  ProtobufTraceSerializer,
  TraceExporterMetricsHelper,
} from "@opentelemetry/otlp-transformer";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import type { ResourceMetrics } from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";

import { loadEncryptedSession, refreshEncryptedSession } from "../../../../../cli/auth/session.ts";
import { resolveDeputyDevPaths } from "../../../../../product/paths.ts";

const MAX_RESPONSE_BYTES = 65536;
const RETRYABLE = new Set([429, 502, 503, 504]);

async function boundedBody(response: Response): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
    throw new Error("Managed telemetry response too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Managed telemetry response too large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Fixed destination, live session reads, CAS rotation, bounded retries, no credential diagnostics. */
export class ManagedOtlpTransport implements IExporterTransport {
  private readonly stop = new AbortController();
  private readonly paths;

  constructor(
    private readonly url: string,
    home: string,
  ) {
    this.paths = resolveDeputyDevPaths({ DEPUTYDEV_HOME: home });
  }

  async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    const deadline = Date.now() + timeoutMillis;
    const signal = AbortSignal.any([
      this.stop.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMillis))),
    ]);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const session = await loadEncryptedSession(this.paths);
        if (!session) throw new Error("Missing managed session");
        const response = await fetch(this.url, {
          method: "POST",
          headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/x-protobuf" },
          body: Buffer.from(data),
          redirect: "error",
          cache: "no-store",
          signal,
        });
        try {
          // Only our trusted backend is contacted. A stale batch cannot overwrite a new login.
          const refreshed = response.headers.get("x-session-refresh-token");
          if (refreshed && refreshed.length <= 16384 && /^[\x21-\x7e]+$/.test(refreshed)) {
            await refreshEncryptedSession(this.paths, session, refreshed).catch(() => false);
          }
          if (response.status === 200) {
            return { status: "success", data: await boundedBody(response) };
          }
          if (!RETRYABLE.has(response.status) || attempt === 2) {
            return {
              status: "failure",
              error: new Error(`Managed telemetry returned HTTP ${response.status}`),
            };
          }
          const retryHeader = response.headers.get("retry-after");
          let delay = 250 * 2 ** attempt;
          if (retryHeader !== null) {
            const seconds = Number(retryHeader);
            delay = Number.isFinite(seconds)
              ? Math.max(0, seconds * 1000)
              : Math.max(0, Date.parse(retryHeader) - Date.now());
            if (!Number.isFinite(delay)) delay = 250 * 2 ** attempt;
          }
          if (delay >= deadline - Date.now())
            return {
              status: "failure",
              error: new Error("Managed telemetry retry exceeds deadline"),
            };
          await response.body?.cancel().catch(() => {});
          await sleep(delay, undefined, { signal });
        } finally {
          await response.body?.cancel().catch(() => {});
        }
      }
    } catch {
      // Underlying fetch/filesystem errors can contain credentials or private paths.
      return { status: "failure", error: new Error("Managed telemetry export failed") };
    }
    return { status: "failure", error: new Error("Managed telemetry export failed") };
  }

  shutdown(): void {
    this.stop.abort();
  }
}

function managedDestination(signal: string): { url: string; home: string } | undefined {
  const endpoint = process.env.PI_ORG_OTEL_MANAGED_ENDPOINT;
  const home = process.env.PI_ORG_OTEL_MANAGED_HOME;
  if (!endpoint && !home) return undefined;
  if (!endpoint || !home || !isAbsolute(home))
    throw new Error("Invalid managed telemetry configuration");
  const url = new URL(endpoint);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.pathname !== "/api/v1/otel" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid managed telemetry destination");
  return { url: `${endpoint}/v1/${signal}`, home };
}

function exporter<Internal, Result>(
  signal: string,
  serializer: ISerializer<Internal, Result>,
  metricsHelper: IExporterMetricsHelper<Internal>,
  timeoutMillis: number,
): OTLPExporterBase<Internal> | undefined {
  const destination = managedDestination(signal);
  if (!destination) return undefined;
  const metrics = new ExporterMetrics({
    componentType: "otlp_http",
    metricsHelper,
    url: destination.url,
    meterProvider: undefined,
    responseAttributesFromError: () => ({}),
  });
  return new OTLPExporterBase(
    createOtlpNetworkExportDelegate(
      { timeoutMillis, concurrencyLimit: 2, compression: "none" },
      serializer,
      metrics,
      new ManagedOtlpTransport(destination.url, destination.home),
    ),
  );
}

export function managedTraceExporter(
  timeout: number,
): OTLPExporterBase<ReadableSpan[]> | undefined {
  return exporter("traces", ProtobufTraceSerializer, TraceExporterMetricsHelper, timeout);
}

export function managedMetricExporter(
  timeout: number,
): OTLPExporterBase<ResourceMetrics> | undefined {
  return exporter("metrics", ProtobufMetricsSerializer, MetricsExporterMetricsHelper, timeout);
}

export function managedLogExporter(
  timeout: number,
): OTLPExporterBase<ReadableLogRecord[]> | undefined {
  return exporter("logs", ProtobufLogsSerializer, LogsExporterMetricsHelper, timeout);
}
