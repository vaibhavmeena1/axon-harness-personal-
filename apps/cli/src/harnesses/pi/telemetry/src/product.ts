import { type Attributes, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { sanitizeProductEvent } from "../../../../telemetry/product-events.ts";
import type { TelemetryRuntime } from "./telemetry-types.ts";

/** Metrics get bounded dimensions; correlation IDs and numeric observations stay off labels. */
export function recordProductEvent(
  runtime: TelemetryRuntime,
  input: unknown,
  contextAttributes: Attributes = {},
): void {
  const event = sanitizeProductEvent(input);
  if (!event) return;
  const dimensions: Attributes = {
    component: "cli",
    stage: event.stage,
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.rank !== undefined ? { selected_rank: event.rank } : {}),
    ...(event.policyVersion ? { policy_version: event.policyVersion } : {}),
    ...(event.version ? { deputydev_cli_version: event.version } : {}),
  };
  const prefix = `deputydev.${event.category}`;
  runtime.metrics.count(`${prefix}.events`, 1, dimensions, "{event}");
  if (event.durationMs !== undefined)
    runtime.metrics.record(`${prefix}.duration`, event.durationMs / 1000, "s", dimensions);
  if (event.bytes !== undefined)
    runtime.metrics.record(`${prefix}.transfer`, event.bytes, "By", dimensions);
  for (const key of [
    "complexity",
    "confidence",
    "highComplexityProbability",
    "needsDeepReasoning",
    "prioritizesSpeed",
    "candidateCount",
  ] as const) {
    if (event[key] !== undefined)
      runtime.metrics.record(
        `${prefix}.${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`,
        event[key],
        "1",
        {
          component: "cli",
          stage: event.stage,
          ...(event.policyVersion ? { policy_version: event.policyVersion } : {}),
        },
      );
  }
  const attributes: Attributes = {
    ...runtime.commonAttributes,
    ...contextAttributes,
    ...dimensions,
  };
  if (event.previousModel) attributes["deputydev.model.previous"] = event.previousModel;
  if (event.recommendationId) attributes["deputydev.recommendation.id"] = event.recommendationId;
  for (const key of [
    "complexity",
    "confidence",
    "highComplexityProbability",
    "needsDeepReasoning",
    "prioritizesSpeed",
    "candidateCount",
    "bytes",
  ] as const) {
    if (event[key] !== undefined) attributes[`deputydev.${key}`] = event[key];
  }
  const endedAt = Date.now();
  const span = runtime.tracer.startSpan(
    `${prefix}.${event.stage}`,
    {
      attributes,
      startTime: endedAt - (event.durationMs ?? 0),
    },
    ROOT_CONTEXT,
  );
  if (event.outcome === "failed") span.setStatus({ code: SpanStatusCode.ERROR });
  runtime.logs.emit(
    event.outcome === "failed" ? "warn" : "info",
    `${prefix}.${event.stage}`,
    "DeputyDev product operation observed",
    attributes,
    trace.setSpan(ROOT_CONTEXT, span),
  );
  span.end(endedAt);
}
