# Data policy

## Attribution

Every record carries `user.id` and `pi.identity.source`. In **environment fallback**, raw effective Git email is used for both `user.id` and `user.email` when available; otherwise `user.id` is a random installation UUID and `user.email` is absent. No name is automatically read from Git.

In **managed proxy mode**, the extension does not read Git email. It sends a placeholder identity (`user.id=managed`, `pi.identity.source=axon_auth`), and the backend overwrites resource and record/datapoint identity with verified auth-service data before forwarding. `user.id` is the authenticated user ID when present, otherwise verified email; `user.email`, optional `user.name`, and `axon.user_team_id` come from that same authenticated session. Client-supplied `user.*` and `enduser.*` attributes are removed, including identity fields on span events/links and metric exemplars. Missing verified identity fails closed.

The saved session is used only as the backend request Authorization header, never as an OTEL attribute. Exporter response rotation is compare-and-swap persisted without overwriting newer logins. Verified email/name are personal data: restrict collector access and retention. Authentication establishes attribution, not the truth of caller-supplied usage/cost measurements.

Identity is duplicated as a metric datapoint attribute because some metrics backends do not expose resource attributes as queryable labels. This intentionally creates one metric series per user and must be covered by organization retention and access policy.

## Repository identity

`pi.repo.slug` is derived from the `origin` remote and normalized to `host/org/repo` (lowercase host; scheme, port, embedded credentials, and `.git` removed; GitLab subgroups kept). Local paths, `file:` remotes, and repositories without an `origin` produce no slug. The raw remote URL is never exported.

The slug names private repositories and self-hosted Git hosts. It is present on spans, logs, and activity metrics (sessions, interactions, runs, turns, waits, inputs, interventions) but deliberately not on token, cost, LLM, or tool metrics, which already carry provider, model, or tool dimensions.

`pi.session.parent_id` is recorded when pi was started from another pi session's tool shell (pi injects `PI_SESSION_ID` into tool environments), so subagent activity can be joined to its parent.

## Never collected

- prompt, completion, or system-prompt text;
- image data;
- file contents, tool argument values/payloads, or tool results;
- shell executable names or command summaries;
- provider request payload contents or raw provider stream data;
- request or environment headers;
- credentials and environment values;
- full session file paths;
- raw Git remote URLs;
- extension or tool file paths (only `builtin`/`sdk`/`extension` and the scope are exported);
- stack traces.

The extension measures prompt length, image count, context-window token counts, tool-input size, and tool-output text length and image count without retaining those payloads. Image bytes are never read.

## Paths

Paths inside `ctx.cwd` are converted to slash-separated project-relative paths. Paths outside the project become `<external>/<basename>`. Home and project prefixes inside free-form summaries become `<home>` and `<project>` (home is resolved through `os.homedir()`, so Windows profiles are covered).

## Shell commands

Agent `bash`/`powershell` arguments and user `!` commands export only the original character count, never executable names or summaries. This is not process execution instrumentation. For a confirmed built-in `bash` result only, typed `structuredContent.exit_code` and `wall_time_seconds` are retained; similarly named custom-tool fields are not trusted as process metadata.

## Tools

| Tool | Exported input summary |
|---|---|
| `read`, `write`, `edit`, `ls` | Serialized input character count and sanitized path |
| `find`, `grep` | Serialized input character count, sanitized path, pattern length |
| `bash`, `powershell` | Serialized input character count and command length |
| Unknown/custom | Serialized input character count and up to 20 sorted top-level key names; no values |

Every tool span carries result text length and image count plus bounded provenance class/scope. Finalized top-level transcript result usage becomes `pi.usage.source=tool` metrics once, including Pi's nested usage aggregate; execution events do not duplicate it. Tool results themselves are never exported. Genuine failures receive `tool_execution_error` and a generated bounded message; raw output is not inspected for logging. Cancellation established by `ctx.signal` is an aborted outcome without an invented execution exception.

## Errors

Observed provider failures emit WARN `gen_ai.client.operation.exception` with bounded error classification and a maximum 256-character sanitized exception message. Compaction failures may also include a sanitized message. Cancellation and instrumentation closure do not invent client exceptions. Stack traces are excluded. Redaction handles bearer tokens, credential URLs, common assignments/flags including quoted JSON keys and escaped quoted values, private keys, and home/project/absolute path prefixes. This remains best-effort pattern matching, not a proof that arbitrary errors are free of sensitive text. Export-failure diagnostics written to stderr (never in TUI mode) include a sanitized, 200-character error cause.

## Product operations

Axon extensions and the launcher emit allowlisted recommender stages/outcomes, numeric task
assessment and confidence scores, selected model/rank, controlled policy/CLI versions, backup
and restore stage outcomes/durations/byte counts, startup timings, auth/config health and update
results. No feedback is collected. Recommendation explanation text, task prompts, session names,
archive paths, signed URLs, login URLs, credentials and raw exception text are excluded. Numeric
observations and recommendation/session IDs are not metric labels. See [Product telemetry](product-telemetry.md).

## Operational identifiers

Session IDs, parent session IDs, recommendation IDs, tool call IDs, trace IDs, provider request IDs, and provider response IDs appear only on traces/logs, not metric dimensions. Model, provider, tool name, tool source, usage source, outcome, mode, repository slug (activity metrics only), and user ID are metric dimensions.
