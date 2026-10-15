# pi-org-telemetry

Organization-managed OpenTelemetry monitoring for [pi](https://github.com/earendil-works/pi).

The package runs as a pi extension and exports operational traces, metrics, and structured logs over OTLP. It is designed for centrally managed rollout: it registers no commands or UI, never prompts users, and does nothing when a managed OTLP endpoint is absent.

## What it records

- session starts, shutdowns, replacement, navigation, and duration;
- user interactions, steering, follow-ups, model/thinking changes, and UI wait time;
- agent runs, inferred repeated runs, turns, compaction, and recovery outcomes;
- tool counts, duration, errors, provenance (built-in/extension), sanitized argument summaries, and result sizes;
- LLM request duration, provider/model, status, request and response IDs, stop reason, thinking level, usage (including reasoning tokens), and cost broken down by source (assistant, tool, compaction, branch summary);
- context-window utilization at each request;
- repository slug (`host/org/repo` from `origin`), pi version, OS, architecture, and runtime as resource/context attributes;
- exporter failures, handler failures, and bounded-queue OpenTelemetry SDK self-observability.

One trace is created per agent interaction rather than holding one span open for the entire session:

```text
pi.interaction
└── pi.agent.run
    └── pi.turn
        ├── gen_ai.chat
        ├── gen_ai.execute_tool
        └── pi.user.wait
```

Detailed provider payloads are intentionally excluded because the organization AI gateway is the primary LLM-debugging source.

## Zero-touch deployment

Publish the package to the organization registry, then centrally add it to users' global pi settings:

```json
{
  "packages": ["npm:pi-org-telemetry@0.2.0"]
}
```

Set OTLP configuration in the managed process environment:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example.com
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20REDACTED'
export OTEL_SERVICE_NAME=pi-coding-agent
```

`OTEL_EXPORTER_OTLP_ENDPOINT` is the recommended configuration and applies to all signals. Alternatively, all three per-signal endpoints must be configured:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel.example.com/v1/traces
export OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otel.example.com/v1/metrics
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://otel.example.com/v1/logs
```

If neither a base endpoint nor all three signal endpoints are present, the extension is disabled without network activity or user-visible output.

Supported protocols:

- `http/protobuf` (default)
- `grpc`

## Identity

The extension resolves identity in this order:

1. effective `git config user.email` for the current working directory;
2. an installation UUID stored in `$PI_CODING_AGENT_DIR/pi-org-telemetry/identity.json`;
3. when `PI_CODING_AGENT_DIR` is unset, `~/.pi/agent/pi-org-telemetry/identity.json`.

The UUID file is created with user-only permissions where supported. `user.id` is present on every span, metric point, and log. `user.email` is also present when Git email resolves.

The repository is identified by `pi.repo.slug`, a normalized `host/org/repo` derived from the `origin` remote with credentials and ports removed. It is attached to spans, logs, and activity metrics; see [docs/data-policy.md](docs/data-policy.md) for the exact scope. Git lookups run asynchronously with a two-second timeout and never block startup.

Raw email and repository names are personal or confidential data. Restrict collector and backend access accordingly.

## Configuration

| Variable | Behavior |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Recommended base OTLP endpoint |
| `OTEL_EXPORTER_OTLP_{TRACES,METRICS,LOGS}_ENDPOINT` | Per-signal endpoints; configure all three without a base endpoint |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` or `grpc` |
| `OTEL_EXPORTER_OTLP_HEADERS` | Managed exporter credentials/headers |
| `OTEL_SERVICE_NAME` | Defaults to `pi-coding-agent` |
| `OTEL_RESOURCE_ATTRIBUTES` | Additional resource attributes |
| `OTEL_TRACES_SAMPLER` | Supports always-on/off and trace-ID ratio modes |
| `OTEL_TRACES_SAMPLER_ARG` | Ratio for ratio-based sampling |
| `OTEL_METRIC_EXPORT_INTERVAL` | Metric interval in milliseconds, bounded to 1s–5m |
| `OTEL_BSP_SCHEDULE_DELAY`, `OTEL_BSP_EXPORT_TIMEOUT`, `OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_MAX_EXPORT_BATCH_SIZE` | Batch processor tuning for spans and logs, bounded; `OTEL_BLRP_*` overrides the log processor separately |
| `PI_ORG_OTEL_ENABLED` | Upstream-only disable behavior; Axon accepted backend enablement overrides this locally (see [deployment](docs/deployment.md)) |
| `PI_ORG_OTEL_DIAGNOSTICS` | Set to `false`, `0`, or `no` to suppress rate-limited stderr exporter diagnostics (never written in TUI mode) |

The extension does not read user/project telemetry settings. Configuration remains under organization control.

## Privacy

The extension never exports prompt/completion text, system prompts, file contents, tool results, provider payload content, authorization headers, environment values, session file paths, raw Git remote URLs, or stack traces.

Balanced summaries include repository-relative paths, short redacted shell commands, tool result sizes, and the repository slug. See [docs/data-policy.md](docs/data-policy.md) for exact handling.

## Failure behavior

Telemetry is passive:

- pi operations never wait for an export;
- span and log queues are bounded;
- metric cardinality is bounded per instrument;
- export failures never throw into pi handlers, and every event handler is guarded so a telemetry bug is counted (`pi.telemetry.dropped`) rather than surfaced to pi;
- shutdown waits at most two seconds;
- no telemetry is written to disk other than the fallback identity UUID.

## Development

```bash
npm install --ignore-scripts
npm run check
```

`npm run check` runs the TypeScript typecheck and the `node:test` suite; pi loads `src/index.ts` directly, so there is no build step. CI runs the same command plus `npm pack --dry-run`.

See:

- [Telemetry schema](docs/telemetry-schema.md)
- [Data policy](docs/data-policy.md)
- [Deployment](docs/deployment.md)
- [Known limitations](docs/limitations.md)
