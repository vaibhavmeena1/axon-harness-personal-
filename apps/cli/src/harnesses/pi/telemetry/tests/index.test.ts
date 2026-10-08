import { test } from "bun:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  SPAN_AGENT_RUN,
  SPAN_INTERACTION,
  SPAN_LLM,
  SPAN_TOOL,
  SPAN_TURN,
  SPAN_USER_WAIT,
} from "../src/attributes.ts";
import type { OrgTelemetryConfig } from "../src/config.ts";
import { createPiOrgTelemetry, type TelemetryDependencies } from "../src/index.ts";
import { createTestRuntime, type TestRuntimeFixture } from "./helpers.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakeApi {
  readonly api: ExtensionAPI;
  emit(event: string, payload: Record<string, unknown>, ctx?: ExtensionContext): Promise<unknown>;
  has(event: string): boolean;
}

function fakeExtensionApi(
  tools: Array<{ name: string; source: string; scope: string }> = [],
): FakeApi {
  const handlers = new Map<string, Handler>();
  const api = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getAllTools() {
      return tools.map((tool) => ({
        name: tool.name,
        sourceInfo: {
          path: `/hidden/${tool.name}.ts`,
          source: tool.source,
          scope: tool.scope,
          origin: "top-level",
        },
      }));
    },
  } as unknown as ExtensionAPI;
  const defaultContext = fakeContext();
  return {
    api,
    has: (event) => handlers.has(event),
    async emit(event, payload, ctx = defaultContext) {
      const handler = handlers.get(event);
      assert.ok(handler, `no handler registered for ${event}`);
      return handler({ type: event, ...payload }, ctx);
    },
  };
}

function fakeContext(overrides: Partial<Record<string, unknown>> = {}): ExtensionContext {
  return {
    cwd: "/work/project",
    mode: "print",
    hasUI: false,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/work/.pi/sessions/session-1.jsonl",
    },
    model: { id: "gpt-5", provider: "openai", contextWindow: 200_000 },
    thinkingLevel: "medium",
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    ...overrides,
  } as unknown as ExtensionContext;
}

const config: OrgTelemetryConfig = {
  protocol: "http/protobuf",
  serviceName: "pi-coding-agent",
  resourceAttributes: {},
  sampleRatio: 1,
  metricExportIntervalMs: 10_000,
  diagnostics: false,
  maxQueueSize: 2_048,
  maxExportBatchSize: 256,
  scheduledDelayMs: 1_000,
  exportTimeoutMs: 3_000,
  shutdownTimeoutMs: 2_000,
};

interface Harness {
  readonly fake: FakeApi;
  readonly fixture: TestRuntimeFixture;
  readonly created: Parameters<TelemetryDependencies["createRuntime"]>[];
  shutdowns(): number;
}

function harness(
  overrides: Partial<TelemetryDependencies> = {},
  tools?: Array<{ name: string; source: string; scope: string }>,
): Harness {
  const fixture = createTestRuntime();
  const created: Parameters<TelemetryDependencies["createRuntime"]>[] = [];
  let shutdowns = 0;
  // Count shutdowns without draining the in-memory exporter, so spans remain inspectable.
  const runtime = {
    ...fixture.runtime,
    async shutdown() {
      shutdowns += 1;
    },
  };
  const fake = fakeExtensionApi(tools);
  createPiOrgTelemetry({
    resolveConfig: () => config,
    resolveIdentity: async () => ({
      userId: "developer@example.com",
      email: "developer@example.com",
      source: "git_email",
    }),
    resolveRepoSlug: async () => "github.com/acme/backend",
    readPiVersion: async () => "0.85.1",
    createRuntime: (...args) => {
      created.push(args);
      return runtime;
    },
    ...overrides,
  })(fake.api);
  return { fake, fixture, created, shutdowns: () => shutdowns };
}

const assistantMessage = {
  role: "assistant",
  provider: "openai",
  api: "openai-completions",
  model: "gpt-5",
  responseModel: "gpt-5-2026-01-01",
  responseId: "chatcmpl-123",
  providerThinkingLevel: "medium",
  stopReason: "toolUse",
  usage: {
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    reasoning: 5,
    totalTokens: 130,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
  },
};

test("wires pi lifecycle events into an attributed span tree", async () => {
  const { fake, fixture, created, shutdowns } = harness({}, [
    { name: "read", source: "builtin", scope: "user" },
  ]);
  const ctx = fakeContext();

  await fake.emit("session_start", { reason: "startup" }, ctx);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.[2].piVersion, "0.85.1");
  assert.equal(created[0]?.[3].quiet, false);

  await fake.emit("input", { text: "hello world", source: "interactive" }, ctx);
  await fake.emit("before_agent_start", { prompt: "hello world", systemPrompt: "" }, ctx);
  await fake.emit("agent_start", {}, ctx);
  await fake.emit("turn_start", { turnIndex: 0, timestamp: Date.now() }, ctx);
  await fake.emit("before_provider_request", { payload: { model: "gpt-5" } }, ctx);
  await fake.emit(
    "after_provider_response",
    { status: 200, headers: { "X-Request-Id": "req-9" } },
    ctx,
  );
  await fake.emit("message_start", { message: assistantMessage }, ctx);
  await fake.emit("message_end", { message: assistantMessage }, ctx);
  await fake.emit(
    "tool_execution_start",
    { toolCallId: "call-1", toolName: "read", args: { path: "/work/project/src/index.ts" } },
    ctx,
  );
  await fake.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, ctx);
  await fake.emit("ui_prompt_end", { reason: "ui_prompt", kind: "confirm" }, ctx);
  await fake.emit(
    "tool_execution_end",
    {
      toolCallId: "call-1",
      toolName: "read",
      isError: false,
      result: {
        content: [
          { type: "text", text: "file contents" },
          { type: "image", data: "x".repeat(10_000), mimeType: "image/png" },
        ],
        details: { secret: "never exported" },
        usage: {
          input: 7,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0005 },
        },
      },
    },
    ctx,
  );
  await fake.emit(
    "message_end",
    {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        usage: { input: 7, output: 3, cost: 0.0005 },
      },
    },
    ctx,
  );
  await fake.emit(
    "turn_end",
    { turnIndex: 0, message: { ...assistantMessage, stopReason: "stop" }, toolResults: [{}] },
    ctx,
  );
  await fake.emit(
    "agent_end",
    { messages: [assistantMessage, { ...assistantMessage, stopReason: "stop" }] },
    ctx,
  );
  await fake.emit("agent_settled", {}, ctx);
  await fake.emit("session_shutdown", { reason: "quit" }, ctx);

  assert.equal(shutdowns(), 1);
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
  const interaction = byName.get(SPAN_INTERACTION);
  const run = byName.get(SPAN_AGENT_RUN);
  const turn = byName.get(SPAN_TURN);
  const llm = byName.get(SPAN_LLM);
  const tool = byName.get(SPAN_TOOL);
  const wait = byName.get(SPAN_USER_WAIT);
  assert.ok(interaction && run && turn && llm && tool && wait, "missing spans");
  assert.equal(run.parentSpanContext?.spanId, interaction.spanContext().spanId);
  assert.equal(turn.parentSpanContext?.spanId, run.spanContext().spanId);
  assert.equal(llm.parentSpanContext?.spanId, turn.spanContext().spanId);
  assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);

  assert.equal(llm.attributes["gen_ai.request.model"], "gpt-5");
  assert.equal(llm.attributes["gen_ai.response.model"], "gpt-5-2026-01-01");
  assert.equal(llm.attributes["gen_ai.response.id"], "chatcmpl-123");
  assert.equal(llm.attributes["pi.provider.request_id"], "req-9");
  assert.equal(llm.attributes["pi.context.tokens"], 50_000);
  assert.equal(llm.attributes["pi.context.percent"], 25);
  assert.equal(llm.attributes["pi.thinking.level"], "medium");
  assert.equal(llm.attributes["pi.thinking.provider_level"], "medium");
  assert.equal(llm.attributes["gen_ai.usage.reasoning.output_tokens"], 5);
  assert.equal(llm.attributes["pi.cost.input_usd"], 0.01);
  assert.equal(llm.attributes["pi.llm.synthesized"], false);
  assert.equal(llm.attributes["pi.llm.payload_size"], undefined);
  assert.equal(llm.status.code, SpanStatusCode.OK);

  assert.equal(tool.attributes["pi.tool.output_size"], "file contents".length);
  assert.equal(tool.attributes["pi.tool.output_images"], 1);
  assert.equal(tool.attributes["pi.tool.source"], "builtin");
  assert.equal(tool.attributes["pi.tool.scope"], "user");
  assert.equal(tool.attributes["pi.path"], "src/index.ts");
  assert.ok(!JSON.stringify(tool.attributes).includes("never exported"));
  assert.ok(!JSON.stringify(tool.attributes).includes("/hidden/"));

  assert.ok(spans.every((span) => span.attributes["pi.repo.slug"] === "github.com/acme/backend"));
  assert.ok(
    fixture.logs.every((log) => log.attributes["pi.repo.slug"] === "github.com/acme/backend"),
  );
  const inputMetric = fixture.metrics.find((metric) => metric.name === "pi.user.input.count");
  assert.ok(inputMetric);
  assert.equal(inputMetric.attributes["pi.input.text_length"], undefined);
  assert.equal(inputMetric.attributes["pi.repo.slug"], "github.com/acme/backend");
  const tokenMetric = fixture.metrics.find(
    (metric) =>
      metric.name === "pi.tokens.input" && metric.attributes["pi.usage.source"] === "assistant",
  );
  assert.ok(tokenMetric);
  assert.equal(tokenMetric.value, 100);
  assert.equal(tokenMetric.attributes["pi.repo.slug"], undefined);
  assert.ok(
    fixture.metrics.some((metric) => metric.name === "pi.tokens.reasoning" && metric.value === 5),
  );
  assert.ok(
    fixture.metrics.some(
      (metric) =>
        metric.name === "pi.cost" &&
        metric.attributes["pi.usage.source"] === "tool" &&
        metric.value === 0.0005,
    ),
  );
  assert.ok(
    fixture.metrics.some(
      (metric) =>
        metric.name === "pi.context.utilization" && metric.value === 25 && metric.unit === "%",
    ),
  );
});

test("closes open spans on session_shutdown mid-turn", async () => {
  const { fake, fixture } = harness();
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("before_agent_start", { prompt: "go", systemPrompt: "" });
  await fake.emit("agent_start", {});
  await fake.emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("message_start", { message: assistantMessage });
  await fake.emit("tool_execution_start", {
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  await fake.emit("session_shutdown", { reason: "quit" });

  const spans = fixture.spans();
  for (const name of [SPAN_INTERACTION, SPAN_AGENT_RUN, SPAN_TURN, SPAN_LLM, SPAN_TOOL]) {
    const span = spans.find(
      (candidate) => candidate.name === name || candidate.name.startsWith(`${name} `),
    );
    assert.ok(span, `missing ${name}`);
    assert.ok(span.ended, `${name} not ended`);
    assert.equal(span.status.code, SpanStatusCode.UNSET);
  }
});

test("records the parent session for subagent children and marks tui mode quiet", async () => {
  const previous = process.env.PI_SESSION_ID;
  process.env.PI_SESSION_ID = "parent-session";
  try {
    const { fake, fixture, created } = harness();
    await fake.emit(
      "session_start",
      { reason: "startup" },
      fakeContext({ mode: "tui", hasUI: true }),
    );
    await fake.emit("session_shutdown", { reason: "quit" });
    assert.equal(created[0]?.[3].quiet, true);
    const started = fixture.logs.find((log) => log.eventName === "pi.session.started");
    assert.equal(started?.attributes["pi.session.parent_id"], "parent-session");
  } finally {
    if (previous === undefined) delete process.env.PI_SESSION_ID;
    else process.env.PI_SESSION_ID = previous;
  }
});

test("stays inert without managed configuration", async () => {
  const { fake, fixture, created } = harness({ resolveConfig: () => undefined });
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("before_agent_start", { prompt: "go", systemPrompt: "" });
  await fake.emit("session_shutdown", { reason: "quit" });
  assert.equal(created.length, 0);
  assert.equal(fixture.spans().length, 0);
  assert.equal(fixture.metrics.length, 0);
});

test("swallows runtime creation and handler failures", async () => {
  const failing = harness({
    createRuntime: () => {
      throw new Error("boom");
    },
  });
  await failing.fake.emit("session_start", { reason: "startup" });
  await failing.fake.emit("before_agent_start", { prompt: "go", systemPrompt: "" });
  assert.equal(failing.fixture.spans().length, 0);

  const { fake, fixture } = harness();
  await fake.emit("session_start", { reason: "startup" });
  // A malformed event must not throw out of the handler.
  await fake.emit("input", { text: undefined, source: "interactive" });
  assert.ok(
    fixture.metrics.some(
      (metric) => metric.name === "pi.telemetry.dropped" && metric.attributes.reason === "input",
    ),
  );
  assert.deepEqual(await fake.emit("project_trust", { cwd: "/work/project" }), {
    trusted: "undecided",
  });
  await fake.emit("session_shutdown", { reason: "quit" });
});

test("physical stream identity wins over virtual selection without inspecting raw data", async () => {
  const { fake, fixture } = harness();
  const ctx = fakeContext({ model: { provider: "router", id: "auto" } });
  await fake.emit("session_start", { reason: "startup" }, ctx);
  await fake.emit("agent_start", {}, ctx);
  await fake.emit(
    "before_provider_request",
    { payload: { model: "untrusted-payload-model" } },
    ctx,
  );
  const event = {
    provider: "google",
    api: "google-generative-ai",
    model: "Exact/Model",
    get data() {
      throw new Error("raw data must not be read");
    },
  };
  // Fake dispatch spreads its argument; use a getter on the nested data value instead.
  await fake.emit(
    "provider_stream_event",
    {
      provider: event.provider,
      api: event.api,
      model: event.model,
      data: {
        get content() {
          throw new Error("private");
        },
      },
    },
    ctx,
  );
  await fake.emit(
    "message_start",
    {
      message: {
        ...assistantMessage,
        api: "google-generative-ai",
        provider: "google",
        model: "Exact/Model",
      },
    },
    ctx,
  );
  await fake.emit(
    "message_end",
    {
      message: {
        role: "assistant",
        api: "google-generative-ai",
        provider: "google",
        model: "Exact/Model",
        stopReason: "stop",
      },
    },
    ctx,
  );
  await fake.emit("agent_end", { messages: [] }, ctx);
  await fake.emit("agent_settled", {}, ctx);
  const spans = fixture.spans();
  assert.equal(spans.filter((s) => s.name === "generate_content Exact/Model").length, 1);
  const inference = spans.find((s) => s.name === "generate_content Exact/Model");
  assert.equal(inference?.attributes["gen_ai.provider.name"], "google");
  assert.equal(inference?.attributes["gen_ai.response.model"], undefined);
  assert.equal(inference?.attributes["gen_ai.response.id"], undefined);
  assert.equal(
    spans.find((s) => s.name === SPAN_INTERACTION)?.attributes["pi.prompt.length"],
    undefined,
  );
  assert.ok(!fixture.metrics.some((m) => m.name.includes("chunk")));
  await fake.emit("session_shutdown", { reason: "quit" });
});

test("unhooked custom providers and setup failure are custom lifecycle, not fabricated inference", async () => {
  for (const stopReason of ["stop", "error"]) {
    const { fake, fixture } = harness();
    await fake.emit("session_start", { reason: "startup" });
    await fake.emit("agent_start", {});
    await fake.emit("message_start", { message: assistantMessage });
    await fake.emit("message_end", { message: { ...assistantMessage, stopReason } });
    await fake.emit("agent_end", { messages: [{ ...assistantMessage, stopReason }] });
    await fake.emit("agent_settled", {});
    assert.ok(fixture.spans().some((s) => s.name === "pi.assistant.lifecycle"));
    assert.ok(!fixture.spans().some((s) => s.name.startsWith("chat ")));
    assert.equal(
      fixture.metrics.find((m) => m.name === "gen_ai.invoke_agent.inference_calls")?.value,
      0,
    );
    assert.ok(!fixture.logs.some((l) => l.eventName === "gen_ai.client.operation.exception"));
    await fake.emit("session_shutdown", { reason: "quit" });
  }
});

test("idle and overlapping provider hooks are not invented foreground calls", async () => {
  const { fake, fixture } = harness();
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("provider_stream_event", {
    provider: "openai",
    api: "openai-completions",
    model: "warm",
    data: {},
  });
  assert.ok(fixture.spans().every((span) => span.name.startsWith("axon.")));
  await fake.emit("agent_start", {});
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("after_provider_response", { status: 503, headers: { "x-request-id": "wrong" } });
  await fake.emit("message_start", { message: assistantMessage });
  await fake.emit("message_end", { message: assistantMessage });
  await fake.emit("agent_end", { messages: [] });
  await fake.emit("agent_settled", {});
  assert.equal(
    fixture.metrics.find((m) => m.name === "gen_ai.invoke_agent.inference_calls")?.value,
    0,
  );
  assert.equal(
    fixture.spans().find((s) => s.name === "pi.assistant.lifecycle")?.attributes[
      "pi.provider.request_id"
    ],
    undefined,
  );
  await fake.emit("session_shutdown", { reason: "quit" });
});

test("nested tool execution usage is ignored in favor of finalized top-level aggregate exactly once", async () => {
  const { fake, fixture } = harness();
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("agent_start", {});
  for (const [id, parent] of [
    ["p", undefined],
    ["p/1", "p"],
    ["p/1/1", "p/1"],
    ["p/2", "p"],
    ["q", undefined],
  ]) {
    await fake.emit("tool_execution_start", {
      toolCallId: id,
      toolName: "custom",
      parentToolCallId: parent,
      args: {},
    });
  }
  for (const id of ["p/1/1", "p/1", "p/2", "p", "q"]) {
    await fake.emit("tool_execution_end", {
      toolCallId: id,
      toolName: "custom",
      isError: id === "p/2",
      result: { usage: { input: 5, output: 2, cost: 0.01 } },
    });
  }
  assert.ok(!fixture.metrics.some((m) => m.name === "pi.cost"));
  for (const [id, input, cost] of [
    ["p", 20, 0.04],
    ["q", 5, 0.01],
  ]) {
    await fake.emit("message_end", {
      message: { role: "toolResult", toolCallId: id, usage: { input, output: 2, cost } },
    });
  }
  await fake.emit("agent_end", { messages: [] });
  await fake.emit("agent_settled", {});
  const sum = (name: string) =>
    fixture.metrics.filter((m) => m.name === name).reduce((n, m) => n + m.value, 0);
  assert.equal(sum("pi.tokens.input"), 25);
  assert.equal(sum("pi.cost"), 0.05);
  assert.equal(fixture.metrics.find((m) => m.name === "gen_ai.invoke_agent.tool_calls")?.value, 2);
  assert.equal(
    fixture.metrics.find((m) => m.name === "gen_ai.invoke_agent.inference_calls")?.value,
    0,
  );
  await fake.emit("session_shutdown", { reason: "quit" });
});

test("warming during tools cannot fabricate inference, usage, or request correlation", async () => {
  const { fake, fixture } = harness();
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("agent_start", {});
  await fake.emit("turn_start", { turnIndex: 0 });
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("provider_stream_event", {
    provider: "openai",
    api: "openai-completions",
    model: "gpt-5",
  });
  await fake.emit("message_start", { message: assistantMessage });
  await fake.emit("message_end", { message: assistantMessage });
  await fake.emit("tool_execution_start", { toolCallId: "t", toolName: "custom", args: {} });
  await fake.emit("before_provider_request", { payload: {} });
  await fake.emit("after_provider_response", {
    status: 503,
    headers: { "x-request-id": "warm-only" },
  });
  await fake.emit("provider_stream_event", {
    provider: "openai",
    api: "openai-completions",
    model: "warm",
  });
  await fake.emit("tool_execution_end", {
    toolCallId: "t",
    toolName: "custom",
    isError: false,
    result: {},
  });
  await fake.emit("turn_end", { message: assistantMessage, toolResults: [{}] });
  // The next foreground call must not inherit the warming request or headers.
  await fake.emit("turn_start", { turnIndex: 1 });
  await fake.emit("message_start", { message: assistantMessage });
  await fake.emit("message_end", { message: { ...assistantMessage, usage: undefined } });
  await fake.emit("agent_end", { messages: [] });
  await fake.emit("agent_settled", {});
  assert.equal(fixture.spans().filter((s) => s.kind === 2).length, 1);
  assert.equal(
    fixture.metrics.find((m) => m.name === "gen_ai.invoke_agent.inference_calls")?.value,
    1,
  );
  assert.equal(
    fixture.metrics
      .filter((m) => m.name === "pi.tokens.input")
      .reduce((sum, m) => sum + m.value, 0),
    100,
  );
  assert.ok(!fixture.spans().some((s) => s.attributes["pi.provider.request_id"] === "warm-only"));
  assert.ok(!fixture.logs.some((l) => l.eventName === "gen_ai.client.operation.exception"));
  await fake.emit("session_shutdown", { reason: "quit" });
});

test("usage metrics distinguish requested aliases from known response models", async () => {
  for (const responseModel of [undefined, "actual-model"]) {
    const { fake, fixture } = harness();
    await fake.emit("session_start", { reason: "startup" });
    await fake.emit("agent_start", {});
    await fake.emit("before_provider_request", { payload: {} });
    const message = { ...assistantMessage, model: "requested-alias", responseModel };
    await fake.emit("message_start", { message });
    await fake.emit("message_end", { message });
    for (const metric of fixture.metrics.filter(
      (m) => m.name.startsWith("pi.tokens.") || m.name === "pi.cost",
    )) {
      assert.equal(metric.attributes["gen_ai.request.model"], "requested-alias");
      assert.equal(metric.attributes["gen_ai.response.model"], responseModel);
    }
    await fake.emit("session_shutdown", { reason: "quit" });
  }
});

test("tool preparation and active execution cancellation are not client or tool exceptions", async () => {
  for (const phase of ["preparation", "execution", "genuine-failure"]) {
    const { fake, fixture } = harness();
    const controller = new AbortController();
    const ctx = fakeContext({ signal: controller.signal });
    await fake.emit("session_start", { reason: "startup" }, ctx);
    await fake.emit("agent_start", {}, ctx);
    if (phase === "preparation") controller.abort();
    await fake.emit("tool_execution_start", { toolCallId: "t", toolName: "custom", args: {} }, ctx);
    if (phase === "execution") controller.abort();
    await fake.emit(
      "tool_execution_end",
      {
        toolCallId: "t",
        toolName: "custom",
        isError: true,
        result: { content: [{ type: "text", text: "Operation aborted" }] },
      },
      ctx,
    );
    const span = fixture.spans().find((s) => s.name === "execute_tool custom");
    const failed = phase === "genuine-failure";
    assert.equal(span?.status.code, failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET);
    assert.equal(span?.attributes["pi.tool.outcome"], failed ? "error" : "aborted");
    assert.equal(span?.attributes["error.type"], failed ? "tool_execution_error" : undefined);
    assert.equal(fixture.metrics.filter((m) => m.name === "pi.tool.errors").length, failed ? 1 : 0);
    assert.equal(
      fixture.logs.filter((l) => l.eventName === "pi.tool.error").length,
      failed ? 1 : 0,
    );
    await fake.emit("session_shutdown", { reason: "quit" }, ctx);
  }
});

test("session replacement finalizes the previous tracker before shutdown", async () => {
  const { fake, fixture, shutdowns } = harness();
  await fake.emit("session_start", { reason: "startup" });
  await fake.emit("agent_start", {});
  await fake.emit("tool_execution_start", { toolCallId: "open", toolName: "read", args: {} });
  await fake.emit("session_start", { reason: "switch" });
  assert.equal(shutdowns(), 1);
  assert.ok(fixture.spans().some((s) => s.name === "execute_tool read" && s.ended));
  assert.equal(fixture.metrics.filter((m) => m.name === "gen_ai.invoke_agent.duration").length, 1);
  await fake.emit("session_shutdown", { reason: "quit" });
  await fake.emit("session_shutdown", { reason: "quit" });
  assert.equal(shutdowns(), 2);
});
