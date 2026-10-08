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
import { resolveAxonPaths } from "../../../../../product/paths.ts";

const MAX_RESPONSE_BYTES = 65536;
const RETRYABLE = new Set([429, 502, 503, 504]);

async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted();
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES)
    throw new Error("Managed telemetry response too large");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("Managed telemetry response too large");
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
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
    this.paths = resolveAxonPaths({ AXON_HOME: home });
  }

  async send(data: Uint8Array, timeoutMillis: number): Promise<ExportResponse> {
    const deadline = Date.now() + timeoutMillis;
    const signal = AbortSignal.any([
      this.stop.signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMillis))),
    ]);
    let abort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      return await Promise.race([
        this.sendOperation(data, deadline, signal),
        new Promise<ExportResponse>((resolve) => {
          abort = () =>
            resolve({ status: "failure", error: new Error("Managed telemetry export failed") });
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } catch {
      return { status: "failure", error: new Error("Managed telemetry export failed") };
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }

  private async sendOperation(
    data: Uint8Array,
    deadline: number,
    signal: AbortSignal,
  ): Promise<ExportResponse> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const session = await loadEncryptedSession(this.paths);
        signal.throwIfAborted();
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
            await refreshEncryptedSession(this.paths, session, refreshed, signal).catch(
              () => false,
            );
          }
          if (response.status === 200) {
            return { status: "success", data: await boundedBody(response, signal) };
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
          void response.body?.cancel().catch(() => {});
          await sleep(delay, undefined, { signal });
        } finally {
          void response.body?.cancel().catch(() => {});
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

export interface ManagedDestinationOptions {
  readonly endpoint: string;
  readonly home: string;
}

function managedDestination(
  signal: string,
  options?: ManagedDestinationOptions,
): { url: string; home: string } | undefined {
  const endpoint = options?.endpoint ?? process.env["PI_ORG_OTEL_MANAGED_ENDPOINT"];
  const home = options?.home ?? process.env["PI_ORG_OTEL_MANAGED_HOME"];
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
  registerAbort?: (abort: () => void) => void,
  options?: ManagedDestinationOptions,
): OTLPExporterBase<Internal> | undefined {
  const destination = managedDestination(signal, options);
  if (!destination) return undefined;
  const metrics = new ExporterMetrics({
    componentType: "otlp_http",
    metricsHelper,
    url: destination.url,
    meterProvider: undefined,
    responseAttributesFromError: () => ({}),
  });
  const transport = new ManagedOtlpTransport(destination.url, destination.home);
  registerAbort?.(() => transport.shutdown());
  return new OTLPExporterBase(
    createOtlpNetworkExportDelegate(
      { timeoutMillis, concurrencyLimit: 2, compression: "none" },
      serializer,
      metrics,
      transport,
    ),
  );
}

export function managedTraceExporter(
  timeout: number,
  registerAbort?: (abort: () => void) => void,
  options?: ManagedDestinationOptions,
): OTLPExporterBase<ReadableSpan[]> | undefined {
  return exporter(
    "traces",
    ProtobufTraceSerializer,
    TraceExporterMetricsHelper,
    timeout,
    registerAbort,
    options,
  );
}

export function managedMetricExporter(
  timeout: number,
  registerAbort?: (abort: () => void) => void,
  options?: ManagedDestinationOptions,
): OTLPExporterBase<ResourceMetrics> | undefined {
  return exporter(
    "metrics",
    ProtobufMetricsSerializer,
    MetricsExporterMetricsHelper,
    timeout,
    registerAbort,
    options,
  );
}

export function managedLogExporter(
  timeout: number,
  registerAbort?: (abort: () => void) => void,
  options?: ManagedDestinationOptions,
): OTLPExporterBase<ReadableLogRecord[]> | undefined {
  return exporter(
    "logs",
    ProtobufLogsSerializer,
    LogsExporterMetricsHelper,
    timeout,
    registerAbort,
    options,
  );
}
