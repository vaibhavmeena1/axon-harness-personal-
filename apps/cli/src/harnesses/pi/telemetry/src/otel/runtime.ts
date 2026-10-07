import { randomUUID } from "node:crypto";
import type { Attributes, Counter, Histogram } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { type ExportResult, ExportResultCode } from "@opentelemetry/core";
import { OTLPLogExporter as GrpcLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as ProtoLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as GrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as ProtoMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as ProtoTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import {
  type AggregationOption,
  AggregationTemporality,
  AggregationType,
  type InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  type ReadableSpan,
  type SpanExporter,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_HOST_ARCH,
  ATTR_IDENTITY_SOURCE,
  ATTR_OS_TYPE,
  ATTR_PI_VERSION,
  ATTR_RUNTIME_NAME,
  ATTR_RUNTIME_VERSION,
  ATTR_USER_EMAIL,
  ATTR_USER_ID,
  COUNTER_UNITS,
  EXTENSION_NAME,
  INSTRUMENTATION_NAME,
} from "../attributes.ts";
import type { OrgTelemetryConfig } from "../config.ts";
import { describeEnvironment, type ResourceEnvironment } from "../environment.ts";
import type { TelemetryIdentity } from "../identity.ts";
import { sanitizeText } from "../sanitization.ts";
import type { LogSeverity, LogSink, MetricSink, TelemetryRuntime } from "../telemetry-types.ts";
import { GEN_AI_HISTOGRAMS } from "./instruments.ts";
import {
  type ManagedDestinationOptions,
  managedLogExporter,
  managedMetricExporter,
  managedTraceExporter,
} from "./managed-exporter.ts";
import { PRODUCT_HISTOGRAMS } from "./product-instruments.ts";

const SEVERITIES: Record<LogSeverity, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

export interface RuntimeOptions {
  /** Suppress stderr diagnostics entirely (set while pi renders a full-screen TUI). */
  readonly quiet?: boolean;
  readonly now?: () => number;
  readonly managed?: ManagedDestinationOptions;
}

class ExportHealth {
  private metricSink: MetricSink | undefined;
  private lastDiagnosticAt = 0;
  private readonly diagnostics: boolean;
  private readonly now: () => number;

  constructor(diagnostics: boolean, now: () => number = Date.now) {
    this.diagnostics = diagnostics;
    this.now = now;
  }

  attachMetricSink(metricSink: MetricSink): void {
    this.metricSink = metricSink;
  }

  failure(signal: "traces" | "metrics" | "logs", error?: Error): void {
    this.metricSink?.count("pi.telemetry.export_errors", 1, { "otel.signal": signal });
    if (!this.diagnostics || this.now() - this.lastDiagnosticAt < 60_000) return;
    this.lastDiagnosticAt = this.now();
    const cause = error?.message ? `: ${sanitizeText(error.message, process.cwd(), 200)}` : "";
    process.stderr.write(`[pi-org-telemetry] ${signal} export failed${cause}\n`);
  }
}

function reportResult(
  health: ExportHealth,
  signal: "traces" | "metrics" | "logs",
  result: ExportResult,
): void {
  if (result.code !== ExportResultCode.SUCCESS) health.failure(signal, result.error);
}

class ReportingSpanExporter implements SpanExporter {
  private readonly delegate: SpanExporter;
  private readonly health: ExportHealth;

  constructor(delegate: SpanExporter, health: ExportHealth) {
    this.delegate = delegate;
    this.health = health;
  }

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    try {
      this.delegate.export(spans, (result) => {
        reportResult(this.health, "traces", result);
        callback(result);
      });
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.health.failure("traces", normalized);
      callback({ code: ExportResultCode.FAILED, error: normalized });
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

class ReportingLogExporter implements LogRecordExporter {
  private readonly delegate: LogRecordExporter;
  private readonly health: ExportHealth;

  constructor(delegate: LogRecordExporter, health: ExportHealth) {
    this.delegate = delegate;
    this.health = health;
  }

  export(records: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    try {
      this.delegate.export(records, (result) => {
        reportResult(this.health, "logs", result);
        callback(result);
      });
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.health.failure("logs", normalized);
      callback({ code: ExportResultCode.FAILED, error: normalized });
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}

class ReportingMetricExporter implements PushMetricExporter {
  private readonly delegate: PushMetricExporter;
  private readonly health: ExportHealth;

  constructor(delegate: PushMetricExporter, health: ExportHealth) {
    this.delegate = delegate;
    this.health = health;
  }

  export(metrics: ResourceMetrics, callback: (result: ExportResult) => void): void {
    try {
      this.delegate.export(metrics, (result) => {
        reportResult(this.health, "metrics", result);
        callback(result);
      });
    } catch (error: unknown) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.health.failure("metrics", normalized);
      callback({ code: ExportResultCode.FAILED, error: normalized });
    }
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  selectAggregation(instrumentType: InstrumentType): AggregationOption {
    return this.delegate.selectAggregation?.(instrumentType) ?? { type: AggregationType.DEFAULT };
  }

  selectAggregationTemporality(instrumentType: InstrumentType): AggregationTemporality {
    return (
      this.delegate.selectAggregationTemporality?.(instrumentType) ??
      AggregationTemporality.CUMULATIVE
    );
  }
}

export class OtelMetricSink implements MetricSink {
  private readonly counters = new Map<string, Counter>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly meter: ReturnType<MeterProvider["getMeter"]>;
  private readonly commonAttributes: Attributes;

  constructor(meter: ReturnType<MeterProvider["getMeter"]>, commonAttributes: Attributes) {
    this.meter = meter;
    this.commonAttributes = commonAttributes;
  }

  count(name: string, value = 1, attributes: Attributes = {}, unit?: string): void {
    let counter = this.counters.get(name);
    if (!counter) {
      const resolvedUnit = unit ?? COUNTER_UNITS[name];
      counter = this.meter.createCounter(name, resolvedUnit ? { unit: resolvedUnit } : undefined);
      this.counters.set(name, counter);
    }
    counter.add(value, { ...this.commonAttributes, ...attributes });
  }

  record(name: string, value: number, unit: string, attributes: Attributes = {}): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      const definition = GEN_AI_HISTOGRAMS[name] ?? PRODUCT_HISTOGRAMS[name];
      histogram = this.meter.createHistogram(name, {
        unit: definition?.unit ?? unit,
        ...(definition ? { advice: { explicitBucketBoundaries: definition.boundaries } } : {}),
      });
      this.histograms.set(name, histogram);
    }
    const definition = GEN_AI_HISTOGRAMS[name] ?? PRODUCT_HISTOGRAMS[name];
    const dimensions = definition
      ? Object.fromEntries(
          Object.entries(attributes).filter(([key]) => definition.dimensions.includes(key)),
        )
      : attributes;
    histogram.record(value, { ...this.commonAttributes, ...dimensions });
  }
}

function createTraceExporter(
  config: OrgTelemetryConfig,
  registerAbort: (abort: () => void) => void,
  managed?: ManagedDestinationOptions,
): SpanExporter {
  return (
    managedTraceExporter(config.exportTimeoutMs, registerAbort, managed) ??
    ((config.signalProtocols?.traces ?? config.protocol) === "grpc"
      ? new GrpcTraceExporter({ timeoutMillis: config.exportTimeoutMs })
      : new ProtoTraceExporter({ timeoutMillis: config.exportTimeoutMs }))
  );
}

function createMetricExporter(
  config: OrgTelemetryConfig,
  registerAbort: (abort: () => void) => void,
  managed?: ManagedDestinationOptions,
): PushMetricExporter {
  return (
    managedMetricExporter(config.exportTimeoutMs, registerAbort, managed) ??
    ((config.signalProtocols?.metrics ?? config.protocol) === "grpc"
      ? new GrpcMetricExporter({ timeoutMillis: config.exportTimeoutMs })
      : new ProtoMetricExporter({ timeoutMillis: config.exportTimeoutMs }))
  );
}

function createLogExporter(
  config: OrgTelemetryConfig,
  registerAbort: (abort: () => void) => void,
  managed?: ManagedDestinationOptions,
): LogRecordExporter {
  return (
    managedLogExporter(config.exportTimeoutMs, registerAbort, managed) ??
    ((config.signalProtocols?.logs ?? config.protocol) === "grpc"
      ? new GrpcLogExporter({ timeoutMillis: config.exportTimeoutMs })
      : new ProtoLogExporter({ timeoutMillis: config.exportTimeoutMs }))
  );
}

async function waitBounded(
  operation: Promise<unknown>,
  timeoutMs: number,
  onDeadline: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          onDeadline();
          resolve();
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createOtelRuntime(
  config: OrgTelemetryConfig,
  identity: TelemetryIdentity,
  environment: ResourceEnvironment = describeEnvironment(),
  options: RuntimeOptions = {},
): TelemetryRuntime {
  const commonAttributes: Attributes = {
    [ATTR_USER_ID]: identity.userId,
    [ATTR_IDENTITY_SOURCE]: identity.source,
    ...(identity.email ? { [ATTR_USER_EMAIL]: identity.email } : {}),
  };
  const resource = defaultResource().merge(
    resourceFromAttributes({
      ...config.resourceAttributes,
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: environment.extensionVersion,
      [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${randomUUID()}`,
      [ATTR_USER_ID]: identity.userId,
      [ATTR_IDENTITY_SOURCE]: identity.source,
      ...(identity.email ? { [ATTR_USER_EMAIL]: identity.email } : {}),
      "pi.extension.name": EXTENSION_NAME,
      "pi.extension.version": environment.extensionVersion,
      ...(environment.piVersion ? { [ATTR_PI_VERSION]: environment.piVersion } : {}),
      ...(environment.cliVersion ? { "deputydev.cli.version": environment.cliVersion } : {}),
      [ATTR_OS_TYPE]: environment.osType,
      [ATTR_HOST_ARCH]: environment.hostArch,
      [ATTR_RUNTIME_NAME]: environment.runtimeName,
      [ATTR_RUNTIME_VERSION]: environment.runtimeVersion,
    }),
  );
  const health = new ExportHealth(config.diagnostics && !options.quiet, options.now);

  // Managed transports expose cooperative cancellation. Environment SDK exporters do not:
  // the shutdown deadline bounds waiting, not their already in-flight HTTP/gRPC work.
  const aborts: Array<() => void> = [];
  const registerAbort = (abort: () => void): void => {
    aborts.push(abort);
  };
  let shutdownPromise: Promise<void> | undefined;
  const metricExporter = new ReportingMetricExporter(
    createMetricExporter(config, registerAbort, options.managed),
    health,
  );
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: config.metricExportIntervalMs,
    // The SDK rejects a timeout longer than the interval; the interval may be as low as 1s.
    exportTimeoutMillis: Math.min(config.exportTimeoutMs, config.metricExportIntervalMs),
    cardinalityLimits: { default: 2_000 },
    maxExportBatchSize: config.maxExportBatchSize,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  const metrics = new OtelMetricSink(
    meterProvider.getMeter(INSTRUMENTATION_NAME, environment.extensionVersion),
    commonAttributes,
  );
  health.attachMetricSink(metrics);

  const spanProcessor = new BatchSpanProcessor({
    exporter: new ReportingSpanExporter(
      createTraceExporter(config, registerAbort, options.managed),
      health,
    ),
    maxQueueSize: config.maxQueueSize,
    maxExportBatchSize: config.maxExportBatchSize,
    scheduledDelayMillis: config.scheduledDelayMs,
    exportTimeoutMillis: config.exportTimeoutMs,
    selfObsMeterProvider: meterProvider,
  });
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(config.sampleRatio),
  });
  const tracerProvider = new TracerProvider({
    resource,
    sampler,
    spanProcessors: [spanProcessor],
    meterProvider,
    spanLimits: { attributeValueLengthLimit: 512, attributeCountLimit: 64, eventCountLimit: 64 },
  });

  const logProcessor = new BatchLogRecordProcessor({
    exporter: new ReportingLogExporter(
      createLogExporter(config, registerAbort, options.managed),
      health,
    ),
    maxQueueSize: config.maxQueueSize,
    maxExportBatchSize: config.maxExportBatchSize,
    scheduledDelayMillis: config.scheduledDelayMs,
    exportTimeoutMillis: config.exportTimeoutMs,
    selfObsMeterProvider: meterProvider,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [logProcessor],
    meterProvider,
    logRecordLimits: { attributeValueLengthLimit: 512, attributeCountLimit: 64 },
  });
  const logger = loggerProvider.getLogger(INSTRUMENTATION_NAME, environment.extensionVersion);
  const logs: LogSink = {
    emit(severity, eventName, body, attributes = {}, context) {
      try {
        logger.emit({
          eventName,
          severityNumber: SEVERITIES[severity],
          severityText: severity.toUpperCase(),
          body,
          attributes: { ...commonAttributes, ...attributes },
          ...(context ? { context } : {}),
        });
      } catch {
        metrics.count("pi.telemetry.dropped", 1, { "otel.signal": "logs", reason: "emit_error" });
      }
    },
  };

  const tracer = tracerProvider.getTracer(INSTRUMENTATION_NAME, environment.extensionVersion);

  return {
    tracer,
    metrics,
    logs,
    commonAttributes,
    shutdown() {
      shutdownPromise ??= waitBounded(
        Promise.allSettled([
          loggerProvider.shutdown(),
          tracerProvider.shutdown(),
          meterProvider.shutdown(),
        ]),
        config.shutdownTimeoutMs,
        () => {
          for (const abort of aborts) abort();
        },
      );
      return shutdownPromise;
    },
  };
}
