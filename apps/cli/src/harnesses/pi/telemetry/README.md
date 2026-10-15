# Embedded Pi organization telemetry

This directory vendors and adapts `pi-org-telemetry` version `0.2.0` for Axon.
The imported source was provided from:

```text
/Users/vaibhavmeena/Desktop/1mg/pi-otel-telemetry/pi-org-telemetry
```

The source repository had no commits when imported, so the files in this directory are the
reviewable source of truth for the imported snapshot. `UPSTREAM_SNAPSHOT.sha256` records every
imported source/test/doc/dashboard hash, and `UPSTREAM_PACKAGE.json` preserves the original package
metadata. Axon changes include:

- Bun tests and Axon TypeScript/Biome compatibility;
- a compile-time extension version because the materialized bundle has no adjacent package.json;
- deterministic bundling of OpenTelemetry dependencies into one standalone ESM extension;
- embedding and checksum-protected materialization through Axon's Pi resource manifest;
- authenticated managed HTTP/protobuf export through Axon, with live session reads/rotation
  and backend-authoritative user identity, separate from standard environment exporters;
- schema 4 GenAI development semantics: INTERNAL `invoke_agent pi`, observed CLIENT inference,
  INTERNAL `execute_tool {name}`, inclusive standard input tokens, separate gateway/response IDs,
  and invocation-owned direct-call histograms;
- transcript-owned inference attribution (not cache warming), finalized top-level tool usage once,
  cancellation without invented exceptions, and content collection kept OFF.

The upstream snapshot metadata remains archival; current adapted source and the generated bundle
are authoritative. The adapted runtime version is `0.6.0-axon.1` with schema version 4; the archival upstream package version is unchanged.

## Build

```bash
bun run telemetry:build
bun run telemetry:check
bun test src/harnesses/pi/telemetry/tests
```

`telemetry:build` writes
`src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs`. Pi supplies only
`@earendil-works/pi-coding-agent`; all OpenTelemetry runtime dependencies are inside that generated
file. Loading it with `--extension` does not install packages or contact a registry.

## Runtime

The extension is loaded for every non-administrative `axon pi` invocation. It stays inert when a
OTLP endpoint is absent. Authenticated online non-administrative Pi (including scripted launches)
receives enablement/sampling/interval policy from CLI config, overriding local disablement and samplers.
There is no supported local opt-out of accepted managed enablement. Managed
export always uses HTTP/protobuf to the pinned Axon backend proxy and reads the saved session
for each batch; the backend replaces user identity with verified auth-service data. Configure
`OTEL_EXPORTER_OTLP_ENDPOINT`, or all three per-signal endpoints, as environment fallback; standard
headers/API keys and HTTP/protobuf or gRPC remain supported there. Offline Pi disables export.
See [Deployment](docs/deployment.md). Users receive this bundle by installing an updated Axon
CLI release and starting a new `axon pi` process; existing processes retain their loaded extension.
See the [schema migration](docs/telemetry-schema.md#migration-from-schema-version-3) before updating
collector span filters or token totals. No skill/workflow/plan, streaming, or process observations
are invented from these public events.

## Grafana dashboard

Import [`grafana.json`](grafana.json) and select the org Prometheus and Tempo datasources. One
dashboard serves both views: **User email = All** is the organization view, and picking emails
narrows every panel to those people. Rows, top to bottom:

- **Overview**: active and new users, sessions, interactions, cost, tokens, agent hours, cost per
  user/session, cache hit ratio, and LLM/tool error rates.
- **Adoption**: DAU/WAU/MAU, sessions and interactions over time, users by terminal, CLI versions.
- **Leaderboards**: per-user table (cost, sessions, interactions, tokens, tool calls, agent hours),
  top users by tokens, top repositories and models by cost, and top sessions by cost (Tempo
  `pi.session` spans above the **Min session cost** threshold).
- **Cost & tokens**: cost over time by model, cost by usage source, token usage by type, token mix,
  and a per-model usage table (cost, requests, tokens, cache hit, cost per request, users).
- **Models & reasoning effort**: requests and cost by thinking level, effort mix over time,
  reasoning share of output, latency and context utilization by model.
- **Sessions & terminals**: sessions by terminal, mode and repository; per-session cost,
  duration and interaction distributions; interventions and recent interaction traces.
- **Reliability**, then collapsed **Product** rows (recommender, backup/restore, CLI health).

Counter totals use `(increase(m[w]) and (m offset w)) or max_over_time(m[w])` instead of bare
`increase`. Each process exports its own cumulative series and `increase` ignores a series' first
sample, which would drop short-lived processes (for example, a process that starts one session
first exports `pi_session_started_total=1`). Multi-counter sums use a `label_replace` union rather
than `+`, so a model without cache-write tokens still appears. Active users count emails with any
exported sample in the window.

The **User email** selector, dependent repository options, panel filters, and per-user legends
use `user_email` for metrics and `user.email` for traces. Managed exports receive verified email
from DD auth; `user.id` remains unchanged in the telemetry schema. Multi-select and **All** are
supported. **All** includes only records with a non-empty email;
environment-fallback records without email are not shown. Repository filtering applies only to
activity metrics, session-summary histograms, and interaction traces, not token, cost, LLM, tool,
or telemetry-health metrics.

## Product tracking

Content-free recommender, backup/restore, startup, auth/config, update and release-version
observations now use the same managed OTel path. The dashboard adds adoption, cost/cache,
recommender funnel/decisions, transfer reliability and CLI operational panels. Feedback is not
collected. See [Product telemetry](docs/product-telemetry.md) for producer ownership, schema,
backend configuration and best-effort monitoring limitations.

Read these documents before changing exported data:

- [Data policy](docs/data-policy.md)
- [Telemetry schema](docs/telemetry-schema.md)
- [Deployment](docs/deployment.md)
- [Limitations](docs/limitations.md)

The upstream extension is MIT licensed. Bundled OpenTelemetry dependencies are Apache-2.0; both
license texts are retained in the generated bundle's legal banner.
