import { test } from "bun:test";
import assert from "node:assert/strict";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { AgentTelemetryTracker } from "../src/tracker.ts";
import { createTestRuntime } from "./helpers.ts";

function setup() {
  let now = 1000;
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime, () => now);
  tracker.startSession({
    sessionId: "real-session",
    project: "project",
    cwd: "/work/project",
    mode: "print",
    reason: "startup",
    ephemeral: true,
    repoSlug: "host/org/repo",
  });
  tracker.startRun(); // Custom-message fallback, no invented prompt metadata.
  return {
    fixture,
    tracker,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("canonical kinds, two-depth and parallel tool hierarchy; direct failed attempts counted once", async () => {
  const { tracker, fixture, advance } = setup();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "openai", model: "Exact/Model:V1" });
  advance(100);
  tracker.endLlm({
    stopReason: "error",
    errorMessage: 'token="secret words" failed in /work/project/private',
  });
  tracker.startLlm({ provider: "google", model: "gemini", operation: "generate_content" });
  tracker.endLlm({ stopReason: "stop" });
  tracker.startTool("a", "parent", {});
  tracker.startTool("a/1", "child", {}, { parentToolCallId: "a" });
  tracker.startTool("a/1/1", "grandchild", {}, { parentToolCallId: "a/1" });
  tracker.startTool("a/2", "sibling", {}, { parentToolCallId: "a" });
  tracker.startTool("b", "parallel", {});
  tracker.endTool("a/1/1", true, new Error("failed"));
  tracker.endTool("a/1", false);
  tracker.endTool("a/2", false);
  tracker.endTool("a", true, new Error("failed"));
  tracker.endTool("b", false);
  advance(300);
  tracker.endTurn("ok", { stopReason: "stop" });
  tracker.endRun("stop");
  tracker.endInteraction();
  tracker.endInteraction();
  const spans = fixture.spans();
  const invoke = spans.find((s) => s.name === "invoke_agent pi");
  assert.equal(invoke?.kind, SpanKind.INTERNAL);
  assert.equal(invoke?.attributes["gen_ai.request.model"], undefined);
  assert.equal(invoke?.attributes["pi.prompt.length"], undefined);
  assert.equal(invoke?.attributes["gen_ai.conversation.id"], "real-session");
  assert.equal(spans.find((s) => s.name === "chat Exact/Model:V1")?.kind, SpanKind.CLIENT);
  assert.equal(
    spans.find((s) => s.name === "generate_content gemini")?.attributes["gen_ai.operation.name"],
    "generate_content",
  );
  const tools = new Map(
    spans
      .filter((s) => s.name.startsWith("execute_tool "))
      .map((s) => [s.attributes["gen_ai.tool.call.id"], s]),
  );
  assert.equal(tools.size, 5);
  assert.equal(tools.get("a/1")?.parentSpanContext?.spanId, tools.get("a")?.spanContext().spanId);
  assert.equal(tools.get("a/2")?.parentSpanContext?.spanId, tools.get("a")?.spanContext().spanId);
  assert.equal(
    tools.get("a/1/1")?.parentSpanContext?.spanId,
    tools.get("a/1")?.spanContext().spanId,
  );
  assert.ok([...tools.values()].every((s) => s.kind === SpanKind.INTERNAL));
  for (const [name, value] of [
    ["duration", 0.4],
    ["inference_calls", 2],
    ["tool_calls", 2],
  ] as const) {
    const metrics = fixture.metrics.filter((m) => m.name === `gen_ai.invoke_agent.${name}`);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0]?.value, value);
    assert.equal(metrics[0]?.attributes["gen_ai.request.model"], undefined);
  }
  for (const m of fixture.metrics.filter((m) => m.name.startsWith("gen_ai."))) {
    for (const key of [
      "session.id",
      "gen_ai.conversation.id",
      "gen_ai.tool.call.id",
      "pi.repo.slug",
      "pi.provider.request_id",
      "exception.message",
    ])
      assert.equal(m.attributes[key], undefined);
  }
  const exception = fixture.logs.find((l) => l.eventName === "gen_ai.client.operation.exception");
  assert.equal(exception?.severity, "warn");
  assert.equal(exception?.attributes["exception.type"], "Error");
  assert.doesNotMatch(String(exception?.attributes["exception.message"]), /secret|\/work\/project/);
  await fixture.runtime.shutdown();
});

test("zero-call invocation, orphan closure, repeated session finalization are idempotent and not exceptions", async () => {
  const { tracker, fixture } = setup();
  tracker.startTool("orphan", "read", {});
  tracker.startWait("confirm");
  tracker.endRun("stop");
  tracker.endInteraction();
  tracker.startRun();
  tracker.endRun("aborted");
  tracker.endInteraction();
  tracker.endSession("quit");
  tracker.endSession("quit");
  assert.equal(fixture.metrics.filter((m) => m.name === "pi.session.ended").length, 1);
  assert.deepEqual(
    fixture.metrics
      .filter((m) => m.name === "gen_ai.invoke_agent.inference_calls")
      .map((m) => m.value),
    [0, 0],
  );
  assert.deepEqual(
    fixture.metrics.filter((m) => m.name === "gen_ai.invoke_agent.tool_calls").map((m) => m.value),
    [1, 0],
  );
  assert.ok(fixture.spans().every((s) => s.ended && s.status.code !== SpanStatusCode.ERROR));
  assert.ok(
    !fixture.logs.some((l) => l.eventName.includes("exception") || l.eventName === "pi.tool.error"),
  );
  await fixture.runtime.shutdown();
});

test("Pi normalized input/cache totals and reasoning subset; custom accounting remains disjoint", async () => {
  const { tracker, fixture } = setup();
  const usages = [
    { input: 60, cacheRead: 30, cacheWrite: 10, output: 20, reasoning: 5, cost: 0.1 }, // OpenAI normalization
    { input: 70, cacheRead: 30, output: 20, reasoning: 5 }, // Google output includes thinking
    { input: 60, cacheWrite: 40, output: 20 }, // Anthropic separate cache write
    { cacheRead: 100, output: 20 },
  ];
  for (const usage of usages) {
    tracker.startLlm({ provider: "fixture", model: "exact-model" });
    tracker.endLlm({ stopReason: "stop", usage });
  }
  for (const span of fixture.spans().filter((s) => s.kind === SpanKind.CLIENT)) {
    assert.equal(span.attributes["gen_ai.usage.input_tokens"], 100);
    assert.equal(span.attributes["gen_ai.usage.output_tokens"], 20);
    assert.equal(span.attributes["gen_ai.response.model"], undefined);
    assert.equal(span.attributes["gen_ai.response.id"], undefined);
    assert.equal(span.attributes["gen_ai.usage.cache_read_input_tokens"], undefined);
  }
  const first = fixture.spans().find((s) => s.kind === SpanKind.CLIENT);
  assert.equal(first?.attributes["gen_ai.usage.cache_read.input_tokens"], 30);
  assert.equal(first?.attributes["gen_ai.usage.cache_write.input_tokens"], 10);
  assert.equal(first?.attributes["gen_ai.usage.reasoning.output_tokens"], 5);
  const sum = (name: string) =>
    fixture.metrics.filter((m) => m.name === name).reduce((n, m) => n + m.value, 0);
  assert.equal(
    sum("pi.tokens.input") + sum("pi.tokens.cache_read") + sum("pi.tokens.cache_write"),
    400,
  );
  assert.equal(sum("pi.tokens.output"), 80);
  assert.equal(sum("pi.cost"), 0.1);
  await fixture.runtime.shutdown();
});

test("abnormal and missing finishes do not turn cancellation or telemetry cleanup into provider failures", async () => {
  for (const reason of ["aborted", "interrupted", "incomplete", "superseded", undefined]) {
    const { tracker, fixture } = setup();
    tracker.startLlm({ provider: "openai", model: "model" });
    tracker.endLlm(reason ? { stopReason: reason } : {});
    tracker.startCompaction({ reason: "threshold", willRetry: false });
    tracker.startCompaction({ reason: "threshold", willRetry: false });
    tracker.endCompaction({ outcome: "aborted", error: new Error("Cancelled") });
    tracker.endSession("quit");
    const llm = fixture.spans().find((s) => s.kind === SpanKind.CLIENT);
    assert.deepEqual(llm?.attributes["gen_ai.response.finish_reasons"], ["error"]);
    assert.equal(llm?.attributes["error.type"], undefined);
    assert.equal(llm?.status.code, SpanStatusCode.UNSET);
    assert.ok(!fixture.metrics.some((m) => m.name === "pi.llm.errors"));
    assert.ok(!fixture.logs.some((l) => l.eventName === "gen_ai.client.operation.exception"));
    assert.ok(
      fixture
        .spans()
        .filter((s) => s.name === "pi.session.compaction")
        .every((s) => s.status.code === SpanStatusCode.UNSET),
    );
    await fixture.runtime.shutdown();
  }
});
