# Deployment

## Axon rollout

The extension is bundled into the Axon CLI and loaded for every non-administrative
`axon pi` invocation. Axon materializes a content-addressed, checksum-verified ESM file and
passes it to Pi with an explicit `--extension` argument.

No `npm install`, package-manager lifecycle script, registry lookup, or dependency download occurs
when Pi loads the extension. OpenTelemetry runtime dependencies are already bundled in the file;
Pi supplies `@earendil-works/pi-coding-agent` at runtime.

Updating the extension requires a reviewed Axon release. Build and verify the generated file
with:

```bash
bun run telemetry:build
bun run telemetry:check
```

Users must install the updated Axon CLI release and start a new `axon pi` process.
The resource manifest derives its checksum from the rebuilt bundle, so the next launch materializes
that content-addressed revision; already-running Pi processes are not hot-updated. No release,
commit, deployment, or live collector validation is performed by the build commands above.

Schema 4 changes span names, cache attributes and inclusive standard input totals, response-ID/model
fallback behavior, repeated-run naming, and exception logs. Apply the
[schema migration](telemetry-schema.md#migration-from-schema-version-3) to collector filters and
queries. The bundled Grafana repeated-run query uses `pi_agent_run_repeated_total`; disjoint custom
Pi token counters remain compatible. Standard call distributions are owned by each invocation,
not sums of nested/subagent executions.

## Client config (preferred for Axon sessions)

The CLI fetches authenticated `/api/v1/cli/config` before authenticated online non-administrative Pi launches (including scripted/CI/print/RPC/JSON). Configure `CLI_CLIENT_CONFIG.TELEMETRY`, private `PROXY.UPSTREAM_URL`/`HEADERS`, and the collector origin in `ALLOWED_TELEMETRY_ORIGINS`; see [backend setup](../../../../../../backend/README.md#cli-client-configuration). Managed config advertises only `/api/v1/otel`, resolved against the CLI’s compiled service origin, and `http/protobuf`. The extension makes no config request itself.

Managed enablement/sampling/interval policy takes priority over all local disable values, samplers, and exporter destinations. There is no supported local managed-telemetry opt-out. This applies to the Pi extension and launcher product telemetry, including buffered startup events and shutdown flushing. Offline Pi disables export and skips config; administrative/help invocations retain their fetch exemptions. Unavailable or absent policy uses Pi environment fallback; launcher events remain managed-only. An explicit disabled policy prevents export instead of falling back. Conflicting per-signal endpoints/protocols and inherited collector headers/TLS identity overrides are cleared for managed export.

Managed exporters always POST protobuf to the pinned backend’s `/api/v1/otel/v1/{traces,metrics,logs}`. They read the shared Axon session safely for each batch, refuse redirects, and persist bounded response refresh tokens using the same compare-and-swap writer as CLI config. Retryable failures get bounded retries honoring Retry-After; auth failures are not retried or made interactive. No session is placed in OTEL attributes or config JSON. Export remains best-effort and bounded.

The backend verifies subscription/session auth, resolves verified email/name through auth data or `/verify-auth-token`, and replaces all canonical user identity before forwarding to the private collector. Managed extension identity is a placeholder; local Git email is not read. Collector credentials are backend-owned and never sent to the CLI. See [Data policy](data-policy.md). Environment fallback never automatically attaches a Axon session and retains standard env headers and Git/installation attribution.

## Product telemetry

The launcher and managed extensions now observe recommender, backup/restore, startup, auth/config,
update and CLI-version operations. Launcher observations use an enabled managed policy; standalone
commands may fetch config best-effort at completion. Backend recommender stats require separately
enabling `OPEN_TELEMETRY` with HTTP/protobuf exporters. See [Product telemetry](product-telemetry.md).

## Environment fallback

Recommended HTTP/protobuf setup:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20TOKEN' \
OTEL_SERVICE_NAME=pi-coding-agent \
OTEL_RESOURCE_ATTRIBUTES='deployment.environment=production,service.namespace=developer-tools' \
axon pi
```

Recommended gRPC setup:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://collector.example.com:4317 \
OTEL_EXPORTER_OTLP_PROTOCOL=grpc \
OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer%20TOKEN' \
axon pi
```

Keep credentials in the managed environment or its secret-injection mechanism. Do not put
credentials in Pi settings or hardcode them in the bundle. Axon preserves standard `OTEL_*`
variables as fallback but never prints their values in launch previews. Config-managed collector
settings override the exporter settings and remove inherited exporter authentication/TLS overrides.

Without a base endpoint, all three signal endpoints must be set:

```bash
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://otel.example.com/v1/traces
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=https://otel.example.com/v1/metrics
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://otel.example.com/v1/logs
```

When neither form is configured, the extension stays loaded but performs no telemetry network
activity. Each signal protocol overrides the global protocol; only effective protocols are
validated. Supported protocols are `http/protobuf` and `grpc`; unsupported effective protocols
fail closed rather than silently changing transport.

## Collector requirements

The collector should:

- accept OTLP traces, metrics, and logs;
- retain `user.id`, `user.email`, optional `user.name`, `axon.user_team_id`, `pi.identity.source`, and `pi.version` resource attributes;
- retain `pi.repo.slug` where per-repository dashboards are wanted;
- apply access controls appropriate for raw employee email and private repository names;
- transform resource attributes into metric labels only if the metrics backend requires it;
- enforce retention separately for traces/logs and aggregate metrics;
- rate-limit individual clients at the collector boundary;
- drop or quarantine records that violate the documented schema.

The extension intentionally does not inject `traceparent`, baggage, email, session IDs, or custom
headers into AI gateway requests.

## Rollout sequence

1. Deploy collector ingestion and validate resource-attribute retention.
2. Configure a small Axon cohort through the managed process environment.
3. Verify user attribution, queue pressure, cardinality, and sanitizer output.
4. Expand deployment while monitoring `pi.telemetry.export_errors`, `pi.telemetry.dropped`, and SDK
   self-observability.
5. Disable managed telemetry with backend `TELEMETRY.ENABLED: false`, restart backend workers, and relaunch clients. Local `PI_ORG_OTEL_ENABLED=false` only controls no-policy fallback, not an accepted managed enable policy. Communicate this change to users before rollout.

## Failure behavior

Missing endpoint configuration disables telemetry silently. Runtime failures do not block Pi.
Export queues are memory-only and bounded; data can be dropped during collector outages. Queue and
batch sizes follow the standard `OTEL_BSP_*` / `OTEL_BLRP_*` variables within bounded ranges.
`PI_ORG_OTEL_DIAGNOSTICS=false` suppresses rate-limited local stderr diagnostics; diagnostics are
never written while Pi renders the TUI.

Shutdown waiting is idempotent and bounded to two seconds. Managed exports abort at the shutdown
deadline and race the complete batch operation against its abort signal; response size is capped
at 64 KiB and cleanup cancellation is not awaited indefinitely. Session persistence is cooperatively
cancelled with CAS and abort checks, not rollback of an already-started filesystem syscall.
Environment HTTP/gRPC exporters can continue in-flight work after shutdown waiting finishes until
the SDK timeout (bounded to 60 seconds); the two-second deadline does not forcibly terminate those
transports. See [limitations](limitations.md). Raw prompt/completion/system text, tool payloads,
provider stream data, and shell command text remain OFF; these events do not provide streaming,
process, skill, workflow, or plan telemetry.
