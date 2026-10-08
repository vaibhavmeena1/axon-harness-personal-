import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  AggregationTemporality,
  DataPointType,
  MeterProvider,
  MetricReader,
} from "@opentelemetry/sdk-metrics";
import { GEN_AI_HISTOGRAMS } from "../src/otel/instruments.ts";
import { PRODUCT_HISTOGRAMS } from "../src/otel/product-instruments.ts";
import { OtelMetricSink } from "../src/otel/runtime.ts";

class Reader extends MetricReader {
  protected async onShutdown() {}
  protected async onForceFlush() {}
}

test("actual SDK histograms honor all standard units, boundaries, zero counts and safe dimensions", async () => {
  const reader = new Reader();
  const provider = new MeterProvider({ readers: [reader] });
  const sink = new OtelMetricSink(provider.getMeter("test"), { "user.id": "fixture" });
  for (const [name, definition] of Object.entries(GEN_AI_HISTOGRAMS)) {
    sink.record(name, 0, "ignored", {
      "gen_ai.operation.name": "fixture",
      "session.id": "private-id",
      "pi.repo.slug": "private/repo",
      "exception.message": "secret",
      "pi.command.summary": "private",
    });
    sink.record(name, 2, definition.unit, { "gen_ai.operation.name": "fixture" });
  }
  const { resourceMetrics, errors } = await reader.collect();
  assert.equal(errors.length, 0);
  const metrics = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
  assert.equal(metrics.length, 5);
  for (const metric of metrics) {
    assert.equal(metric.dataPointType, DataPointType.HISTOGRAM);
    if (metric.dataPointType !== DataPointType.HISTOGRAM) throw new Error("not a histogram");
    const definition = GEN_AI_HISTOGRAMS[metric.descriptor.name];
    assert.ok(definition);
    assert.equal(metric.descriptor.unit, definition.unit);
    assert.equal(metric.dataPoints.length, 1);
    const point = metric.dataPoints[0];
    assert.ok(point);
    assert.deepEqual(point.value.buckets.boundaries, definition.boundaries);
    assert.equal(point.value.count, 2);
    assert.equal(point.value.sum, 2);
    assert.equal(
      point.value.buckets.counts.reduce((n, count) => n + count, 0),
      2,
    );
    assert.deepEqual(point.attributes, {
      "user.id": "fixture",
      "gen_ai.operation.name": "fixture",
    });
  }
  await provider.shutdown();
});

test("product SDK instruments preserve cumulative counts, declared histogram units and safe dimensions", async () => {
  const reader = new Reader();
  const provider = new MeterProvider({ readers: [reader] });
  const sink = new OtelMetricSink(provider.getMeter("products"), { "user.id": "fixture" });
  try {
    sink.count("axon.backup.events", 1, { component: "cli", stage: "upload" }, "{event}");
    for (const [name, definition] of Object.entries(PRODUCT_HISTOGRAMS)) {
      sink.record(name, 0, "ignored", {
        component: "cli",
        stage: "request",
        policy_version: "fixture-policy",
        "session.id": "private-id",
        "axon.recommendation.id": "private-id",
        "pi.repo.slug": "private/repo",
        prompt: "secret",
      });
      sink.record(name, 2, definition.unit, {
        component: "cli",
        stage: "request",
        policy_version: "fixture-policy",
      });
    }
    const { resourceMetrics, errors } = await reader.collect();
    assert.equal(errors.length, 0);
    const metrics = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    assert.equal(metrics.length, Object.keys(PRODUCT_HISTOGRAMS).length + 1);
    for (const metric of metrics) {
      if (metric.descriptor.name === "axon.backup.events") {
        assert.equal(metric.descriptor.unit, "{event}");
        assert.equal(metric.dataPointType, DataPointType.SUM);
        assert.equal(metric.aggregationTemporality, AggregationTemporality.CUMULATIVE);
        assert.equal(metric.dataPoints[0]?.value, 1);
        continue;
      }
      assert.equal(metric.dataPointType, DataPointType.HISTOGRAM);
      if (metric.dataPointType !== DataPointType.HISTOGRAM) throw new Error("not a histogram");
      const definition = PRODUCT_HISTOGRAMS[metric.descriptor.name];
      assert.ok(definition);
      assert.equal(metric.descriptor.unit, definition.unit);
      assert.equal(metric.dataPoints.length, 1);
      const point = metric.dataPoints[0];
      assert.ok(point);
      assert.deepEqual(point.value.buckets.boundaries, definition.boundaries);
      assert.equal(point.value.count, 2);
      assert.equal(point.value.sum, 2);
      assert.deepEqual(point.attributes, {
        "user.id": "fixture",
        component: "cli",
        stage: "request",
        policy_version: "fixture-policy",
      });
    }
    sink.count("axon.backup.events", 1, { component: "cli", stage: "upload" });
    const second = (await reader.collect()).resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "axon.backup.events");
    assert.equal(second?.dataPoints[0]?.value, 2);
  } finally {
    await provider.shutdown();
  }
});

test("SDK cardinality limit preserves totals through overflow rather than creating unlimited series", async () => {
  const reader = new Reader({ cardinalitySelector: () => 3 });
  const provider = new MeterProvider({ readers: [reader] });
  const sink = new OtelMetricSink(provider.getMeter("overflow"), {});
  for (let i = 0; i < 20; i++)
    sink.record("gen_ai.execute_tool.duration", 1, "s", { "gen_ai.tool.name": `tool-${i}` });
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)[0];
  assert.ok(metric && metric.dataPointType === DataPointType.HISTOGRAM);
  assert.ok(metric.dataPoints.length <= 3);
  assert.equal(
    metric.dataPoints.reduce((n, p) => n + p.value.count, 0),
    20,
  );
  assert.ok(metric.dataPoints.some((p) => p.attributes["otel.metric.overflow"] === true));
  await provider.shutdown();
});
