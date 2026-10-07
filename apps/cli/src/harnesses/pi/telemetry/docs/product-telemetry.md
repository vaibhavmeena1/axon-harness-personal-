# DeputyDev product telemetry

Product telemetry is additive to schema 4's LLM, tool, session, context and user-intervention
observations. No feedback, productivity inference, prompts, recommendation explanations, source
code, session names, paths, storage URLs or credentials are collected.

## Producers and ownership

| Category | Stages | What is measured |
|---|---|---|
| `recommender` | eligible, request, assessed, recommended, shown, decision, apply, override | Eligibility/skips; request duration/errors; numeric task assessment; recommendation count/top model; picker decisions and rank; automatic selection; model application and subsequent overrides |
| `backup` | consent, capture, upload, commit | Consent changes, skipped captures, actual capture/upload/commit results, duration and archive bytes; pending/cancelled are not reported as committed |
| `restore` | request, download, verify, fork | Cancellation, actual download/integrity/native-fork outcomes, duration and archive bytes |
| `startup` | prepare, spawn, ready | Setup/preparation and subprocess spawn outcomes; launch-to-session-initialization duration |
| `auth` | preflight, verify, login, refresh, recovery | Local preflight, verified/expired/invalid-session outcomes, browser-login cancellation/success/failure, CAS refresh persistence and interactive recovery; never credentials or login URLs |
| `config` | fetch | Config-fetch duration and bounded failure reason; authentication rotation is preserved even for invalid settings |
| `update` | check, install | Availability checks, install/verification failures, skips and successful activation, including background updates |
| `release` | launch | CLI version observed at the first initialized Pi session per process |

The backend independently owns recommender request, Jev assessment and ranking spans plus numeric
assessment distributions. `component=backend` and `component=cli` distinguish those observations;
do not sum both components as if they were distinct recommendation attempts. The CLI owns the
picker and model-application decisions. A generic model change is not inferred as acceptance.
`kept_current`, `dismissed`, `auto_selected`, `selected`, and application failures remain distinct.
The request/response UUID correlates backend and CLI traces/logs; it is not a metric label and does
not inject trace context into Jev/AI-gateway requests. Policy versions hash the controlled catalog.

## Signals and schema

For each category, `deputydev.<category>.events` is a counter with unit `{event}`. Timed observations
also record `deputydev.<category>.duration` (`s`), and applicable transfers record
`deputydev.<category>.transfer` (`By`). Each observation emits a fixed-body structured log and an
operation span. Failure text and automatic exception recording are deliberately excluded.

Dimensions are allowlisted: component, stage, outcome, bounded reason, model, selected rank,
policy version and CLI version. Verified user identity is attached through the existing managed
proxy. Session/recommendation IDs and repository identity stay on product traces/logs, not product
metric labels. Numeric complexity/confidence/reasoning/speed/candidate counts are histogram values,
not dimensions. Histograms use explicit boundaries appropriate to seconds, bytes and scores.

Recommender histograms are `deputydev.recommender.complexity`, `.confidence`,
`.high_complexity_probability`, `.needs_deep_reasoning`, `.prioritizes_speed`, and `.candidate_count`.
Complexity is 0–3; the four confidence/probability/preference observations are 0–1. These are routing
assessments, not measurements of task correctness or recommendation quality.

Prometheus queries in the bundled dashboard assume standard OTLP metric-name/unit translation:
`deputydev_recommender_events_total`, `deputydev_recommender_duration_seconds_bucket`, and
`deputydev_backup_transfer_bytes_bucket`. Validate actual names in the org collector/backend before
rollout. The User email selector includes both Pi activity and product-event metrics.

## Export policy and lifetime

The launcher uses lazy, app-owned SDK providers for product telemetry, only with an enabled
managed policy. Interactive Pi reuses its existing config fetch. Standalone CLI commands (including
updates/restores) may fetch policy best-effort at completion when product observations and a saved
session exist; this does not change the harness's initial configuration precedence. Missing or
disabled policy means no product export. Offline and the local telemetry kill switch disable it.
There is no automatic auth attached to an arbitrary environment collector.

Launcher observations buffer at most 128 content-free events in memory before initialization.
After activation they export live, with remaining records flushed at command/harness completion.
Config fetch has the existing 700 ms deadline; export shutdown waiting is bounded to two seconds.
Failures preserve the command's original outcome. Events are not persisted to a disk spool.

Managed Pi extensions communicate through the allowlisted `deputydev:telemetry` event bus. Telemetry
loads last so backup shutdown outcomes are emitted before its providers close. Startup bus events
are bounded and drained after telemetry initialization. Extension reload/session replacement can
lose events while telemetry is unavailable; it is not a durable audit log.

Counters are best-effort monitoring, not exact accounting. Short-lived processes/new series with
only one exported counter sample can be undercounted by PromQL `increase`; collector translation,
reset handling, outages, crashes and concurrent processes also matter. Inspect event traces/logs
when investigating individual decisions. A recovered request's auth statistics can only export if
an authenticated telemetry request subsequently succeeds. A backend/config/auth outage cannot
reliably report itself through the same failed path.

## Backend configuration

Enable backend-owned recommender stats separately from `CLI_CLIENT_CONFIG`:

```json
"OPEN_TELEMETRY": {
  "ENABLED": true,
  "SERVICE_NAME": "deputydev-console-backend",
  "ENDPOINT": "http://opentelemetry-collector-otelcol.monitoring.svc.cluster.local:4318",
  "PROTOCOL": "http/protobuf",
  "HEADERS": {},
  "SAMPLING_RATE": 0.1,
  "METRICS_EXPORT_INTERVAL_MILLIS": 10000
}
```

This uses OTLP/HTTP exporters, without event-loop monitoring or Vortex dependencies. Headers are
optional for protected private collectors and remain server-owned. Provider shutdown is explicit.
It instruments the recommender's business operations, not every backend HTTP/DB request.

## Validation before rollout

Run the repository checks after rebuilding both bundled extensions:

```bash
bun run --cwd apps/cli telemetry:build
bun run --cwd apps/cli backups:build
bun run check
bun run test:cli
```

Local regressions cover the distinct interaction/recommender TraceQL filters, product metric
unit/name expectations, explicit SDK buckets, cumulative counter values across collections, and
an authenticated short-lived subprocess exporting all three signals at shutdown. They also cover
concurrent initialization/close, managed export deadlines, identity rewriting/CAS rotation, auth
recovery failure versus cancellation, and config body timeouts that still preserve auth rotation.
These tests do **not** validate a real collector's Prometheus translation or Grafana datasource.

With authorized staging access, validate the following separately:

1. Inspect actual metric names and labels in Prometheus/Grafana. Confirm event counters end in
   `_events_total`, duration buckets in `_duration_seconds_bucket`, archive sizes in
   `_transfer_bytes_bucket`, and assessment histograms match the dashboard's names. Check retained
   `user_email`, `component`, `stage`, `outcome`, `deputydev_cli_version`, and `le` labels; request IDs
   and session/repository identity must not become product metric labels.
2. Run a known small number of content-free operations in a process shorter than the export
   interval. Confirm its final OTLP cumulative count and histogram count/sum reach the collector.
   Inspect raw samples and traces/logs as well as `increase`: one-sample series may appear as zero
   in rate/increase panels even when ingestion succeeded.
3. Repeat with multiple short-lived processes and an auth rotation. Check the collector's
   service-instance/reset handling so overlapping cumulative streams do not overwrite each other.
   Confirm identity is the server-verified account, not the client's placeholder or Git email.
4. Exercise recommendation, keep-current/dismissal, application failure, and override; inspect
   correlated CLI/backend traces by recommendation ID. Confirm the email selector finds both
   resource-attributed CLI spans and span-attributed backend spans without requiring a repository.
5. Verify expected backup/restore outcomes and archive sizes, plus startup/auth/config/update and
   version-adoption panels. Enable backend-owned telemetry separately when checking backend spans.

Do not treat build success or local smoke tests as live collector/Grafana validation. Shutdown is
best effort: outages, the bounded deadline, forced termination, and concurrent account changes can
still lose or reattribute buffered observations; counters are not an audit trail.
