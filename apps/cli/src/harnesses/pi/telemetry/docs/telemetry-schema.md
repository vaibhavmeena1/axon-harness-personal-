# Telemetry schema

Schema version: 3 (DeputyDev managed-auth attribution; environment fallback unchanged).

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

| Span | Parent | Purpose |
|---|---|---|
| `pi.interaction` | Root | One submitted agent interaction through `agent_settled` |
| `pi.agent.run` | `pi.interaction` | One low-level run; repeated runs are inferred retries/continuations |
| `pi.turn` | `pi.agent.run` | One LLM response and its tool calls |
| `gen_ai.chat` | `pi.turn` | Provider request through finalized assistant message |
| `gen_ai.execute_tool` | `pi.turn` | One tool execution, parallel-safe by call ID |
| `pi.user.wait` | Active turn/run/interaction | Time blocked on extension UI |
| `pi.session.compaction` | Active interaction or root | Manual, threshold, or overflow compaction |

### `gen_ai.chat` attributes

| Attribute | Description |
|---|---|
| `gen_ai.provider.name`, `gen_ai.request.model` | Provider and requested model |
| `gen_ai.response.model` | Provider-reported model when available, else the requested model |
| `gen_ai.response.id` | Provider completion/message ID when available, else the request ID header |
| `pi.provider.request_id` | Request ID from response headers (gateway correlation) |
| `http.response.status_code` | Provider HTTP status when the transport exposes it |
| `gen_ai.response.finish_reasons` | pi stop reason |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.cache_write_input_tokens`, `gen_ai.usage.reasoning.output_tokens` | Token usage; reasoning is a subset of output |
| `pi.cost.usd`, `pi.cost.input_usd`, `pi.cost.output_usd`, `pi.cost.cache_read_usd`, `pi.cost.cache_write_usd` | Cost as computed by pi |
| `pi.context.tokens`, `pi.context.window`, `pi.context.percent` | Context-window state when the request started (absent right after compaction) |
| `pi.thinking.level`, `pi.thinking.provider_level` | Requested pi thinking level and the provider-native level actually used |
| `pi.llm.truncated` | `true` when the response stopped for `length` |
| `pi.llm.synthesized` | `true` when the span was inferred from message events instead of provider hooks |
| `error.type` | `http_<status>` or the failing stop reason |

### `gen_ai.execute_tool` attributes

| Attribute | Description |
|---|---|
| `gen_ai.tool.name`, `gen_ai.tool.call.id` | Tool and call identifiers |
| `pi.tool.source` | `builtin`, `sdk`, `extension`, or `unknown` |
| `pi.tool.scope` | `user`, `project`, `temporary`, or `unknown` |
| `pi.tool.input_size`, `pi.path`, `pi.command.*`, `pi.pattern.length`, `pi.tool.input_keys` | Bounded input summaries (see data policy) |
| `pi.tool.output_size`, `pi.tool.output_images` | Text character count and image count of the result; content is never exported |
| `pi.tool.truncated_call` | `true` when the tool call belongs to a response that stopped for `length` (pi fails those calls) |
| `pi.tool.is_error`, `error.type`, `error.message` | `error.type` is the stable value `tool_execution_error` |

## Metrics

All metric points carry `user.id`, `pi.identity.source`, optional `user.email`, `pi.mode`, and relevant bounded dimensions.
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
| `pi.agent.retry.inferred` | Counter | `{run}` | activity |
| `pi.turn.count` | Counter | `{turn}` | activity |
| `pi.turn.duration` | Histogram | `s` | activity, outcome |
| `pi.llm.requests` | Counter | `{request}` | provider, request model |
| `pi.llm.errors` | Counter | `{error}` | provider, error type |
| `pi.llm.truncated` | Counter | `{response}` | provider, response model |
| `pi.llm.duration` | Histogram | `s` | provider, request/response model, synthesized |
| `pi.context.utilization` | Histogram | `%` | provider, request model |
| `pi.tokens.input` | Counter | `{token}` | `pi.usage.source`, provider, response model |
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

`pi.usage.source` is `assistant` (main model responses), `tool` (nested LLM work reported by a tool result, for example subagents), `compaction`, or `branch_summary`. Summing across sources matches pi's own session totals.

## Logs

| Event name | Severity | Purpose |
|---|---|---|
| `pi.session.started` | INFO | Session runtime started |
| `pi.session.ended` | INFO | Session runtime shut down |
| `pi.user.input` | INFO | User/RPC/extension input metadata received (includes text length and image count) |
| `pi.user.intervention` | INFO | Model, thinking, session, shell, steer, follow-up, or UI action |
| `pi.interaction.settled` | INFO/WARN | Interaction completed or failed/interrupted |
| `pi.llm.error` | ERROR | Provider request failed or was aborted/incomplete |
| `pi.tool.error` | ERROR | Tool execution failed |
| `pi.compaction.failed` | ERROR | Compaction failed or was aborted |

Log bodies are fixed strings. Variable data is stored in attributes.

## Changes since schema version 1 (package 0.1.0)

Removed:

- `pi.llm.payload_size` on `gen_ai.chat` (replaced by `pi.context.*`; computing it serialized the whole provider payload on every request).
- `pi.input.text_length` and `pi.input.image_count` as dimensions of `pi.user.input.count` (unbounded cardinality). They remain on the `pi.user.input` log and interaction event.

Semantics changed:

- `gen_ai.response.model` is now the provider-reported model when pi exposes it; previously it echoed the requested model.
- `gen_ai.response.id` is now the provider completion/message ID when available; the request ID header moved to `pi.provider.request_id` and remains the fallback.
- Tool `error.type` is the stable value `tool_execution_error` instead of `Error`.
- Counters now declare units.

Added: everything marked above that did not exist in version 1 (`pi.repo.slug`, `pi.session.parent_id`, `pi.version`, `os.type`, `host.arch`, `process.runtime.*`, context attributes and `pi.context.utilization`, reasoning tokens, cost breakdown, `pi.usage.source`, `pi.llm.truncated`, tool source/scope/output attributes, `pi.tool.truncated_call`).
