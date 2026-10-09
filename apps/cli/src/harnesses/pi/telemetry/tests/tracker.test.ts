import { test } from "bun:test";
import assert from "node:assert/strict";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  SPAN_AGENT_RUN,
  SPAN_COMPACTION,
  SPAN_INTERACTION,
  SPAN_LLM,
  SPAN_TOOL,
  SPAN_TURN,
  SPAN_USER_WAIT,
} from "../src/attributes.ts";
import { AgentTelemetryTracker } from "../src/tracker.ts";
import { createTestRuntime } from "./helpers.ts";

function session() {
  return {
    sessionId: "session-1",
    project: "project",
    mode: "tui",
    reason: "startup",
    ephemeral: false,
    cwd: "/work/project",
  } as const;
}

test("records an attributed interaction tree and operational metrics", async () => {
  let now = 1_000;
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime, () => now);

  tracker.startSession(session());
  tracker.noteInput({ source: "interactive", textLength: 18, imageCount: 0 });
  tracker.startInteraction(18, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({
    provider: "openai",
    model: "gpt-5",
    contextTokens: 1_024,
    contextWindow: 200_000,
    contextPercent: 0.5,
  });
  now += 100;
  tracker.noteProviderResponse({ status: 200, requestId: "request-1" });
  tracker.endLlm({
    provider: "openai",
    model: "gpt-5.1",
    stopReason: "toolUse",
    usage: { input: 100, output: 20, cacheRead: 10, cost: 0.03 },
  });
  tracker.startTool("tool-1", "read", { "pi.path": "src/index.ts" });
  now += 50;
  tracker.endTool("tool-1", false);
  tracker.startWait("confirm");
  now += 25;
  tracker.endWait();
  tracker.endTurn("ok", { provider: "openai", model: "gpt-5.1", stopReason: "stop" }, 1);
  tracker.endRun("stop");
  now += 25;
  tracker.endInteraction();
  tracker.endSession("quit");

  const spans = fixture.spans();
  const byName = new Map(
    spans.map((span) => [
      span.name.startsWith("chat ")
        ? SPAN_LLM
        : span.name.startsWith("execute_tool ")
          ? SPAN_TOOL
          : span.name,
      span,
    ]),
  );
  for (const name of [
    SPAN_INTERACTION,
    SPAN_AGENT_RUN,
    SPAN_TURN,
    SPAN_LLM,
    SPAN_TOOL,
    SPAN_USER_WAIT,
  ]) {
    assert.ok(byName.has(name), `missing ${name}`);
  }

  const interaction = byName.get(SPAN_INTERACTION);
  const run = byName.get(SPAN_AGENT_RUN);
  const turn = byName.get(SPAN_TURN);
  const llm = byName.get(SPAN_LLM);
  const tool = byName.get(SPAN_TOOL);
  assert.ok(interaction && run && turn && llm && tool);
  assert.equal(run.parentSpanContext?.spanId, interaction.spanContext().spanId);
  assert.equal(turn.parentSpanContext?.spanId, run.spanContext().spanId);
  assert.equal(llm.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 110);
  assert.equal(llm.attributes["pi.provider.request_id"], "request-1");
  assert.equal(llm.attributes["gen_ai.response.id"], undefined);
  assert.equal(llm.attributes["pi.context.percent"], 0.5);
  assert.equal(llm.attributes["user.id"], "developer@example.com");
  assert.ok(spans.every((span) => span.attributes["user.id"] === "developer@example.com"));
  assert.ok(
    fixture.metrics.every((metric) => metric.attributes["user.id"] === "developer@example.com"),
  );
  assert.ok(fixture.logs.every((log) => log.attributes["user.id"] === "developer@example.com"));
  assert.ok(
    fixture.metrics.some((metric) => metric.name === "pi.tokens.input" && metric.value === 100),
  );

  await fixture.runtime.shutdown();
});

test("tracks parallel tools and infers repeated agent runs", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  tracker.startInteraction(10, 0);
  tracker.startRun();
  tracker.endRun("error");
  tracker.startRun();
  tracker.startTurn(1);
  tracker.startTool("a", "read", {});
  tracker.startTool("b", "write", {});
  tracker.endTool("b", true, new Error("token=secret failed at /work/project/a.ts"));
  tracker.endTool("a", false);
  tracker.endTurn("ok", { stopReason: "stop" }, 2);
  tracker.endRun("stop");
  tracker.endInteraction();

  const toolSpans = fixture.spans().filter((span) => span.name.startsWith("execute_tool "));
  assert.equal(toolSpans.length, 2);
  assert.equal(
    toolSpans.find((span) => span.attributes["gen_ai.tool.name"] === "write")?.status.code,
    SpanStatusCode.ERROR,
  );
  assert.ok(fixture.metrics.some((metric) => metric.name === "pi.agent.run.repeated"));
  const errorLog = fixture.logs.find((log) => log.eventName === "pi.tool.error");
  assert.ok(errorLog);
  assert.doesNotMatch(String(errorLog.attributes["error.message"]), /secret|\/work\/project/);

  await fixture.runtime.shutdown();
});

test("preserves provider HTTP failures when the assistant has a normal stop reason", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  tracker.startInteraction(4, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "gateway", model: "model" });
  tracker.noteProviderResponse({ status: 503 });
  tracker.endLlm({ stopReason: "stop" });

  const llm = fixture.spans().find((span) => span.name === "chat model");
  assert.equal(llm?.status.code, SpanStatusCode.ERROR);
  assert.equal(llm?.attributes["error.type"], "http_error");
  assert.ok(fixture.metrics.some((metric) => metric.name === "pi.llm.errors"));
  await fixture.runtime.shutdown();
});

test("marks synthesized LLM spans", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  tracker.startInteraction(4, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "custom", model: "model", synthesized: true });
  tracker.endLlm({ stopReason: "stop" });

  const llm = fixture.spans().find((span) => span.name === "pi.assistant.lifecycle");
  assert.equal(llm?.attributes["pi.llm.synthesized"], true);
  await fixture.runtime.shutdown();
});

test("drains orphan wait, tool, llm, and compaction spans on endSession", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  // No interaction is open: these spans fall back to the root context.
  tracker.startWait("confirm");
  tracker.startTool("orphan", "bash", {});
  tracker.startLlm({ provider: "openai", model: "gpt-5" });
  tracker.startCompaction({ reason: "threshold", willRetry: false });
  tracker.endSession("quit");

  const spans = fixture.spans();
  for (const name of [SPAN_USER_WAIT, SPAN_TOOL, SPAN_LLM, SPAN_COMPACTION]) {
    const span = spans.find(
      (candidate) => candidate.name === name || candidate.name.startsWith(`${name} `),
    );
    assert.ok(span, `missing ${name}`);
    assert.ok(span.ended, `${name} was not ended`);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  }
  await fixture.runtime.shutdown();
});

test("counts truncated responses without marking them failed", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  tracker.startInteraction(4, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "openai", model: "gpt-5" });
  tracker.endLlm({ stopReason: "length", usage: { output: 4_096 } });
  tracker.startTool("call-1", "edit", {});
  tracker.endTool("call-1", true, new Error("truncated"));
  tracker.endTurn("ok", { stopReason: "length" }, 1);

  const llm = fixture.spans().find((span) => span.name === "chat gpt-5");
  assert.equal(llm?.status.code, SpanStatusCode.OK);
  assert.equal(llm?.attributes["pi.llm.truncated"], true);
  assert.ok(fixture.metrics.some((metric) => metric.name === "pi.llm.truncated"));
  assert.ok(!fixture.metrics.some((metric) => metric.name === "pi.llm.errors"));
  const tool = fixture.spans().find((span) => span.name === "execute_tool edit");
  assert.equal(tool?.attributes["pi.tool.truncated_call"], true);
  await fixture.runtime.shutdown();
});

test("prefers the message response id over the header request id", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession(session());
  tracker.startInteraction(4, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "anthropic", model: "claude" });
  tracker.noteProviderResponse({ status: 200, requestId: "req_abc" });
  tracker.endLlm({ stopReason: "stop", responseId: "msg_123", providerThinkingLevel: "high" });

  const llm = fixture.spans().find((span) => span.name === "chat claude");
  assert.equal(llm?.attributes["gen_ai.response.id"], "msg_123");
  assert.equal(llm?.attributes["pi.provider.request_id"], "req_abc");
  assert.equal(llm?.attributes["pi.thinking.provider_level"], "high");
  await fixture.runtime.shutdown();
});

test("attributes usage to its source and keeps the repo slug off token metrics", async () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime);
  tracker.startSession({
    ...session(),
    repoSlug: "github.com/acme/backend",
    parentSessionId: "parent-1",
  });
  tracker.startInteraction(4, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "openai", model: "gpt-5" });
  tracker.endLlm({
    stopReason: "stop",
    usage: { input: 10, reasoning: 3, cost: 0.1, costInput: 0.04 },
  });
  tracker.recordAuxiliaryUsage("tool", { input: 5, cost: 0.02 });
  tracker.startCompaction({ reason: "threshold", willRetry: false });
  tracker.endCompaction({ outcome: "ok", usage: { input: 900, output: 100, cost: 0.5 } });
  tracker.endTurn("ok", { stopReason: "stop" }, 0);
  tracker.endRun("stop");
  tracker.endInteraction();

  const tokens = fixture.metrics.filter((metric) => metric.name === "pi.tokens.input");
  assert.deepEqual(
    tokens.map((metric) => [metric.attributes["pi.usage.source"], metric.value]),
    [
      ["assistant", 10],
      ["tool", 5],
      ["compaction", 900],
    ],
  );
  assert.ok(tokens.every((metric) => metric.attributes["pi.repo.slug"] === undefined));
  assert.ok(
    fixture.metrics.some((metric) => metric.name === "pi.tokens.reasoning" && metric.value === 3),
  );
  const interactionMetric = fixture.metrics.find(
    (metric) => metric.name === "pi.interaction.count",
  );
  assert.equal(interactionMetric?.attributes["pi.repo.slug"], "github.com/acme/backend");
  const interaction = fixture.spans().find((span) => span.name === SPAN_INTERACTION);
  assert.equal(interaction?.attributes["pi.repo.slug"], "github.com/acme/backend");
  assert.equal(interaction?.attributes["pi.session.parent_id"], "parent-1");
  const llm = fixture.spans().find((span) => span.name === "chat gpt-5");
  assert.equal(llm?.attributes["pi.cost.input_usd"], 0.04);
  await fixture.runtime.shutdown();
});

test("labels inference and usage with bounded reasoning effort", () => {
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime, () => 1_000);
  tracker.startSession(session());
  tracker.startInteraction(1, 0);
  tracker.startRun();
  tracker.startLlm({ provider: "anthropic", model: "claude-opus-5-5", thinkingLevel: "high" });
  tracker.endLlm({ provider: "anthropic", stopReason: "stop", usage: { output: 5, cost: 0.1 } });
  tracker.startLlm({ provider: "anthropic", model: "claude-opus-5-5", thinkingLevel: "bogus" });
  tracker.endLlm({ provider: "anthropic", stopReason: "stop", usage: { output: 5 } });

  const requests = fixture.metrics.filter((metric) => metric.name === "pi.llm.requests");
  assert.deepEqual(
    requests.map((metric) => metric.attributes["pi.thinking.level"]),
    ["high", "other"],
  );
  const cost = fixture.metrics.find((metric) => metric.name === "pi.cost");
  assert.equal(cost?.attributes["pi.thinking.level"], "high");
  assert.equal(cost?.attributes["pi.usage.source"], "assistant");
});

test("exports per-session totals as a summary span, log, and histograms", () => {
  let now = 10_000;
  const fixture = createTestRuntime();
  const tracker = new AgentTelemetryTracker(fixture.runtime, () => now);
  tracker.startSession({ ...session(), repoSlug: "github.com/acme/app" });
  tracker.startInteraction(1, 0);
  tracker.startRun();
  tracker.startTurn(0);
  tracker.startLlm({ provider: "openai", model: "gpt-5" });
  tracker.endLlm({
    provider: "openai",
    stopReason: "toolUse",
    usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, reasoning: 5, cost: 0.25 },
  });
  tracker.startTool("tool-1", "read", {});
  tracker.endTool("tool-1", false);
  tracker.endTurn("ok", undefined, 1);
  tracker.endRun("stop");
  tracker.endInteraction();
  tracker.recordAuxiliaryUsage("compaction", { input: 50, output: 10, cost: 0.05 });
  now += 120_000;
  tracker.endSession("quit");

  const summary = fixture.spans().find((span) => span.name === "pi.session");
  assert.ok(summary);
  assert.equal(summary.parentSpanContext, undefined);
  assert.equal(summary.attributes["session.id"], "session-1");
  assert.equal(summary.attributes["pi.session.reason"], "quit");
  assert.ok(Math.abs(Number(summary.attributes["pi.session.cost.usd"]) - 0.3) < 1e-9);
  assert.equal(summary.attributes["pi.session.tokens.input"], 190);
  assert.equal(summary.attributes["pi.session.tokens.output"], 30);
  assert.equal(summary.attributes["pi.session.tokens.reasoning"], 5);
  assert.equal(summary.attributes["pi.session.interactions"], 1);
  assert.equal(summary.attributes["pi.session.llm_requests"], 1);
  assert.equal(summary.attributes["pi.session.tool_calls"], 1);
  assert.equal(summary.attributes["pi.session.duration_s"], 120);

  const ended = fixture.logs.find((log) => log.eventName === "pi.session.ended");
  assert.equal(ended?.attributes["pi.session.tool_calls"], 1);

  const tokens = fixture.metrics.find((metric) => metric.name === "pi.session.tokens");
  assert.equal(tokens?.value, 220);
  assert.equal(tokens?.attributes["pi.repo.slug"], "github.com/acme/app");
  assert.equal(tokens?.attributes["session.id"], undefined);
  const interactions = fixture.metrics.find((metric) => metric.name === "pi.session.interactions");
  assert.equal(interactions?.value, 1);
});
