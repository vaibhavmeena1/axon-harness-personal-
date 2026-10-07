# Telemetry schema

Schema version: 4 (GenAI development conventions, pinned Pi 1.0.4 lifecycle attribution).

This schema adopts the supplied development conventions; their names are not a promise of stable upstream semantics.

## Resource attributes

| Attribute | Description |
|---|---|
| `service.name` | Managed service name, default `pi-coding-agent` |
| `service.version` | Extension version embedded when DeputyDev builds the standalone bundle |
| `service.instance.id` | Per-process random instance ID |
| `user.id` | Managed: auth user ID or verified email; env fallback: Git email or installation UUID |
| `user.email` | Managed: verified auth email; env fallback: raw effective Git email when available |
| `user.name` | Optional verified auth-service name, managed mode only |
| `deputydev.user_team_id` | Authenticated user-team membership ID, managed mode only |
| `pi.identity.source` | `deputydev_auth`, `git_email`, or `installation_id` |
| `pi.extension.name` | `pi-org-telemetry` |
| `pi.extension.version` | Extension version |
| `deputydev.cli.version` | CLI build version supplied by the managed launcher |
| `pi.version` | pi version, when pi can be imported at runtime |
| `os.type` | `darwin`, `linux`, `windows`, ... |
| `host.arch` | `amd64`, `arm64`, ... |
| `process.runtime.name` | `node` or `bun` |
| `process.runtime.version` | Runtime version |

## Common span and log attributes

| Attribute | Description |
|---|---|
| `user.id`, `user.email`, `pi.identity.source` | Duplicated from the resource for backends that do not index resource attributes |
| `session.id` | Current pi session ID |
| `gen_ai.conversation.id` | Current pi session ID |
| `pi.session.parent_id` | Parent pi session ID when this process was spawned from another pi session's tool (subagents) |
| `pi.project.name` | Working-directory basename |
| `pi.repo.slug` | `host/org/repo` from the `origin` remote, credentials and ports removed; absent without a remote |
| `pi.mode` | `tui`, `rpc`, `json`, or `print` |

## Spans

| Span | Kind | Parent | Purpose |
|---|---|---|---|
| `invoke_agent pi` | INTERNAL | Root | One submitted interaction through `agent_settled`; `gen_ai.operation.name=invoke_agent`, `gen_ai.agent.name=pi` |
| `pi.agent.run` | INTERNAL | `invoke_agent pi` | One low-level run; repeats may be retries or automatic continuations |
| `pi.turn` | INTERNAL | `pi.agent.run` | One assistant response and its tool calls |
| `chat {model}` / `generate_content {model}` | CLIENT | Active turn/run/interaction | Correlated foreground provider request through finalized assistant message |
| `pi.assistant.lifecycle` | INTERNAL | Active turn/run/interaction | Transcript lifecycle when provider request attribution is missing or ambiguous; no invented operation |
| `execute_tool {name}` | INTERNAL | Active turn or parent tool | One execution, parallel-safe by call ID; `gen_ai.operation.name=execute_tool` |
| `pi.user.wait` | INTERNAL | Active turn/run/interaction | Time blocked on extension UI |
| `pi.session.compaction` | INTERNAL | Active interaction or root | Manual, threshold, or overflow compaction |

Only transcript-owned assistant messages open inference slots. Provider-only warming does not create inference spans or count usage. Known Google APIs use `generate_content`; the known chat APIs use `chat`. Unknown APIs or overlapping request hooks retain custom lifecycle attribution.

### Inference / assistant lifecycle attributes

| Attribute | Description |
|---|---|
| `gen_ai.provider.name`, `gen_ai.request.model` | Provider and requested model |
| `gen_ai.response.model` | Only Pi's provider-reported `responseModel`; absent when unknown, never a request-model fallback |
| `gen_ai.response.id` | Only Pi's provider completion/message `responseId`; absent when unknown, never a header fallback |
| `pi.provider.request_id` | Request ID from response headers (gateway correlation) |
| `http.response.status_code` | Provider HTTP status when the transport exposes it |
| `gen_ai.response.finish_reasons` | `stop`, `length`, or `tool_calls`; abnormal/aborted/instrumentation-closed finishes use `error` without inventing an exception |
| `gen_ai.usage.input_tokens` | Inclusive Pi `input + cacheRead + cacheWrite` |
| `gen_ai.usage.output_tokens` | Pi output, already including reasoning; never add reasoning again |
| `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_write.input_tokens` | Cache subsets of standard inclusive input |
| `gen_ai.usage.reasoning.output_tokens` | Optional reasoning subset of output |
| `pi.cost.usd`, `pi.cost.input_usd`, `pi.cost.output_usd`, `pi.cost.cache_read_usd`, `pi.cost.cache_write_usd` | Cost as computed by pi |
| `pi.context.tokens`, `pi.context.window`, `pi.context.percent` | Context-window state when the request started (absent right after compaction) |
| `pi.thinking.level`, `pi.thinking.provider_level` | Requested pi thinking level and the provider-native level actually used |
| `pi.llm.truncated` | `true` when the response stopped for `length` |
| `pi.llm.synthesized` | `true` when the span was inferred from message events instead of provider hooks |
| `error.type` | Bounded inference failure values: `rate_limit`, `http_error`, `provider_error`; aggregate failures use `agent_error` |

Actual failed operations receive ERROR status. User cancellation and instrumentation closure remain UNSET and do not emit client exception logs. Gateway IDs stay separate from completion IDs; no trace context is injected.

### `execute_tool {name}` attributes

| Attribute | Description |
|---|---|
| `gen_ai.tool.name`, `gen_ai.tool.call.id` | Tool and call identifiers |
| `pi.tool.source` | `builtin`, `sdk`, `extension`, or `unknown` |
| `pi.tool.scope` | `user`, `project`, `temporary`, or `unknown` |
| `pi.tool.input_size`, `pi.path`, `pi.command.*`, `pi.pattern.length`, `pi.tool.input_keys` | Bounded input summaries (see data policy) |
| `pi.tool.output_size`, `pi.tool.output_images` | Text character count and image count of the result; content is never exported |
| `pi.tool.truncated_call` | `true` when the tool call belongs to a response that stopped for `length` (pi fails those calls) |
| `pi.tool.is_error`, `error.type`, `error.message` | Genuine failures use stable `tool_execution_error` and a generated bounded message, not tool output |
| `pi.tool.parent_call_id` | Nested call's parent ID; nested spans attach to the parent tool when open |
| `pi.tool.outcome` | `ok`, `error`, `aborted` (operation signal cancelled), or `interrupted` (instrumentation closure) |
| `pi.telemetry.closure_reason` | Incomplete slot cleanup reason; not an invented execution exception |

## Metrics

All metric points carry `user.id`, `pi.identity.source`, optional `user.email`, and relevant dimensions. Activity/operation metrics also carry `pi.mode`; token/cost points use usage-source and available provider/model dimensions.
Activity metrics also carry `pi.repo.slug`. Token, cost, LLM, and tool metrics do not, to keep series counts bounded; query cost per repository from spans or logs.

| Metric | Instrument | Unit | Dimensions |
|---|---|---|---|
| `pi.session.started` | Counter | `{session}` | activity, reason, ephemeral |
| `pi.session.ended` | Counter | `{session}` | activity, reason |
| `pi.session.duration` | Histogram | `s` | activity, reason |
| `pi.user.input.count` | Counter | `{input}` | activity, source, streaming behavior |
| `pi.user.intervention.count` | Counter | `{intervention}` | activity, kind |
| `pi.user.wait.duration` | Histogram | `s` | activity, outcome |
| `pi.interaction.count` | Counter | `{interaction}` | activity |
| `pi.interaction.duration` | Histogram | `s` | activity, outcome |
| `pi.agent.run.count` | Counter | `{run}` | activity |
| `pi.agent.run.duration` | Histogram | `s` | activity, stop reason |
| `pi.agent.run.repeated` | Counter | `{run}` | activity |
| `pi.turn.count` | Counter | `{turn}` | activity |
| `pi.turn.duration` | Histogram | `s` | activity, outcome |
| `pi.llm.requests` | Counter | `{request}` | provider, request model |
| `pi.llm.errors` | Counter | `{error}` | provider, error type |
| `pi.llm.truncated` | Counter | `{response}` | provider, response model |
| `pi.llm.duration` | Histogram | `s` | provider, request/response model, synthesized |
| `pi.context.utilization` | Histogram | `%` | provider, request model |
| `pi.tokens.input` | Counter | `{token}` | `pi.usage.source`, provider, request model, known response model |
| `pi.tokens.output` | Counter | `{token}` | same |
| `pi.tokens.cache_read` | Counter | `{token}` | same |
| `pi.tokens.cache_write` | Counter | `{token}` | same |
| `pi.tokens.reasoning` | Counter | `{token}` | same |
| `pi.cost` | Counter | `USD` | same |
| `pi.tool.calls` | Counter | `{call}` | tool name, tool source |
| `pi.tool.errors` | Counter | `{error}` | tool name, error type |
| `pi.tool.duration` | Histogram | `s` | tool name, outcome |
| `pi.compaction.count` | Counter | `{compaction}` | reason |
| `pi.compaction.duration` | Histogram | `s` | outcome |
| `pi.telemetry.export_errors` | Counter | `{error}` | signal |
| `pi.telemetry.dropped` | Counter | `{record}` | signal, reason (`handler` + event name when an extension handler threw) |

`pi.tokens.input`, `pi.tokens.cache_read`, and `pi.tokens.cache_write` retain Pi's disjoint categories; their sum is inclusive input. Output already includes reasoning, so do not add `pi.tokens.reasoning` to output or total tokens. Cost is Pi's estimate, not measured billing.

`pi.usage.source` is `assistant`, `tool`, `compaction`, or `branch_summary`. Tool metrics count only finalized top-level transcript result usage: pinned Pi adds descendants' own usage before `message_start`, then emits `message_end` on that aggregate. Execution events (including nested calls) are not additional usage points. Missing or unreported usage and cache-warming usage are not invented; totals need not equal all billed/session work.

### Standard GenAI histograms

| Metric | Unit | Dimensions beyond identity/mode |
|---|---|---|
| `gen_ai.client.operation.duration` | `s` | operation, provider, request model, known response model, actual error type |
| `gen_ai.execute_tool.duration` | `s` | operation, tool name, actual error type |
| `gen_ai.invoke_agent.duration` | `s` | operation, agent name, aggregate error type |
| `gen_ai.invoke_agent.inference_calls` | `{inference_call}` | same invocation dimensions |
| `gen_ai.invoke_agent.tool_calls` | `{tool_call}` | same invocation dimensions |

Client/tool duration boundaries: `[0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92]` seconds.
Invocation duration boundaries: `[0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6]` seconds.
Call-count boundaries: `[1, 2, 4, 8, 16, 32, 64, 128]`.

One count-distribution point per invocation, including zero calls and incomplete invocation closure. Inference counts include only observed direct foreground CLIENT calls. Tool counts exclude nested calls; nested spans still have their own tool duration. Child/subagent work reported as tool usage does not become parent inference counts. Standard histogram dimensions are allowlisted; session, request, call IDs, paths, and repository are excluded. The SDK cardinality limit is 2,000 per stream with overflow aggregation.
No streaming chunk, first-token, process, skill, workflow, or plan instruments are emitted.

## Logs

| Event name | Severity | Purpose |
|---|---|---|
| `pi.session.started` | INFO | Session runtime started |
| `pi.session.ended` | INFO | Session runtime shut down |
| `pi.user.input` | INFO | User/RPC/extension input metadata received (includes text length and image count) |
| `pi.user.intervention` | INFO | Model, thinking, session, shell, steer, follow-up, or UI action |
| `pi.interaction.settled` | INFO/WARN | Interaction completed or failed/interrupted |
| `gen_ai.client.operation.exception` | WARN | Observed provider operation failure only; bounded error type and sanitized `exception.type` / `exception.message` |
| `pi.tool.error` | ERROR | Tool execution failed |
| `pi.compaction.failed` | ERROR | Actual compaction failure only, not abort/cleanup |
| `pi.provider.correlation_ambiguous` | INFO | Overlapping provider hooks prevented reliable correlation |

Log bodies are fixed strings. Variable data is stored in attributes.

## Product observations (additive)

See [Product telemetry](product-telemetry.md) for the `deputydev.*` event counters, duration/byte/
assessment histograms, structured operation logs and spans. Dimensions include component, stage,
outcome, bounded reason, model, selected rank, policy version and CLI version. Numeric scores and
correlation IDs are never dimensions; product metrics do not include repository/session IDs.
Backend and CLI observations must be distinguished using `component`. No feedback is collected.

## Migration from schema version 3

- Change span filters: `pi.interaction` → `invoke_agent pi`; `gen_ai.chat` → `chat {model}` / `generate_content {model}`; `gen_ai.execute_tool` → `execute_tool {name}`. Prefer operation attributes over dynamic span names.
- Custom/ambiguous requests now use INTERNAL `pi.assistant.lifecycle`, not fabricated CLIENT spans.
- Rename cache attributes from `cache_read_input_tokens` / `cache_write_input_tokens` to `cache_read.input_tokens` / `cache_write.input_tokens`. Standard input is now inclusive: do not add cache subsets again. Custom Pi input/cache counters remain disjoint.
- Response model and ID no longer fall back to requested model or header ID. Use `gen_ai.request.model` for request-grouped metrics and `pi.provider.request_id` for gateway correlation.
- `pi.agent.retry.inferred` → `pi.agent.run.repeated`; repeated runs are not proof of retries. Update the Grafana query accordingly.
- `pi.llm.error` → WARN `gen_ai.client.operation.exception` for actual observed failures only; cancellation/closure are not client exceptions.
- Add invocation-owned standard duration/count histograms. Do not sum parent aggregate usage with nested execution usage or treat child work as direct parent calls.

## Historical changes since schema version 1 (package 0.1.0)

Removed:

- `pi.llm.payload_size` on `gen_ai.chat` (replaced by `pi.context.*`; computing it serialized the whole provider payload on every request).
- `pi.input.text_length` and `pi.input.image_count` as dimensions of `pi.user.input.count` (unbounded cardinality). They remain on the `pi.user.input` log and interaction event.

Semantics changed:

- `gen_ai.response.model` is now the provider-reported model when pi exposes it; previously it echoed the requested model.
- `gen_ai.response.id` is the provider completion/message ID when available; the request ID header moved to `pi.provider.request_id` (schema 4 removes the fallback).
- Tool `error.type` is the stable value `tool_execution_error` instead of `Error`.
- Counters now declare units.

Added: everything marked above that did not exist in version 1 (`pi.repo.slug`, `pi.session.parent_id`, `pi.version`, `os.type`, `host.arch`, `process.runtime.*`, context attributes and `pi.context.utilization`, reasoning tokens, cost breakdown, `pi.usage.source`, `pi.llm.truncated`, tool source/scope/output attributes, `pi.tool.truncated_call`).
