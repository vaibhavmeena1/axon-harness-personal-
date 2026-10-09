import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  type CompactionTrigger,
  sanitizeProductEvent,
} from "../../../../telemetry/product-events.ts";
import {
  ATTR_CACHE_READ_TOKENS,
  ATTR_CACHE_WRITE_TOKENS,
  ATTR_CONTEXT_PERCENT,
  ATTR_CONTEXT_TOKENS,
  ATTR_CONTEXT_WINDOW,
  ATTR_CONVERSATION_ID,
  ATTR_COST,
  ATTR_COST_CACHE_READ,
  ATTR_COST_CACHE_WRITE,
  ATTR_COST_INPUT,
  ATTR_COST_OUTPUT,
  ATTR_ERROR_TYPE,
  ATTR_INPUT_TOKENS,
  ATTR_LLM_TRUNCATED,
  ATTR_MODE,
  ATTR_OPERATION,
  ATTR_OUTPUT_TOKENS,
  ATTR_PARENT_SESSION_ID,
  ATTR_PROJECT,
  ATTR_PROVIDER,
  ATTR_PROVIDER_REQUEST_ID,
  ATTR_PROVIDER_THINKING_LEVEL,
  ATTR_REASONING_TOKENS,
  ATTR_REPO_SLUG,
  ATTR_REQUEST_MODEL,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_SESSION_CACHE_READ_TOKENS,
  ATTR_SESSION_CACHE_WRITE_TOKENS,
  ATTR_SESSION_COST,
  ATTR_SESSION_DURATION,
  ATTR_SESSION_ID,
  ATTR_SESSION_INPUT_TOKENS,
  ATTR_SESSION_INTERACTIONS,
  ATTR_SESSION_LLM_REQUESTS,
  ATTR_SESSION_OUTPUT_TOKENS,
  ATTR_SESSION_REASONING_TOKENS,
  ATTR_SESSION_TOOL_CALLS,
  ATTR_THINKING_LEVEL,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_NAME,
  ATTR_TOOL_OUTPUT_IMAGES,
  ATTR_TOOL_OUTPUT_SIZE,
  ATTR_TOOL_SCOPE,
  ATTR_TOOL_SOURCE,
  ATTR_TOOL_TRUNCATED_CALL,
  ATTR_USAGE_SOURCE,
  SPAN_AGENT_RUN,
  SPAN_COMPACTION,
  SPAN_INTERACTION,
  SPAN_SESSION,
  SPAN_TOOL,
  SPAN_TURN,
  SPAN_USER_WAIT,
} from "./attributes.ts";
import { recordProductEvent } from "./product.ts";
import { sanitizeError, type ToolOutputSummary } from "./sanitization.ts";
import type { TelemetryRuntime } from "./telemetry-types.ts";

interface SpanSlot {
  readonly span: Span;
  readonly context: Context;
  readonly startedAt: number;
}

interface ToolSlot extends SpanSlot {
  readonly name: string;
}

interface CompactionSlot extends SpanSlot {
  readonly reason: string;
  readonly trigger?: CompactionTrigger;
  model?: string;
}

interface LlmSlot extends SpanSlot {
  readonly synthesized: boolean;
  readonly operation?: string;
  providerError?: string;
  provider?: string;
  requestModel?: string;
  requestId?: string;
  thinkingLevel?: string;
}

/** Per-session running totals, exported once at session end (summary span, log, histograms). */
interface SessionTotals {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  interactions: number;
  llmRequests: number;
  toolCalls: number;
}

function emptyTotals(): SessionTotals {
  return {
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    interactions: 0,
    llmRequests: 0,
    toolCalls: 0,
  };
}

/** Pi thinking levels; anything else is exported as `other` to keep metric labels bounded. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function thinkingDimension(level: string | undefined): Attributes {
  if (!level) return {};
  return { [ATTR_THINKING_LEVEL]: THINKING_LEVELS.has(level) ? level : "other" };
}

export interface SessionDetails {
  readonly sessionId: string;
  readonly project: string;
  readonly mode: string;
  readonly reason: string;
  readonly ephemeral: boolean;
  readonly cwd: string;
  readonly repoSlug?: string;
  readonly parentSessionId?: string;
}

export interface InputDetails {
  readonly source: string;
  readonly streamingBehavior?: string;
  readonly textLength: number;
  readonly imageCount: number;
}

export interface UsageDetails {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
  readonly cost?: number;
  readonly costInput?: number;
  readonly costOutput?: number;
  readonly costCacheRead?: number;
  readonly costCacheWrite?: number;
}

export type UsageSource = "assistant" | "tool" | "compaction" | "branch_summary";

export interface AssistantDetails {
  readonly provider?: string;
  readonly model?: string; // Only provider-reported response model.
  readonly requestModel?: string;
  readonly responseId?: string;
  readonly providerThinkingLevel?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: UsageDetails;
}

export interface LlmStartDetails {
  readonly provider?: string;
  readonly model?: string;
  readonly synthesized?: boolean;
  readonly operation?: string;
  readonly startedAt?: number;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
  readonly contextPercent?: number;
  readonly thinkingLevel?: string;
}

export interface ProviderResponseDetails {
  readonly status: number;
  readonly requestId?: string;
}

export interface ToolStartDetails {
  readonly parentToolCallId?: string;
  readonly source?: string;
  readonly scope?: string;
}

export interface CompactionStartDetails {
  readonly reason: string;
  readonly willRetry: boolean;
  readonly tokensBefore?: number;
  readonly model?: string;
  readonly inferred?: boolean;
}

function durationSeconds(startedAt: number, endedAt: number): number {
  return Math.max(0, endedAt - startedAt) / 1_000;
}

function applyUsage(span: Span, usage: UsageDetails | undefined): void {
  if (!usage) return;
  if (usage.input !== undefined || usage.cacheRead !== undefined || usage.cacheWrite !== undefined)
    span.setAttribute(
      ATTR_INPUT_TOKENS,
      (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
    );
  if (usage.output !== undefined) span.setAttribute(ATTR_OUTPUT_TOKENS, usage.output);
  if (usage.cacheRead !== undefined) span.setAttribute(ATTR_CACHE_READ_TOKENS, usage.cacheRead);
  if (usage.cacheWrite !== undefined) span.setAttribute(ATTR_CACHE_WRITE_TOKENS, usage.cacheWrite);
  if (usage.reasoning !== undefined) span.setAttribute(ATTR_REASONING_TOKENS, usage.reasoning);
  if (usage.cost !== undefined) span.setAttribute(ATTR_COST, usage.cost);
  if (usage.costInput !== undefined) span.setAttribute(ATTR_COST_INPUT, usage.costInput);
  if (usage.costOutput !== undefined) span.setAttribute(ATTR_COST_OUTPUT, usage.costOutput);
  if (usage.costCacheRead !== undefined)
    span.setAttribute(ATTR_COST_CACHE_READ, usage.costCacheRead);
  if (usage.costCacheWrite !== undefined)
    span.setAttribute(ATTR_COST_CACHE_WRITE, usage.costCacheWrite);
}

function errorOutcome(stopReason: string | undefined): boolean {
  return stopReason === "error";
}

export class AgentTelemetryTracker {
  private readonly runtime: TelemetryRuntime;
  private readonly now: () => number;
  private session: SessionDetails | undefined;
  private sessionStartedAt = 0;
  private totals: SessionTotals = emptyTotals();
  private interaction: SpanSlot | undefined;
  private run: SpanSlot | undefined;
  private turn: SpanSlot | undefined;
  private llm: LlmSlot | undefined;
  private wait: SpanSlot | undefined;
  private compaction: CompactionSlot | undefined;
  private pendingCompactionTrigger: CompactionTrigger | undefined;
  private compactionOutcomeHandledByExtension = false;
  private readonly tools = new Map<string, ToolSlot>();
  private pendingInput: InputDetails | undefined;
  private runCount = 0;
  private lastStopReason: string | undefined;
  private turnTruncated = false;
  private inferenceCalls = 0;
  private toolCalls = 0;

  constructor(runtime: TelemetryRuntime, now: () => number = Date.now) {
    this.runtime = runtime;
    this.now = now;
  }

  /** Attributes for spans and logs: identity, session, project, repository. */
  private baseAttributes(): Attributes {
    if (!this.session) return { ...this.runtime.commonAttributes };
    return {
      ...this.runtime.commonAttributes,
      [ATTR_SESSION_ID]: this.session.sessionId,
      [ATTR_CONVERSATION_ID]: this.session.sessionId,
      [ATTR_PROJECT]: this.session.project,
      [ATTR_MODE]: this.session.mode,
      ...(this.session.repoSlug ? { [ATTR_REPO_SLUG]: this.session.repoSlug } : {}),
      ...(this.session.parentSessionId
        ? { [ATTR_PARENT_SESSION_ID]: this.session.parentSessionId }
        : {}),
    };
  }

  /** Low-cardinality attributes shared by every metric point. */
  private metricAttributes(attributes: Attributes = {}): Attributes {
    return {
      ...(this.session ? { [ATTR_MODE]: this.session.mode } : {}),
      ...attributes,
    };
  }

  /**
   * Activity metrics (sessions, interactions, runs, turns, waits, inputs, interventions) also carry
   * the repository slug. Token, cost, LLM, and tool metrics do not: combined with provider, model,
   * tool name, and histogram buckets the series count would grow multiplicatively per user.
   */
  private activityMetricAttributes(attributes: Attributes = {}): Attributes {
    return this.metricAttributes({
      ...(this.session?.repoSlug ? { [ATTR_REPO_SLUG]: this.session.repoSlug } : {}),
      ...attributes,
    });
  }

  private startSpan(
    name: string,
    kind: SpanKind,
    attributes: Attributes,
    parent: Context,
    startedAt = this.now(),
  ): SpanSlot {
    const span = this.runtime.tracer.startSpan(
      name,
      { kind, startTime: startedAt, attributes: { ...this.baseAttributes(), ...attributes } },
      parent,
    );
    return { span, context: trace.setSpan(parent, span), startedAt };
  }

  private activeParent(): Context {
    return this.turn?.context ?? this.run?.context ?? this.interaction?.context ?? ROOT_CONTEXT;
  }

  private addInteractionEvent(name: string, attributes: Attributes): void {
    this.interaction?.span.addEvent(name, { ...this.baseAttributes(), ...attributes });
  }

  /** Close every child slot that may still be open, innermost first. */
  private drainChildren(reason: string): void {
    this.endCompaction({ outcome: "interrupted" });
    this.endWait("interrupted");
    this.endLlm({ stopReason: "interrupted" });
    for (const toolCallId of [...this.tools.keys()].reverse()) {
      this.endTool(toolCallId, false, undefined, undefined, reason);
    }
    this.endTurn("interrupted");
    this.endRun("interrupted");
  }

  startSession(details: SessionDetails): void {
    if (this.session) this.endSession("replaced");
    this.session = details;
    this.sessionStartedAt = this.now();
    this.totals = emptyTotals();
    this.pendingCompactionTrigger = undefined;
    this.compactionOutcomeHandledByExtension = false;
    const attributes = this.activityMetricAttributes({
      "pi.session.reason": details.reason,
      "pi.session.ephemeral": details.ephemeral,
    });
    this.runtime.metrics.count("pi.session.started", 1, attributes);
    this.runtime.logs.emit("info", "pi.session.started", "pi session started", {
      ...this.baseAttributes(),
      "pi.session.reason": details.reason,
      "pi.session.ephemeral": details.ephemeral,
    });
  }

  endSession(reason: string): void {
    if (!this.session) return;
    const endedAt = this.now();
    if (this.interaction) this.endInteraction("session_shutdown");
    else this.drainChildren("session_shutdown");
    this.runtime.metrics.count(
      "pi.session.ended",
      1,
      this.activityMetricAttributes({ "pi.session.reason": reason }),
    );
    this.runtime.metrics.record(
      "pi.session.duration",
      durationSeconds(this.sessionStartedAt, endedAt),
      "s",
      this.activityMetricAttributes({ "pi.session.reason": reason }),
    );
    const summary = this.sessionSummaryAttributes(endedAt);
    const summaryMetricAttributes = this.activityMetricAttributes();
    this.runtime.metrics.record(
      "pi.session.cost",
      this.totals.cost,
      "USD",
      summaryMetricAttributes,
    );
    this.runtime.metrics.record(
      "pi.session.tokens",
      this.totals.input + this.totals.cacheRead + this.totals.cacheWrite + this.totals.output,
      "{token}",
      summaryMetricAttributes,
    );
    this.runtime.metrics.record(
      "pi.session.interactions",
      this.totals.interactions,
      "{interaction}",
      summaryMetricAttributes,
    );
    // One short root span per session, created at the end with the session's start time, so
    // trace backends can rank sessions by cost without holding a span open for the session.
    this.runtime.tracer
      .startSpan(
        SPAN_SESSION,
        {
          kind: SpanKind.INTERNAL,
          startTime: this.sessionStartedAt,
          attributes: { ...this.baseAttributes(), "pi.session.reason": reason, ...summary },
        },
        ROOT_CONTEXT,
      )
      .end(endedAt);
    this.runtime.logs.emit("info", "pi.session.ended", "pi session ended", {
      ...this.baseAttributes(),
      "pi.session.reason": reason,
      ...summary,
    });
    this.session = undefined;
    this.pendingCompactionTrigger = undefined;
    this.compactionOutcomeHandledByExtension = false;
  }

  private sessionSummaryAttributes(endedAt: number): Attributes {
    const totals = this.totals;
    return {
      [ATTR_SESSION_COST]: totals.cost,
      [ATTR_SESSION_INPUT_TOKENS]: totals.input + totals.cacheRead + totals.cacheWrite,
      [ATTR_SESSION_OUTPUT_TOKENS]: totals.output,
      [ATTR_SESSION_CACHE_READ_TOKENS]: totals.cacheRead,
      [ATTR_SESSION_CACHE_WRITE_TOKENS]: totals.cacheWrite,
      [ATTR_SESSION_REASONING_TOKENS]: totals.reasoning,
      [ATTR_SESSION_INTERACTIONS]: totals.interactions,
      [ATTR_SESSION_LLM_REQUESTS]: totals.llmRequests,
      [ATTR_SESSION_TOOL_CALLS]: totals.toolCalls,
      [ATTR_SESSION_DURATION]: durationSeconds(this.sessionStartedAt, endedAt),
    };
  }

  noteInput(details: InputDetails): void {
    const attributes: Attributes = {
      "pi.input.source": details.source,
      "pi.input.text_length": details.textLength,
      "pi.input.image_count": details.imageCount,
      ...(details.streamingBehavior
        ? { "pi.input.streaming_behavior": details.streamingBehavior }
        : {}),
    };
    this.runtime.metrics.count(
      "pi.user.input.count",
      1,
      this.activityMetricAttributes({
        "pi.input.source": details.source,
        ...(details.streamingBehavior
          ? { "pi.input.streaming_behavior": details.streamingBehavior }
          : {}),
      }),
    );
    this.runtime.logs.emit(
      "info",
      "pi.user.input",
      "user input received",
      {
        ...this.baseAttributes(),
        ...attributes,
      },
      this.interaction?.context,
    );
    if (this.interaction) this.addInteractionEvent("pi.user.input", attributes);
    else this.pendingInput = details;
  }

  startInteraction(promptLength?: number, imageCount?: number): void {
    if (this.interaction) this.endInteraction("superseded");
    this.runCount = 0;
    this.inferenceCalls = 0;
    this.toolCalls = 0;
    this.lastStopReason = undefined;
    const pending = this.pendingInput;
    const attributes: Attributes = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "pi",
      ...(promptLength !== undefined ? { "pi.prompt.length": promptLength } : {}),
      ...(imageCount !== undefined ? { "pi.prompt.image_count": imageCount } : {}),
      ...(pending
        ? {
            "pi.input.source": pending.source,
            ...(pending.streamingBehavior
              ? { "pi.input.streaming_behavior": pending.streamingBehavior }
              : {}),
          }
        : {}),
    };
    this.pendingInput = undefined;
    this.interaction = this.startSpan(
      SPAN_INTERACTION,
      SpanKind.INTERNAL,
      attributes,
      ROOT_CONTEXT,
    );
    this.runtime.metrics.count("pi.interaction.count", 1, this.activityMetricAttributes());
    if (this.session) this.totals.interactions += 1;
  }

  endInteraction(outcome = "settled"): void {
    if (!this.interaction) return;
    this.drainChildren(outcome === "settled" ? "interaction end" : outcome);

    const endedAt = this.now();
    const failed = errorOutcome(this.lastStopReason);
    this.interaction.span.setAttributes({
      "pi.interaction.outcome": outcome,
      "pi.agent.run_count": this.runCount,
      ...(this.lastStopReason ? { "pi.stop_reason": this.lastStopReason } : {}),
    });
    this.interaction.span.setStatus(
      failed ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.UNSET },
    );
    if (failed) this.interaction.span.setAttribute(ATTR_ERROR_TYPE, "agent_error");
    this.interaction.span.end();
    const invocationAttributes = this.metricAttributes({
      [ATTR_OPERATION]: "invoke_agent",
      "gen_ai.agent.name": "pi",
      ...(failed ? { [ATTR_ERROR_TYPE]: "agent_error" } : {}),
    });
    this.runtime.metrics.record(
      "gen_ai.invoke_agent.duration",
      durationSeconds(this.interaction.startedAt, endedAt),
      "s",
      invocationAttributes,
    );
    this.runtime.metrics.record(
      "gen_ai.invoke_agent.inference_calls",
      this.inferenceCalls,
      "{inference_call}",
      invocationAttributes,
    );
    this.runtime.metrics.record(
      "gen_ai.invoke_agent.tool_calls",
      this.toolCalls,
      "{tool_call}",
      invocationAttributes,
    );
    this.runtime.metrics.record(
      "pi.interaction.duration",
      durationSeconds(this.interaction.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.runtime.logs.emit(
      failed ? "warn" : "info",
      "pi.interaction.settled",
      "pi interaction settled",
      {
        ...this.baseAttributes(),
        outcome,
        "pi.agent.run_count": this.runCount,
        ...(this.lastStopReason ? { "pi.stop_reason": this.lastStopReason } : {}),
      },
      this.interaction.context,
    );
    this.interaction = undefined;
  }

  startRun(): void {
    if (!this.interaction) this.startInteraction();
    if (this.run) this.endRun("superseded");
    this.runCount += 1;
    const repeated = this.runCount > 1;
    this.run = this.startSpan(
      SPAN_AGENT_RUN,
      SpanKind.INTERNAL,
      {
        "pi.agent.run_index": this.runCount,
        "pi.agent.run_repeated": repeated,
      },
      this.interaction?.context ?? ROOT_CONTEXT,
    );
    this.runtime.metrics.count("pi.agent.run.count", 1, this.activityMetricAttributes());
    if (repeated) {
      this.runtime.metrics.count("pi.agent.run.repeated", 1, this.activityMetricAttributes());
      this.addInteractionEvent("pi.agent.run.repeated", { "pi.agent.run_index": this.runCount });
    }
  }

  endRun(stopReason?: string): void {
    if (!this.run) return;
    this.endLlm({ stopReason: "incomplete" });
    this.endTurn("incomplete");
    this.endWait("interrupted");
    for (const id of [...this.tools.keys()].reverse())
      this.endTool(id, false, undefined, undefined, "run_end");
    const endedAt = this.now();
    if (stopReason) this.lastStopReason = stopReason;
    if (stopReason === "aborted")
      this.userAction("abort_inferred", { "pi.abort.source": "agent_stop_reason" });
    const failed = errorOutcome(stopReason);
    this.run.span.setAttributes({ ...(stopReason ? { "pi.stop_reason": stopReason } : {}) });
    if (failed) this.run.span.setAttribute(ATTR_ERROR_TYPE, "agent_error");
    this.run.span.setStatus({ code: failed ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
    this.run.span.end();
    this.runtime.metrics.record(
      "pi.agent.run.duration",
      durationSeconds(this.run.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ ...(stopReason ? { "pi.stop_reason": stopReason } : {}) }),
    );
    this.run = undefined;
  }

  startTurn(index: number): void {
    if (!this.interaction) return;
    if (this.turn) this.endTurn("superseded");
    this.turnTruncated = false;
    this.turn = this.startSpan(
      SPAN_TURN,
      SpanKind.INTERNAL,
      { "pi.turn.index": index },
      this.run?.context ?? this.interaction.context,
    );
    this.runtime.metrics.count("pi.turn.count", 1, this.activityMetricAttributes());
  }

  endTurn(outcome = "ok", assistant?: AssistantDetails, toolResultCount?: number): void {
    if (!this.turn) return;
    this.endWait("interrupted");
    this.endLlm(assistant ?? { stopReason: "incomplete" });
    for (const toolCallId of [...this.tools.keys()].reverse()) {
      this.endTool(toolCallId, false, undefined, undefined, "turn_end");
    }
    const endedAt = this.now();
    const stopReason = assistant?.stopReason;
    if (stopReason) this.lastStopReason = stopReason;
    applyUsage(this.turn.span, assistant?.usage);
    this.turn.span.setAttributes({
      "pi.turn.outcome": outcome,
      ...(stopReason ? { "pi.stop_reason": stopReason } : {}),
      ...(toolResultCount !== undefined ? { "pi.turn.tool_result_count": toolResultCount } : {}),
    });
    this.turn.span.setStatus(
      errorOutcome(stopReason) ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.UNSET },
    );
    if (errorOutcome(stopReason)) this.turn.span.setAttribute(ATTR_ERROR_TYPE, "agent_error");
    this.turn.span.end();
    this.runtime.metrics.record(
      "pi.turn.duration",
      durationSeconds(this.turn.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.turn = undefined;
    this.turnTruncated = false;
  }

  hasOpenLlm(): boolean {
    return this.llm !== undefined;
  }

  startLlm(details: LlmStartDetails): void {
    if (this.llm) this.endLlm({ stopReason: "superseded" });
    const synthesized = details.synthesized === true || !details.provider || !details.model;
    const operation = synthesized ? undefined : (details.operation ?? "chat");
    const attributes: Attributes = {
      ...(operation ? { [ATTR_OPERATION]: operation } : {}),
      ...(details.provider ? { [ATTR_PROVIDER]: details.provider } : {}),
      ...(details.model ? { [ATTR_REQUEST_MODEL]: details.model } : {}),
      ...(details.contextTokens !== undefined
        ? { [ATTR_CONTEXT_TOKENS]: details.contextTokens }
        : {}),
      ...(details.contextWindow !== undefined
        ? { [ATTR_CONTEXT_WINDOW]: details.contextWindow }
        : {}),
      ...(details.contextPercent !== undefined
        ? { [ATTR_CONTEXT_PERCENT]: details.contextPercent }
        : {}),
      ...(details.thinkingLevel ? { [ATTR_THINKING_LEVEL]: details.thinkingLevel } : {}),
      "pi.llm.synthesized": synthesized,
    };
    const slot = this.startSpan(
      synthesized ? "pi.assistant.lifecycle" : `${operation} ${details.model}`,
      synthesized ? SpanKind.INTERNAL : SpanKind.CLIENT,
      attributes,
      this.activeParent(),
      details.startedAt,
    );
    if (!synthesized && this.interaction) this.inferenceCalls += 1;
    this.llm = {
      ...slot,
      synthesized,
      ...(operation ? { operation } : {}),
      ...(details.provider ? { provider: details.provider } : {}),
      ...(details.model ? { requestModel: details.model } : {}),
      ...(details.thinkingLevel ? { thinkingLevel: details.thinkingLevel } : {}),
    };
    const modelAttributes = this.metricAttributes({
      ...(details.provider ? { [ATTR_PROVIDER]: details.provider } : {}),
      ...(details.model ? { [ATTR_REQUEST_MODEL]: details.model } : {}),
    });
    this.runtime.metrics.count("pi.llm.requests", 1, {
      ...modelAttributes,
      ...thinkingDimension(details.thinkingLevel),
    });
    if (this.session && !synthesized) this.totals.llmRequests += 1;
    if (details.contextPercent !== undefined) {
      this.runtime.metrics.record(
        "pi.context.utilization",
        details.contextPercent,
        "%",
        modelAttributes,
      );
    }
  }

  noteProviderResponse(details: ProviderResponseDetails): void {
    if (!this.llm) return;
    if (details.requestId) this.llm.requestId = details.requestId;
    this.llm.span.setAttributes({
      "http.response.status_code": details.status,
      ...(details.requestId ? { [ATTR_PROVIDER_REQUEST_ID]: details.requestId } : {}),
    });
    if (details.status >= 400) {
      this.llm.providerError = details.status === 429 ? "rate_limit" : "http_error";
      this.llm.span.setAttribute(ATTR_ERROR_TYPE, this.llm.providerError);
      this.llm.span.setStatus({ code: SpanStatusCode.ERROR });
    }
  }

  endLlm(assistant: AssistantDetails): void {
    if (!this.llm) return;
    const endedAt = this.now();
    const provider = assistant.provider ?? this.llm.provider;
    const model = assistant.model;
    const observed = !this.llm.synthesized;
    const failed = errorOutcome(assistant.stopReason) || this.llm.providerError !== undefined;
    const truncated = assistant.stopReason === "length";
    const errorType = this.llm.providerError ?? "provider_error";
    if (["stop", "length", "toolUse", "error", "aborted"].includes(assistant.stopReason ?? ""))
      this.lastStopReason = assistant.stopReason;
    const requestModel = assistant.requestModel ?? this.llm.requestModel;
    if (requestModel) {
      this.llm.span.setAttribute(ATTR_REQUEST_MODEL, requestModel);
      if (observed) this.llm.span.updateName(`${this.llm.operation} ${requestModel}`);
    }
    if (provider) this.llm.span.setAttribute(ATTR_PROVIDER, provider);
    if (model) this.llm.span.setAttribute(ATTR_RESPONSE_MODEL, model);
    const responseId = assistant.responseId;
    if (responseId) this.llm.span.setAttribute(ATTR_RESPONSE_ID, responseId);
    if (assistant.providerThinkingLevel)
      this.llm.span.setAttribute(ATTR_PROVIDER_THINKING_LEVEL, assistant.providerThinkingLevel);
    const normalFinish = ["stop", "length", "toolUse"].includes(assistant.stopReason ?? "");
    this.llm.span.setAttribute("gen_ai.response.finish_reasons", [
      failed || !normalFinish
        ? "error"
        : assistant.stopReason === "toolUse"
          ? "tool_calls"
          : assistant.stopReason === "length"
            ? "length"
            : "stop",
    ]);
    if (assistant.stopReason) this.llm.span.setAttribute("pi.stop_reason", assistant.stopReason);
    if (truncated) this.llm.span.setAttribute(ATTR_LLM_TRUNCATED, true);
    applyUsage(this.llm.span, assistant.usage);
    const modelAttributes: Attributes = {
      ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
      ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
    };
    if (failed) {
      this.llm.span.setAttribute(ATTR_ERROR_TYPE, errorType);
      this.llm.span.setStatus({ code: SpanStatusCode.ERROR });
      if (observed)
        this.runtime.metrics.count(
          "pi.llm.errors",
          1,
          this.metricAttributes({
            ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
            [ATTR_ERROR_TYPE]: errorType,
          }),
        );
      if (observed)
        this.runtime.logs.emit(
          "warn",
          "gen_ai.client.operation.exception",
          "LLM request failed",
          {
            ...this.baseAttributes(),
            ...modelAttributes,
            [ATTR_ERROR_TYPE]: errorType,
            "exception.type": this.llm.providerError ? "HTTPError" : "Error",
            "exception.message":
              sanitizeError(
                assistant.errorMessage ??
                  (this.llm.providerError
                    ? "Provider returned an unsuccessful HTTP response"
                    : "Provider operation failed"),
                this.session?.cwd ?? process.cwd(),
              ).message ?? "Provider operation failed",
          },
          this.llm.context,
        );
    } else {
      this.llm.span.setStatus({ code: normalFinish ? SpanStatusCode.OK : SpanStatusCode.UNSET });
    }
    if (truncated) {
      this.turnTruncated = true;
      this.runtime.metrics.count("pi.llm.truncated", 1, this.metricAttributes(modelAttributes));
    }
    this.llm.span.end();
    this.runtime.metrics.record(
      "pi.llm.duration",
      durationSeconds(this.llm.startedAt, endedAt),
      "s",
      this.metricAttributes({
        ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
        ...(this.llm.requestModel ? { [ATTR_REQUEST_MODEL]: this.llm.requestModel } : {}),
        ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
        "pi.llm.synthesized": this.llm.synthesized,
      }),
    );
    if (observed)
      this.runtime.metrics.record(
        "gen_ai.client.operation.duration",
        durationSeconds(this.llm.startedAt, endedAt),
        "s",
        this.metricAttributes({
          [ATTR_OPERATION]: this.llm.operation ?? "chat",
          ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
          ...(requestModel ? { [ATTR_REQUEST_MODEL]: requestModel } : {}),
          ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
          ...(failed ? { [ATTR_ERROR_TYPE]: errorType } : {}),
        }),
      );
    this.recordUsageMetrics(
      assistant.usage,
      "assistant",
      provider,
      model,
      requestModel,
      this.llm.thinkingLevel,
    );
    this.llm = undefined;
  }

  startTool(
    toolCallId: string,
    toolName: string,
    inputAttributes: Attributes,
    details: ToolStartDetails = {},
  ): void {
    if (this.tools.has(toolCallId))
      this.endTool(toolCallId, true, new Error("Duplicate tool start"));
    const slot = this.startSpan(
      `${SPAN_TOOL} ${toolName}`,
      SpanKind.INTERNAL,
      {
        [ATTR_OPERATION]: "execute_tool",
        [ATTR_TOOL_NAME]: toolName,
        [ATTR_TOOL_CALL_ID]: toolCallId,
        ...(details.parentToolCallId ? { "pi.tool.parent_call_id": details.parentToolCallId } : {}),
        ...(details.source ? { [ATTR_TOOL_SOURCE]: details.source } : {}),
        ...(details.scope ? { [ATTR_TOOL_SCOPE]: details.scope } : {}),
        ...(this.turnTruncated ? { [ATTR_TOOL_TRUNCATED_CALL]: true } : {}),
        ...inputAttributes,
      },
      (details.parentToolCallId ? this.tools.get(details.parentToolCallId)?.context : undefined) ??
        this.activeParent(),
    );
    if (this.interaction && !details.parentToolCallId) this.toolCalls += 1;
    if (this.session && !details.parentToolCallId) this.totals.toolCalls += 1;
    this.tools.set(toolCallId, { ...slot, name: toolName });
    this.runtime.metrics.count(
      "pi.tool.calls",
      1,
      this.metricAttributes({
        [ATTR_TOOL_NAME]: toolName,
        ...(details.source ? { [ATTR_TOOL_SOURCE]: details.source } : {}),
      }),
    );
  }

  endTool(
    toolCallId: string,
    isError: boolean,
    error?: unknown,
    output?: ToolOutputSummary,
    cleanupReason?: string,
    aborted = false,
  ): void {
    const slot = this.tools.get(toolCallId);
    if (!slot) return;
    const endedAt = this.now();
    const outcome = aborted ? "aborted" : cleanupReason ? "interrupted" : isError ? "error" : "ok";
    slot.span.setAttribute("pi.tool.outcome", outcome);
    if (cleanupReason) slot.span.setAttribute("pi.telemetry.closure_reason", cleanupReason);
    else slot.span.setAttribute("pi.tool.is_error", isError);
    if (output) {
      slot.span.setAttributes({
        [ATTR_TOOL_OUTPUT_SIZE]: output.textLength,
        [ATTR_TOOL_OUTPUT_IMAGES]: output.imageCount,
        ...(output.exitCode !== undefined ? { "pi.command.exit_code": output.exitCode } : {}),
        ...(output.wallTimeSeconds !== undefined
          ? { "pi.command.wall_time_seconds": output.wallTimeSeconds }
          : {}),
      });
    }
    if (isError) {
      const sanitized = {
        ...sanitizeError(error, this.session?.cwd ?? process.cwd()),
        type: "tool_execution_error",
      };
      slot.span.setAttribute(ATTR_ERROR_TYPE, sanitized.type);
      if (sanitized.message) slot.span.setAttribute("error.message", sanitized.message);
      slot.span.setStatus({ code: SpanStatusCode.ERROR });
      this.runtime.metrics.count(
        "pi.tool.errors",
        1,
        this.metricAttributes({
          [ATTR_TOOL_NAME]: slot.name,
          [ATTR_ERROR_TYPE]: sanitized.type,
        }),
      );
      this.runtime.logs.emit(
        "error",
        "pi.tool.error",
        "tool execution failed",
        {
          ...this.baseAttributes(),
          [ATTR_TOOL_NAME]: slot.name,
          [ATTR_TOOL_CALL_ID]: toolCallId,
          [ATTR_ERROR_TYPE]: sanitized.type,
          ...(sanitized.message ? { "error.message": sanitized.message } : {}),
        },
        slot.context,
      );
    } else {
      slot.span.setStatus({
        code: cleanupReason || aborted ? SpanStatusCode.UNSET : SpanStatusCode.OK,
      });
    }
    slot.span.end();
    this.runtime.metrics.record(
      "gen_ai.execute_tool.duration",
      durationSeconds(slot.startedAt, endedAt),
      "s",
      this.metricAttributes({
        [ATTR_OPERATION]: "execute_tool",
        [ATTR_TOOL_NAME]: slot.name,
        ...(isError ? { [ATTR_ERROR_TYPE]: "tool_execution_error" } : {}),
      }),
    );
    this.tools.delete(toolCallId);
    this.runtime.metrics.record(
      "pi.tool.duration",
      durationSeconds(slot.startedAt, endedAt),
      "s",
      this.metricAttributes({ [ATTR_TOOL_NAME]: slot.name, outcome }),
    );
  }

  startWait(kind: string): void {
    if (this.wait) return;
    this.wait = this.startSpan(
      SPAN_USER_WAIT,
      SpanKind.INTERNAL,
      {
        "pi.user.intervention": "ui_prompt",
        "pi.ui.prompt_kind": kind,
      },
      this.activeParent(),
    );
    this.runtime.metrics.count(
      "pi.user.intervention.count",
      1,
      this.activityMetricAttributes({ kind: "ui_prompt" }),
    );
  }

  endWait(outcome = "completed"): void {
    if (!this.wait) return;
    const endedAt = this.now();
    this.wait.span.setAttribute("pi.user.wait.outcome", outcome);
    this.wait.span.setStatus(
      outcome === "completed" ? { code: SpanStatusCode.OK } : { code: SpanStatusCode.UNSET },
    );
    this.wait.span.end();
    this.runtime.metrics.record(
      "pi.user.wait.duration",
      durationSeconds(this.wait.startedAt, endedAt),
      "s",
      this.activityMetricAttributes({ outcome }),
    );
    this.wait = undefined;
  }

  userAction(kind: string, attributes: Attributes = {}): void {
    const eventAttributes = { "pi.user.intervention": kind, ...attributes };
    this.runtime.metrics.count(
      "pi.user.intervention.count",
      1,
      this.activityMetricAttributes({ kind }),
    );
    this.runtime.logs.emit(
      "info",
      "pi.user.intervention",
      "user intervention observed",
      {
        ...this.baseAttributes(),
        ...eventAttributes,
      },
      this.interaction?.context,
    );
    this.addInteractionEvent("pi.user.intervention", eventAttributes);
  }

  productEvent(event: unknown): void {
    const product = sanitizeProductEvent(event);
    if (!product) return;
    recordProductEvent(this.runtime, product, this.baseAttributes());
    if (product.category !== "compaction") return;

    if (product.stage === "trigger" && product.trigger === "extension_threshold") {
      // The marker precedes ctx.compact(), whose native reason is always manual.
      // Completion callbacks also clear it if preparation never reaches the hook.
      this.pendingCompactionTrigger =
        product.outcome === "auto_selected" ? product.trigger : undefined;
      return;
    }
    if (product.stage !== "summarize" || !this.compaction) return;
    if (product.model) {
      this.compaction.model = product.model;
      this.compaction.span.setAttribute("pi.compaction.model", product.model);
    }
    if (product.outcome === "pending") {
      this.compaction.span.setAttribute("pi.compaction.custom_summary", true);
    }
    if (
      product.outcome === "failed" ||
      product.outcome === "cancelled" ||
      product.outcome === "skipped"
    ) {
      // Pi translates hook cancellation into an abort, losing the real failure/skip.
      // Close once with the content-free outcome before that native event arrives.
      this.compactionOutcomeHandledByExtension = true;
      this.endCompaction({
        outcome:
          product.outcome === "cancelled"
            ? "aborted"
            : product.outcome === "skipped"
              ? "skipped"
              : "failed",
        reason: product.reason,
        error:
          product.outcome === "failed"
            ? new Error(
                product.reason === "timeout"
                  ? "Configured compaction timed out"
                  : "Configured compaction failed",
              )
            : undefined,
      });
    }
  }

  operationalEvent(eventName: string, attributes: Attributes = {}): void {
    this.runtime.logs.emit(
      "info",
      eventName,
      "pi operational event observed",
      {
        ...this.baseAttributes(),
        ...attributes,
      },
      this.interaction?.context,
    );
    this.addInteractionEvent(eventName, attributes);
  }

  /** Record a telemetry-pipeline failure inside the extension itself (handler threw, etc.). */
  noteInternalFailure(reason: string): void {
    this.runtime.metrics.count("pi.telemetry.dropped", 1, { "otel.signal": "handler", reason });
  }

  hasOpenCompaction(): boolean {
    return this.compaction !== undefined;
  }

  consumeHandledCompactionOutcome(): boolean {
    const handled = this.compactionOutcomeHandledByExtension;
    this.compactionOutcomeHandledByExtension = false;
    return handled;
  }

  startCompaction(details: CompactionStartDetails): void {
    if (this.compaction) this.endCompaction({ outcome: "superseded" });
    this.compactionOutcomeHandledByExtension = false;
    const trigger =
      details.reason === "manual" && this.pendingCompactionTrigger === "extension_threshold"
        ? this.pendingCompactionTrigger
        : details.reason;
    this.pendingCompactionTrigger = undefined;
    const request = sanitizeProductEvent({
      category: "compaction",
      stage: "request",
      outcome: "pending",
      trigger,
      model: details.model,
    });
    const reason = trigger === "extension_threshold" ? "threshold" : details.reason;
    const span = this.startSpan(
      SPAN_COMPACTION,
      SpanKind.INTERNAL,
      {
        "pi.compaction.reason": reason,
        "pi.compaction.native_reason": details.reason,
        ...(details.inferred ? { "pi.compaction.start_inferred": true } : {}),
        ...(request?.trigger ? { "pi.compaction.trigger": request.trigger } : {}),
        ...(request?.model ? { "pi.compaction.model": request.model } : {}),
        "pi.compaction.will_retry": details.willRetry,
        ...(details.tokensBefore !== undefined
          ? { "pi.compaction.tokens_before": details.tokensBefore }
          : {}),
      },
      this.interaction?.context ?? ROOT_CONTEXT,
    );
    this.compaction = {
      ...span,
      reason,
      ...(request?.trigger ? { trigger: request.trigger } : {}),
      ...(request?.model ? { model: request.model } : {}),
    };
    this.runtime.metrics.count(
      "pi.compaction.count",
      1,
      this.metricAttributes({ reason, ...(request?.trigger ? { trigger: request.trigger } : {}) }),
    );
    this.productEvent(request);
    if (trigger === "manual") this.userAction("manual_compaction");
  }

  endCompaction(details: {
    outcome: string;
    reason?: string | undefined;
    fromExtension?: boolean;
    error?: unknown;
    usage?: UsageDetails;
  }): void {
    if (!this.compaction) return;
    const endedAt = this.now();
    const { reason, trigger, model, startedAt } = this.compaction;
    this.compaction.span.setAttributes({
      "pi.compaction.outcome": details.outcome,
      ...(details.fromExtension !== undefined
        ? { "pi.compaction.from_extension": details.fromExtension }
        : {}),
    });
    applyUsage(this.compaction.span, details.usage);
    if (details.outcome === "failed") {
      const sanitized = sanitizeError(details.error, this.session?.cwd ?? process.cwd());
      this.compaction.span.setAttribute(ATTR_ERROR_TYPE, sanitized.type);
      if (sanitized.message) this.compaction.span.setAttribute("error.message", sanitized.message);
      this.compaction.span.setStatus({ code: SpanStatusCode.ERROR });
      this.runtime.logs.emit(
        "error",
        "pi.compaction.failed",
        "session compaction failed",
        {
          ...this.baseAttributes(),
          "pi.compaction.outcome": details.outcome,
          "pi.compaction.reason": reason,
          ...(trigger ? { "pi.compaction.trigger": trigger } : {}),
          [ATTR_ERROR_TYPE]: sanitized.type,
          ...(sanitized.message ? { "error.message": sanitized.message } : {}),
        },
        this.compaction.context,
      );
    } else {
      this.compaction.span.setStatus({
        code: details.outcome === "ok" ? SpanStatusCode.OK : SpanStatusCode.UNSET,
      });
    }
    this.compaction.span.end();
    this.runtime.metrics.record(
      "pi.compaction.duration",
      durationSeconds(this.compaction.startedAt, endedAt),
      "s",
      this.metricAttributes({ reason, ...(trigger ? { trigger } : {}), outcome: details.outcome }),
    );
    this.compaction = undefined;
    if (details.usage) {
      const separator = model?.indexOf("/") ?? -1;
      // Compaction reports aggregate usage, not a provider response model identity.
      // Attribute the selected/requested summary model without inventing a response alias.
      this.recordUsageMetrics(
        details.usage,
        "compaction",
        separator > 0 ? model?.slice(0, separator) : undefined,
        undefined,
        separator > 0 ? model?.slice(separator + 1) : undefined,
      );
    }
    this.productEvent({
      category: "compaction",
      stage: "complete",
      outcome:
        details.outcome === "ok"
          ? "success"
          : details.outcome === "failed"
            ? "failed"
            : details.outcome === "skipped"
              ? "skipped"
              : "cancelled",
      reason:
        details.reason ??
        (details.outcome === "failed"
          ? "unavailable"
          : details.outcome === "ok"
            ? undefined
            : "cancelled"),
      trigger,
      model,
      durationMs: Math.max(0, endedAt - startedAt),
    });
  }

  /** Usage produced outside the main assistant stream: tool-side LLM work or branch summaries. */
  recordAuxiliaryUsage(
    source: Exclude<UsageSource, "assistant">,
    usage: UsageDetails | undefined,
    provider?: string,
    model?: string,
  ): void {
    if (!usage) return;
    this.recordUsageMetrics(usage, source, provider, model);
  }

  private recordUsageMetrics(
    usage: UsageDetails | undefined,
    source: UsageSource,
    provider?: string,
    model?: string,
    requestModel?: string,
    thinkingLevel?: string,
  ): void {
    if (!usage) return;
    if (this.session) {
      this.totals.cost += usage.cost ?? 0;
      this.totals.input += usage.input ?? 0;
      this.totals.output += usage.output ?? 0;
      this.totals.cacheRead += usage.cacheRead ?? 0;
      this.totals.cacheWrite += usage.cacheWrite ?? 0;
      this.totals.reasoning += usage.reasoning ?? 0;
    }
    const attributes: Attributes = {
      [ATTR_USAGE_SOURCE]: source,
      ...(requestModel ? { [ATTR_REQUEST_MODEL]: requestModel } : {}),
      ...(provider ? { [ATTR_PROVIDER]: provider } : {}),
      ...(model ? { [ATTR_RESPONSE_MODEL]: model } : {}),
      ...thinkingDimension(thinkingLevel),
    };
    if (usage.input !== undefined)
      this.runtime.metrics.count("pi.tokens.input", usage.input, attributes);
    if (usage.output !== undefined)
      this.runtime.metrics.count("pi.tokens.output", usage.output, attributes);
    if (usage.cacheRead !== undefined)
      this.runtime.metrics.count("pi.tokens.cache_read", usage.cacheRead, attributes);
    if (usage.cacheWrite !== undefined)
      this.runtime.metrics.count("pi.tokens.cache_write", usage.cacheWrite, attributes);
    if (usage.reasoning !== undefined)
      this.runtime.metrics.count("pi.tokens.reasoning", usage.reasoning, attributes);
    if (usage.cost !== undefined) this.runtime.metrics.count("pi.cost", usage.cost, attributes);
  }
}
