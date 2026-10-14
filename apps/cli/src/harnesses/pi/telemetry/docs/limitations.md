# Known limitations

The package observes the public coding-agent extension API. It does not receive private `AgentHarness` telemetry contexts or export internal spans created only through `@earendil-works/pi-telemetry`.

Current public-event limitations:

- there is no generic event for every built-in slash command;
- Esc abort has no dedicated event and is inferred from assistant/compaction outcomes;
- repeated `agent_start` before `agent_settled` is counted as `pi.agent.run.repeated`, not proof of a retry;
- failures inside unrelated extension handlers are logged by pi but are not exposed to this extension;
- another extension's final `tool_call` block decision is not directly exposed to passive observers;
- provider hooks vary by transport: unhooked/unknown/ambiguously correlated requests use INTERNAL `pi.assistant.lifecycle`, not fabricated CLIENT operations; headers/status/request IDs may be absent;
- response model and completion ID are exported only when Pi supplies `responseModel` / `responseId`; requested model and gateway request ID are never substituted;
- provider-only cache warming is excluded from inference spans and usage totals, including warming during long tools. Overlapping hooks lack request IDs on events, so uncertain correlation is conservative and may undercount direct inference;
- finalized top-level tool usage includes descendants in pinned Pi 1.2.0; usage omitted by tools/providers is not estimated. Independently exported subagents can overlap parent-reported cost in organization-wide sums, so choose a single accounting boundary;
- streaming chunks, first-token latency, shell process execution, skills, workflows, plans, and private harness spans are not observed or inferred;
- `user_bash` exposes command start/interception but no passive completion event;
- UI prompt events do not identify the tool that opened the prompt, so wait spans attach to the active turn rather than a specific parallel tool;
- `pi.context.*` is absent on the first request after a compaction because pi reports unknown usage until the next response;
- when a response stops for `length`, pi fails every tool call in that response, so `pi.tool.errors` rises together with `pi.llm.truncated`; those tool spans carry `pi.tool.truncated_call=true`;
- `pi.repo.slug` only considers the `origin` remote;
- `pi.version` is only available when pi's package can be imported from the extension's runtime, which is the normal case under `pi` but not guaranteed in embedded SDK hosts.

The extension does not inject distributed trace context into AI gateway or shell requests. Gateway records must be correlated independently using `pi.provider.request_id`, model, user, and timestamps where available.

Pi emits `session_shutdown` on quit, SIGINT, SIGTERM, and SIGHUP. Shutdown waiting is bounded to two seconds and idempotent. Managed transport is aborted at that deadline and its complete send promise is deadline-bounded, including hanging stream cancellation; filesystem operations remain cooperatively cancelled, with abort checks before persistence (an already-started filesystem syscall cannot be undone). Environment HTTP/gRPC exporters use the SDK transport: two seconds bounds waiting, not termination of in-flight transport work, which can last until the configured export timeout (up to 60 seconds). A SIGKILL/crash or collector outage can lose queued records; there is no durable spool or loss-window guarantee.

Axon product operations are explicitly observed in their owned code, not inferred from
generic Pi events. Product export is best-effort, uses no durable spool, and requires an enabled
managed policy/authentication for launcher events. Short-lived counter series can be undercounted
by PromQL `increase`; use traces/logs for individual-operation investigation. Backend stats require
separate `OPEN_TELEMETRY` configuration. See [Product telemetry](product-telemetry.md).

The fixed redaction policy covers common credential forms but cannot prove arbitrary error messages contain no sensitive text. Prompt/completion content and tool results are excluded entirely to reduce that risk.
