import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  PRODUCT_EVENT_CHANNEL,
  type ProductEvent,
  sanitizeProductEvent,
} from "../../../../telemetry/product-events.ts";
import { resolveConfig as defaultResolveConfig, type OrgTelemetryConfig } from "./config.ts";
import {
  readPiVersion as defaultReadPiVersion,
  describeEnvironment,
  type ResourceEnvironment,
} from "./environment.ts";
import {
  resolveIdentity as defaultResolveIdentity,
  type IdentityOptions,
  type TelemetryIdentity,
} from "./identity.ts";
import { createOtelRuntime, type RuntimeOptions } from "./otel/runtime.ts";
import { resolveRepoSlug as defaultResolveRepoSlug, type RepoSlugOptions } from "./repo.ts";
import {
  sanitizeText,
  summarizeShellCommand,
  summarizeToolInput,
  summarizeToolOutput,
} from "./sanitization.ts";
import type { TelemetryRuntime } from "./telemetry-types.ts";
import {
  AgentTelemetryTracker,
  type AssistantDetails,
  type LlmStartDetails,
  type ProviderResponseDetails,
  type ToolStartDetails,
  type UsageDetails,
} from "./tracker.ts";

export interface TelemetryDependencies {
  readonly resolveConfig: (env?: NodeJS.ProcessEnv) => OrgTelemetryConfig | undefined;
  readonly resolveIdentity: (options: IdentityOptions) => Promise<TelemetryIdentity>;
  readonly resolveRepoSlug: (options: RepoSlugOptions) => Promise<string | undefined>;
  readonly readPiVersion: () => Promise<string | undefined>;
  readonly createRuntime: (
    config: OrgTelemetryConfig,
    identity: TelemetryIdentity,
    environment: ResourceEnvironment,
    options: RuntimeOptions,
  ) => TelemetryRuntime;
}

const defaultDependencies: TelemetryDependencies = {
  resolveConfig: defaultResolveConfig,
  resolveIdentity: defaultResolveIdentity,
  resolveRepoSlug: defaultResolveRepoSlug,
  readPiVersion: defaultReadPiVersion,
  createRuntime: createOtelRuntime,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(
  record: Record<string, unknown> | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function finiteNumber(
  record: Record<string, unknown> | undefined,
  ...names: string[]
): number | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function summarizeUsage(value: unknown): UsageDetails | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = finiteNumber(usage, "input");
  const output = finiteNumber(usage, "output");
  const cacheRead = finiteNumber(usage, "cacheRead");
  const cacheWrite = finiteNumber(usage, "cacheWrite");
  const reasoning = finiteNumber(usage, "reasoning");
  const costValue = usage.cost;
  const costRecord = asRecord(costValue);
  const cost =
    typeof costValue === "number" && Number.isFinite(costValue)
      ? costValue
      : finiteNumber(costRecord, "total");
  const costInput = finiteNumber(costRecord, "input");
  const costOutput = finiteNumber(costRecord, "output");
  const costCacheRead = finiteNumber(costRecord, "cacheRead");
  const costCacheWrite = finiteNumber(costRecord, "cacheWrite");
  const result: UsageDetails = {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(costInput !== undefined ? { costInput } : {}),
    ...(costOutput !== undefined ? { costOutput } : {}),
    ...(costCacheRead !== undefined ? { costCacheRead } : {}),
    ...(costCacheWrite !== undefined ? { costCacheWrite } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function summarizeAssistant(value: unknown, cwd: string): AssistantDetails {
  const message = asRecord(value);
  if (message?.role !== "assistant") return {};
  const provider = stringValue(message, "provider");
  // `responseModel` is the provider-reported model; `model` is the requested one.
  const model = stringValue(message, "responseModel");
  const requestModel = stringValue(message, "model");
  const responseId = stringValue(message, "responseId");
  const providerThinkingLevel = stringValue(message, "providerThinkingLevel");
  const stopReason = stringValue(message, "stopReason", "finishReason", "finish_reason");
  const rawError = stringValue(message, "errorMessage", "error_message");
  const usage = summarizeUsage(message.usage);
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(requestModel ? { requestModel } : {}),
    ...(responseId ? { responseId } : {}),
    ...(providerThinkingLevel ? { providerThinkingLevel } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(rawError ? { errorMessage: sanitizeText(rawError, cwd) } : {}),
    ...(usage ? { usage } : {}),
  };
}

function lastAssistant(messages: readonly unknown[], cwd: string): AssistantDetails {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.role === "assistant") return summarizeAssistant(message, cwd);
  }
  return {};
}

// Only APIs whose operation is known from the pinned Pi implementation.
function inferenceOperation(api: string | undefined): string | undefined {
  if (["google-generative-ai", "google-vertex"].includes(api ?? "")) return "generate_content";
  if (
    [
      "openai-completions",
      "openai-responses",
      "openai-codex-responses",
      "azure-openai-responses",
      "anthropic-messages",
      "bedrock-converse-stream",
      "mistral-conversations",
    ].includes(api ?? "")
  )
    return "chat";
  return undefined;
}

const REQUEST_ID_HEADERS = [
  "x-request-id",
  "request-id",
  "anthropic-request-id",
  "openai-response-id",
  "cf-ray",
];

function providerRequestId(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  const lowercase = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" && value) lowercase.set(name.toLowerCase(), value);
  }
  for (const name of REQUEST_ID_HEADERS) {
    const value = lowercase.get(name);
    if (value) return value;
  }
  return undefined;
}

/** Context-window state at request time; getters may throw on a stale runtime, so guard them. */
function contextDetails(ctx: ExtensionContext): Partial<LlmStartDetails> {
  try {
    const usage = ctx.getContextUsage();
    const thinkingLevel = ctx.thinkingLevel;
    return {
      ...(usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)
        ? { contextTokens: usage.tokens }
        : {}),
      ...(usage && Number.isFinite(usage.contextWindow)
        ? { contextWindow: usage.contextWindow }
        : {}),
      ...(usage && typeof usage.percent === "number" && Number.isFinite(usage.percent)
        ? { contextPercent: usage.percent }
        : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    };
  } catch {
    return {};
  }
}

function classifyToolSource(source: string | undefined): string {
  if (!source) return "unknown";
  if (source === "builtin" || source === "sdk") return source;
  return "extension";
}

function safeRuntimeFailure(
  diagnostics: boolean,
  quiet: boolean,
  error: unknown,
  cwd: string,
): void {
  if (!diagnostics || quiet) return;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[pi-org-telemetry] initialization failed: ${sanitizeText(message, cwd)}\n`);
}

/**
 * Build the extension factory with injectable dependencies (used by tests). The default export
 * below keeps pi's `(pi: ExtensionAPI) => void` loader contract unchanged.
 */
export function createPiOrgTelemetry(
  overrides: Partial<TelemetryDependencies> = {},
): (pi: ExtensionAPI) => void {
  const deps: TelemetryDependencies = { ...defaultDependencies, ...overrides };

  return function piOrgTelemetry(pi: ExtensionAPI): void {
    let runtime: TelemetryRuntime | undefined;
    let tracker: AgentTelemetryTracker | undefined;
    const pendingProducts: ProductEvent[] = [];
    const extensionStartedAt = Date.now();
    let recordedLaunch = false;
    pi.events?.on(PRODUCT_EVENT_CHANNEL, (value) => {
      const event = sanitizeProductEvent(value);
      if (!event) return;
      try {
        if (tracker) tracker.productEvent(event);
        else if (pendingProducts.length < 128) pendingProducts.push(event);
      } catch {
        /* Do not leak bus payloads in Pi diagnostics. */
      }
    });
    let pendingProjectTrust: string | undefined;
    let cwd = process.cwd();
    let toolSources: Map<string, { source: string; scope: string }> | undefined;
    let activeRun = false;
    let requestPhase = false;
    let pendingRequest:
      | {
          details: Partial<LlmStartDetails>;
          startedAt: number;
          response?: ProviderResponseDetails;
          ambiguous: boolean;
        }
      | undefined;

    function observeInference(provider?: string, model?: string, api?: string): void {
      if (!tracker || !activeRun || tracker.hasOpenLlm()) return;
      const operation = inferenceOperation(api);
      const observed =
        pendingRequest && !pendingRequest.ambiguous && provider && model && operation;
      tracker.startLlm({
        ...pendingRequest?.details,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(operation ? { operation } : {}),
        ...(observed && pendingRequest ? { startedAt: pendingRequest.startedAt } : {}),
        synthesized: !observed,
      });
      if (observed && pendingRequest?.response)
        tracker.noteProviderResponse(pendingRequest.response);
    }

    /** Telemetry must never throw into pi. Failures are counted and swallowed. */
    function guard<E>(
      name: string,
      handler: (event: E, ctx: ExtensionContext) => void | Promise<void>,
    ) {
      return (event: E, ctx: ExtensionContext): void | Promise<void> => {
        const fail = (): void => {
          try {
            tracker?.noteInternalFailure(name);
          } catch {
            // Nothing else to do; telemetry is best effort.
          }
        };
        try {
          const result = handler(event, ctx);
          if (result instanceof Promise) return result.catch(fail);
          return result;
        } catch {
          fail();
          return undefined;
        }
      };
    }

    function toolProvenance(toolName: string): ToolStartDetails {
      const lookup = (): { source: string; scope: string } | undefined =>
        toolSources?.get(toolName);
      let found = lookup();
      if (!found) {
        toolSources = new Map();
        for (const tool of pi.getAllTools()) {
          toolSources.set(tool.name, {
            source: classifyToolSource(tool.sourceInfo?.source),
            scope: ["user", "project", "temporary"].includes(tool.sourceInfo?.scope ?? "")
              ? (tool.sourceInfo?.scope ?? "unknown")
              : "unknown",
          });
        }
        found = lookup();
      }
      return found ?? { source: "unknown", scope: "unknown" };
    }

    pi.on("project_trust", (event) => {
      try {
        pendingProjectTrust = basename(event.cwd);
      } catch {
        // Passive observer: never influence the trust decision.
      }
      return { trusted: "undecided" };
    });

    pi.on(
      "session_start",
      guard("session_start", async (event, ctx) => {
        const previous = runtime;
        tracker?.endSession("replaced");
        tracker = undefined;
        runtime = undefined;
        activeRun = false;
        pendingRequest = undefined;
        toolSources = undefined;
        await previous?.shutdown();
        const config = deps.resolveConfig();
        if (!config) {
          pendingProducts.length = 0;
          return;
        }
        cwd = ctx.cwd;
        const quiet = ctx.mode === "tui";
        try {
          const [identity, repoSlug, piVersion] = await Promise.all([
            deps.resolveIdentity({ cwd: ctx.cwd }),
            deps.resolveRepoSlug({ cwd: ctx.cwd }),
            deps.readPiVersion(),
          ]);
          runtime = deps.createRuntime(config, identity, describeEnvironment(piVersion), { quiet });
          tracker = new AgentTelemetryTracker(runtime);
          const sessionId = ctx.sessionManager.getSessionId();
          const sessionFile = ctx.sessionManager.getSessionFile();
          const inheritedSessionId = process.env.PI_SESSION_ID?.trim();
          tracker.startSession({
            sessionId,
            project: basename(ctx.cwd),
            mode: ctx.mode,
            reason: event.reason,
            ephemeral: sessionFile === undefined,
            cwd: ctx.cwd,
            ...(repoSlug ? { repoSlug } : {}),
            ...(inheritedSessionId && inheritedSessionId !== sessionId
              ? { parentSessionId: inheritedSessionId }
              : {}),
          });
          for (const product of pendingProducts.splice(0)) tracker.productEvent(product);
          if (!recordedLaunch) {
            recordedLaunch = true;
            const inheritedStart = Number(process.env["PI_AXON_LAUNCH_STARTED_AT"]);
            const start =
              Number.isFinite(inheritedStart) &&
              inheritedStart > 0 &&
              inheritedStart <= Date.now() &&
              Date.now() - inheritedStart <= 86400000
                ? inheritedStart
                : extensionStartedAt;
            tracker.productEvent({
              category: "startup",
              stage: "ready",
              outcome: "success",
              durationMs: Date.now() - start,
            });
            tracker.productEvent({
              category: "release",
              stage: "launch",
              outcome: "success",
              version: process.env.PI_AXON_CLI_VERSION ?? "unknown",
            });
          }
          if (pendingProjectTrust) {
            tracker.operationalEvent("pi.project.trust_requested", {
              "pi.project.name": pendingProjectTrust,
            });
            pendingProjectTrust = undefined;
          }
        } catch (error: unknown) {
          safeRuntimeFailure(config.diagnostics, quiet, error, ctx.cwd);
          const failedRuntime = runtime;
          tracker?.endSession("initialization_failed");
          tracker = undefined;
          runtime = undefined;
          await failedRuntime?.shutdown();
        }
      }),
    );

    pi.on(
      "session_shutdown",
      guard("session_shutdown", async (event) => {
        tracker?.endSession(event.reason);
        activeRun = false;
        pendingRequest = undefined;
        tracker = undefined;
        const currentRuntime = runtime;
        runtime = undefined;
        await currentRuntime?.shutdown();
      }),
    );

    pi.on(
      "input",
      guard("input", (event) => {
        tracker?.noteInput({
          source: event.source,
          ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
          textLength: event.text.length,
          imageCount: event.images?.length ?? 0,
        });
        if (event.streamingBehavior) {
          tracker?.userAction(event.streamingBehavior === "steer" ? "steer" : "follow_up", {
            "pi.input.source": event.source,
          });
        }
      }),
    );

    pi.on(
      "before_agent_start",
      guard("before_agent_start", (event) => {
        if (event.messageType === "user") {
          tracker?.startInteraction(event.prompt.length, event.images?.length ?? 0);
        } else {
          // Custom-message runs have no user prompt or image-count attributes.
          tracker?.startInteraction();
        }
      }),
    );

    pi.on(
      "agent_start",
      guard("agent_start", () => {
        activeRun = true;
        requestPhase = true;
        pendingRequest = undefined;
        tracker?.startRun();
      }),
    );

    pi.on(
      "agent_end",
      guard("agent_end", (event) => {
        tracker?.endRun(lastAssistant(event.messages, cwd).stopReason);
        requestPhase = false;
        activeRun = false;
        pendingRequest = undefined;
      }),
    );

    pi.on(
      "agent_settled",
      guard("agent_settled", () => tracker?.endInteraction("settled")),
    );

    pi.on(
      "turn_start",
      guard("turn_start", (event) => {
        requestPhase = true;
        pendingRequest = undefined;
        tracker?.startTurn(event.turnIndex);
      }),
    );

    pi.on(
      "turn_end",
      guard("turn_end", (event) => {
        tracker?.endTurn("ok", summarizeAssistant(event.message, cwd), event.toolResults.length);
        requestPhase = false;
        pendingRequest = undefined;
      }),
    );

    pi.on(
      "before_provider_request",
      guard("before_provider_request", (_event, ctx) => {
        if (!tracker || !activeRun || !requestPhase) return; // Warming during tools/idle is not foreground work.
        if (pendingRequest || tracker.hasOpenLlm()) {
          if (pendingRequest) pendingRequest.ambiguous = true;
          tracker.operationalEvent("pi.provider.correlation_ambiguous");
          return;
        }
        pendingRequest = { details: contextDetails(ctx), startedAt: Date.now(), ambiguous: false };
      }),
    );

    pi.on(
      "after_provider_response",
      guard("after_provider_response", (event) => {
        const requestId = providerRequestId(event.headers);
        if (!requestPhase || !pendingRequest || pendingRequest.ambiguous) return;
        const response = { status: event.status, ...(requestId ? { requestId } : {}) };
        pendingRequest.response = response;
        if (tracker?.hasOpenLlm()) tracker.noteProviderResponse(response);
      }),
    );

    pi.on(
      "provider_stream_event",
      guard("provider_stream_event", () => {
        // Provider-only traffic includes cache warming. Only transcript message_start owns
        // an inference lifecycle; never inspect, retain or export provider event.data.
      }),
    );

    pi.on(
      "message_start",
      guard("message_start", (event) => {
        const message = asRecord(event.message);
        if (message?.role !== "assistant") return;
        observeInference(
          stringValue(message, "provider"),
          stringValue(message, "model"),
          stringValue(message, "api"),
        );
      }),
    );

    pi.on(
      "message_end",
      guard("message_end", (event) => {
        const message = asRecord(event.message);
        if (message?.role === "assistant") {
          tracker?.endLlm(summarizeAssistant(message, cwd));
          requestPhase = false;
          pendingRequest = undefined;
        } else if (message?.role === "toolResult") {
          // Pi has already added nested own-usage at message_start. Count the finalized
          // top-level aggregate once, not every execution event plus this aggregate.
          tracker?.recordAuxiliaryUsage("tool", summarizeUsage(message.usage));
        }
      }),
    );

    pi.on(
      "tool_execution_start",
      guard("tool_execution_start", (event, ctx) => {
        tracker?.startTool(
          event.toolCallId,
          event.toolName,
          summarizeToolInput(event.toolName, event.args, ctx.cwd),
          {
            ...toolProvenance(event.toolName),
            ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          },
        );
      }),
    );

    pi.on(
      "tool_execution_end",
      guard("tool_execution_end", (event, ctx) => {
        if (!tracker) return;
        const aborted = ctx.signal?.aborted === true;
        tracker.endTool(
          event.toolCallId,
          event.isError && !aborted,
          event.isError && !aborted ? new ToolExecutionError() : undefined,
          summarizeToolOutput(
            event.result,
            event.toolName === "bash" && toolProvenance(event.toolName).source === "builtin",
          ),
          undefined,
          aborted,
        );
      }),
    );

    pi.on(
      "ui_prompt_start",
      guard("ui_prompt_start", (event) => tracker?.startWait(event.kind)),
    );
    pi.on(
      "ui_prompt_end",
      guard("ui_prompt_end", () => tracker?.endWait()),
    );

    pi.on(
      "session_before_compact",
      guard("session_before_compact", (event, ctx) => {
        tracker?.startCompaction({
          reason: event.reason,
          willRetry: event.willRetry,
          ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
          ...(event.preparation.tokensBefore !== undefined
            ? { tokensBefore: event.preparation.tokensBefore }
            : {}),
        });
      }),
    );

    pi.on(
      "session_compact",
      guard("session_compact", (event) => {
        if (tracker?.consumeHandledCompactionOutcome()) return;
        const usage = summarizeUsage(event.compactionEntry.usage);
        tracker?.endCompaction({
          outcome: "ok",
          fromExtension: event.fromExtension,
          ...(usage ? { usage } : {}),
        });
      }),
    );

    pi.on(
      "session_compact_failed",
      guard("session_compact_failed", (event, ctx) => {
        // Pi reports a hook cancel result as aborted. Preserve its already-recorded
        // failure/skip and do not count a second completion or a false user abort.
        if (!tracker || tracker.consumeHandledCompactionOutcome()) return;
        if (!tracker.hasOpenCompaction()) {
          // Preparation can fail before session_before_compact. Its start time is
          // unknown: mark the inferred lifecycle rather than silently dropping it.
          tracker.startCompaction({
            reason: event.reason,
            willRetry: event.willRetry,
            inferred: true,
            ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
          });
        }
        if (event.aborted) {
          tracker?.userAction("compaction_abort_inferred", {
            "pi.compaction.reason": event.reason,
          });
        }
        tracker?.endCompaction({
          outcome: event.aborted ? "aborted" : "failed",
          fromExtension: event.fromExtension,
          // Native provider errors may reflect instructions or conversation content.
          // Match product telemetry's content-free failure contract.
          ...(event.aborted ? {} : { error: new Error("Native compaction failed") }),
        });
      }),
    );

    pi.on(
      "model_select",
      guard("model_select", (event) => {
        const attributes = {
          "pi.model.source": event.source,
          "gen_ai.provider.name": event.model.provider,
          "gen_ai.request.model": event.model.id,
          ...(event.previousModel
            ? { "pi.model.previous": `${event.previousModel.provider}/${event.previousModel.id}` }
            : {}),
        };
        if (event.source === "restore") tracker?.operationalEvent("pi.model.restored", attributes);
        else tracker?.userAction("model_change", attributes);
      }),
    );

    pi.on(
      "thinking_level_select",
      guard("thinking_level_select", (event) => {
        tracker?.userAction("thinking_level_change", {
          "pi.thinking.level": event.level,
          "pi.thinking.previous_level": event.previousLevel,
        });
      }),
    );

    pi.on(
      "user_bash",
      guard("user_bash", (event) => {
        tracker?.userAction("user_bash", {
          ...summarizeShellCommand(event.command, event.cwd),
          "pi.command.excluded_from_context": event.excludeFromContext,
        });
      }),
    );

    pi.on(
      "session_before_switch",
      guard("session_before_switch", (event) => {
        tracker?.userAction("session_switch_requested", {
          "pi.session.switch_reason": event.reason,
        });
      }),
    );

    pi.on(
      "session_before_fork",
      guard("session_before_fork", (event) => {
        tracker?.userAction("session_fork_requested", {
          "pi.session.fork_position": event.position,
        });
      }),
    );

    pi.on(
      "session_before_tree",
      guard("session_before_tree", () => tracker?.userAction("session_tree_requested")),
    );
    pi.on(
      "session_tree",
      guard("session_tree", (event) => {
        tracker?.operationalEvent("pi.session.tree_completed", {
          "pi.session.tree_summarized": event.summaryEntry !== undefined,
        });
        tracker?.recordAuxiliaryUsage("branch_summary", summarizeUsage(event.summaryEntry?.usage));
      }),
    );
    pi.on(
      "session_info_changed",
      guard("session_info_changed", () => tracker?.userAction("session_name_changed")),
    );

    // Intentionally do not handle before_provider_headers: organization policy selected no gateway injection.
  };
}

/** Stable classification for failed tool executions; raw tool output is never inspected. */
class ToolExecutionError extends Error {
  constructor() {
    super("Tool execution failed");
    this.name = "tool_execution_error";
  }
}

export default function piOrgTelemetry(pi: ExtensionAPI): void {
  createPiOrgTelemetry()(pi);
}
