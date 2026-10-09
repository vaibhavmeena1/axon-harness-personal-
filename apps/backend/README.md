# Axon Console Backend

The centralized management API for Axon CLI installations. It also serves the `apps/frontend` console as static files from the same origin.

## Prerequisites

- Python 3.12
- [uv](https://docs.astral.sh/uv/)

## Setup

```bash
cd apps/backend
cp config_template.json config.json # already created locally; repeat when resetting it
make install
```

`config.json` is local and git-ignored. Keep `config_template.json` updated whenever the configuration shape changes.

The backend loads `config.json` from this directory and validates it before serving requests. The Vortex audit in [`VORTEX_REFERENCE.md`](VORTEX_REFERENCE.md) describes the former stack and is not current implementation guidance.

## Local LiteLLM

To use LiteLLM running on the host at port 4000, set these fields in the ignored `config.json` (keep the other connection-pool settings):

```json
"LITELLM": {
  "UPSTREAM_URL": "http://localhost:4000",
  "UPSTREAM_ROOT_PATH": "/",
  "API_KEY": "replace-with-litellm-master-key",
  "DECISION_TIMEOUT_SECONDS": 120,
  "IDENTITY_SYNC_ENABLED": true,
  "TEAM_ID": "",
  "TEAM_ROLE": "user"
}
```

For a backend running inside Docker on macOS, use `http://host.docker.internal:4000` instead. `API_KEY` is read only from JSON, never environment variables. Restart the backend after changing settings. Keep real credentials out of `config_template.json` and restrict access to your local `config.json`.

Use stock LiteLLM with a PostgreSQL database and set `API_KEY` to its master key for native user/team synchronization. With `IDENTITY_SYNC_ENABLED: true`, the backend provisions verified users, teams, memberships, and backend-only virtual keys through LiteLLM's management APIs. No custom authentication hook or shared identity-signing secret is needed. With synchronization disabled, the proxy uses `API_KEY` directly; it may be empty for a private deployment without upstream key authentication. The CLI continues to authenticate through Axon's backend using a saved Axon session, not the LiteLLM master key.

### Provisioning users into an existing LiteLLM team

With `IDENTITY_SYNC_ENABLED: true`, set `LITELLM.TEAM_ID` to an **existing LiteLLM team ID** and `TEAM_ROLE` to `"user"` (default) or `"admin"`. This assigns all provisioned Axon users to that team and binds their backend-only virtual keys to it. `TEAM_ROLE` is the **team membership role**, not the global LiteLLM user role, which remains `internal_user`. Grant `admin` only if those users should manage the team.

```json
"TEAM_ID": "your-existing-litellm-team-id",
"TEAM_ROLE": "user"
```

New users are created with a `teams` entry and `auto_create_key: false`; existing users missing membership are added through `/team/member_add`. The configured team must already exist and be active: provisioning fails rather than creating a replacement or falling back to another team. An empty `TEAM_ID` retains the verified Axon team ID and creates that native team if needed.

No maximum budget is sent. Set budgets, model access, MCP permissions, and other policy in the LiteLLM UI. Existing budgets, model/MCP permissions, and membership roles are preserved; changing `TEAM_ROLE` affects newly granted memberships, not existing ones. LiteLLM user IDs remain the verified Axon `user_team_id`, and key metadata retains the original Axon team ID even when the native LiteLLM team differs.

New backend-managed keys use `key_type: "default"` with an explicit route allowlist:
`["llm_api_routes", "/key/info", "/v2/user/info", "/team/*"]`. Do not combine that list with the
`llm_api` key preset: LiteLLM overwrites explicit routes with the preset. This allows inference,
the two CLI key/user metadata reads, and all `/team/*` paths. The team wildcard is not read-only:
team writes are allowed through the key route gate, but LiteLLM's native role, membership, and
endpoint authorization checks still apply. It does not grant proxy-admin privileges or permit
key/user management writes.
The proxy pins GET `/key/info` to the current backend credential's SHA-256 hash, replacing any
caller-supplied `key` query parameters. LiteLLM therefore echoes only a hash, never the backend
credential, and callers cannot use this route to inspect another key. Other routes remain streamed unchanged.

After a backend restart, identity provisioning lazily upgrades active keys with either previous
harness default (`["llm_api_routes"]` or `["llm_api_routes", "/key/info", "/v2/user/info"]`)
only when their metadata identifies them as this harness's key for
the same verified user (`source=meta-harness`, matching `axon_user_team_id` or the older
`deputydev_user_team_id` ownership marker). The upgrade changes
only `allowed_routes` and is read back before caching the key. Custom route lists, unmanaged keys,
blocked/expired keys, budgets, spend, and MCP grants are not changed. No key recreation or login
reset is required. MCP still requires separately registered servers and grants.

Restart the backend after changing these settings. Changing `TEAM_ID` selects a different user/team key; it does not remove old memberships or revoke old keys. This is a provisioning setting only—the proxy allowlist and inference-body attribution are unchanged.

### LiteLLM request diagnostics

In addition to Uvicorn access logs, the backend emits one diagnostic line per LiteLLM request.
Successful requests use INFO; failures use WARNING. Cancelled requests and disconnected clients
use INFO. An app-only console handler is installed when no application/deployment handler exists;
it does not enable HTTP client debug logging or replace deployment logging configuration.

Example (timings and ID are illustrative):

```text
WARNING: app.proxies.litellm LiteLLM request request_id=8f96f2e7 method=GET path=/key/info stage=upstream reason=upstream_permission_denied upstream_status=403 status=403 credential_mode=virtual_key upstream_duration_ms=12.4 duration_ms=18.2 completed=true error_type=none
```

- `request_id` is returned as `X-Request-ID`, including on auth/provisioning/transport errors,
  and forwarded to LiteLLM for proxied requests. Safe caller-supplied IDs are retained; others
  are replaced with a UUID.
- `stage` distinguishes `session_auth`, proxy readiness (`proxy`), `identity_sync`, `upstream`,
  `upstream_stream`, and `downstream_stream`.
- `upstream_status` preserves the original LiteLLM status; `status` is the response sent to the
  CLI. Upstream 401 and 403 still become a sanitized 403; `upstream_authentication_failed` versus
  `upstream_permission_denied` distinguishes them in diagnostics without invalidating the Axon session.
- `credential_mode=virtual_key` means native user/team credentials; `configured_key` means
  identity sync is disabled and the configured API key is used. `unresolved` means no key mode
  was resolved. A 403 from `/key/info`, `/v2/user/info`, or `/mcp` should prompt inspection of
  LiteLLM endpoint permissions, user/team/key policy, and MCP permissions—not a CLI login reset.
- `upstream_duration_ms` measures the forwarded call to response headers (not identity provisioning);
  `duration_ms` covers the full request, including auth, provisioning, and streaming. `completed=false`
  distinguishes an interrupted stream even when HTTP 200 headers have already been sent.

Diagnostics never include authorization headers, sessions, keys, query strings, bodies, email, or
raw exception text/tracebacks. Only known static endpoint paths are logged; other paths become
`<other>` so file IDs and arbitrary path content cannot leak. Exact upstream error bodies remain
redacted because LiteLLM can include backend-only keys in them; use the correlated LiteLLM server
logs for detailed policy denial reasons. If deployment logging is provided, enable INFO for the
`app` namespace to see successful-request diagnostics.

## Serving the console frontend

This service also serves `apps/frontend`. The console is a Vite build — an `index.html` plus content-hashed files under `assets/` — with nothing to run, so hosting it here keeps one origin, one deploy, and one version for the API and the UI, and removes CORS entirely.

Routing, in match order:

| Path | Served by |
| --- | --- |
| `/api/v1/*` | FastAPI routers |
| `/install.sh` | Public, unauthenticated CLI installer |
| `/api/v1/auth/browser-login` | Existing public browser-login start POST and GET polling at `/{session_id}` |
| `/api/v1/cli/config` | Session-authenticated, non-secret telemetry, search, and Pi preferences |
| `/litellm/*` | Session-authenticated LiteLLM proxy; streaming, native identity, and model authorization |
| `/api/v1/otel/v1/{traces,metrics,logs}` | Session-authenticated OTLP/HTTP proxy with authoritative identity |
| `/api/v1/cli/releases/*` | Public release discovery, hashes, and CloudFront downloads; private upload-signing POST |
| `/ping` | FastAPI liveness route |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* the API routers, including `/install.sh`. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every registered route has been tried.

`/install.sh` serves the repository's `apps/cli/install.sh` with only its default release base URL substituted from `CLI_INSTALL.RELEASES_URL` in `config.json`. The Docker image copies that same script alongside the backend. Set `RELEASES_URL` to `https://YOUR_ORIGIN/api/v1/cli/releases` (no trailing slash); it is public and must contain no credentials. The script resolves `/latest/VERSION` once, then fetches `/<version>/checksums.txt` and `/<version>/axon-darwin-arm64.gz`. Downloads redirect to short-lived **signed CloudFront** URLs; S3 presigned GET is available internally but bypasses the cache. Installer, release pointer, checksums, and redirect responses are not cached. Users can install with `curl -fsSL https://YOUR_ORIGIN/install.sh | sh` or download the script for inspection first.

### Web search

Web search is implemented by the standalone Pi extension, not a separate backend search API.
The backend publishes the non-secret `WEB_SEARCH` preferences through `/api/v1/cli/config`.
The CLI pins the extension to its authenticated local relay, which forwards the completion through
`/litellm/v1/chat/completions`. The backend authenticates the session and resolves the same native
LiteLLM user/team key used for ordinary model calls. No provider or admin key is sent to Pi.

Set `WEB_SEARCH.ENABLED=true` to register the tool on managed launches; the template defaults to false.
`MODEL` defaults to `gemini-3.8-flash` and must name a search-capable LiteLLM alias.
`ALLOWED_MODELS` supplies additional managed model preferences, not server-side permissions.
All preferences are validated and projected to client config: timeout, query/result/token/source limits,
`TEMPERATURE`, `THINKING_LEVEL`, `SEARCH_CONTEXT_SIZE`, `USE_URL_CONTEXT`, and `REQUIRE_GROUNDING`.
The extension owns its system prompt, adds the current UTC date, requests `web_search_options`,
parses raw provider grounding/citations, and returns token usage plus LiteLLM's response cost to Pi.

`THINKING_LEVEL` accepts `"low"`, `"medium"`, or `"high"`; null leaves model reasoning unchanged.
The extension sends it as LiteLLM `reasoning_effort`. `SEARCH_CONTEXT_SIZE` accepts the same levels;
null sends `web_search_options: {}`. **Gemini ignores search context size in LiteLLM 1.104.0**,
so it is an optional preference for providers that support it, not a Gemini search-depth control.
`USE_URL_CONTEXT` adds the Gemini-specific URL-context tool. `REQUIRE_GROUNDING` defaults to true
and rejects answers without citations or search queries. `MAX_OUTPUT_TOKENS` remains the model's
thinking/output budget. The obsolete `SEARCH_TOOL` and token-based thinking settings are rejected.

These settings configure the managed client and can be ignored by a modified client. LiteLLM must
own actual model permissions, budgets, and rate limits. Routing and credentials are never distributed
through search config. Restart the backend after editing `config.json`; relaunch Pi to receive changes.

### CLI client configuration

`GET /api/v1/cli/config` requires `Authorization: Bearer <Axon encrypted session>` and uses the shared auth-service guard. It returns only schema-versioned telemetry, web-search, and Pi defaults, never private backend config, auth data, or credentials in the JSON body. Auth errors and successful responses use `Cache-Control: no-store`; auth-service refresh tokens remain response headers. Browser-login start/poll stay on their existing `/api/v1/auth/browser-login` routes. No public bootstrap endpoint is added.

The template's `CLI_CLIENT_CONFIG.TELEMETRY: null` leaves existing environment-based telemetry unchanged. To manage it centrally, configure an approved collector, for example:

```json
"CLI_CLIENT_CONFIG": {
  "ALLOWED_TELEMETRY_ORIGINS": ["https://collector.example.com"],
  "TELEMETRY": {
    "ENABLED": true,
    "ENDPOINT": "/api/v1/otel",
    "PROTOCOL": "http/protobuf",
    "TRACE_SAMPLE_RATIO": 0.25,
    "METRIC_EXPORT_INTERVAL_MS": 10000
  },
  "PROXY": {
    "ENABLED": true,
    "UPSTREAM_URL": "https://collector.example.com",
    "HEADERS": {"Authorization": "Bearer YOUR_COLLECTOR_TOKEN"},
    "CONNECT_TIMEOUT_SECONDS": 2,
    "REQUEST_TIMEOUT_SECONDS": 5,
    "MAX_BODY_BYTES": 2097152,
    "MAX_DECODED_BODY_BYTES": 4194304,
    "MAX_CONCURRENT_REQUESTS": 20,
    "RATE_LIMIT_PER_MINUTE": 120
  }
}
```

This is deployment-wide CLI policy, separate from backend `OPEN_TELEMETRY`. Managed telemetry requires an enabled `PROXY` and `AUTH_SERVICE`. Its public endpoint is always `/api/v1/otel` on the CLI’s compiled service origin, and its protocol is always `http/protobuf`; remote config cannot select an external destination for a Axon credential. Trace ratios are 0–1; metric intervals are 1,000–300,000 ms. Use `{ "ENABLED": false }` to disable CLI export, or null to restore environment fallback. `PROXY.ENABLED: false` also disables server ingestion. **Restart the backend** after changing settings.

Authenticated online Pi launches (interactive or scripted) fetch config best-effort with a 700 ms deadline and no response cache, even when telemetry and web search are locally disabled. Managed policy clears inherited exporter headers/TLS identity overrides and per-signal destinations. The embedded extension reads the shared saved Axon session for each batch, sends it only to the pinned backend proxy, and persists safe refresh headers with compare-and-swap so stale exports cannot overwrite a new login. No credentials or user profile are distributed in config JSON. Config/export failures never prevent Pi launch.

Clients that disconnect during a telemetry upload are treated as cancellations, not server errors:
the incomplete batch is not forwarded, concurrency capacity is released, and an INFO line records
`reason=client_disconnected` without a traceback or payload. The handler uses the conventional
499 cancellation status; the disconnected client may not receive a response.

The proxy accepts only POSTs to `/api/v1/otel/v1/traces`, `/v1/metrics`, and `/v1/logs` (all under the same prefix). It validates the shared session/subscription guard before reading protobuf, obtains verified email/name via auth data or the auth service’s existing POST `/verify-auth-token`, and rewrites identity in resources, scopes, records, events, links, datapoints, and exemplars. Client `user.*`/`enduser.*` fields are removed; `user.id` is the auth user ID when available, otherwise verified email. `user.email`, optional `user.name`, `pi.identity.source=axon_auth`, and `axon.user_team_id` are server-authoritative. Missing verified identity fails closed. No Git email is read by the extension in managed mode.

`PROXY.UPSTREAM_URL` is a private collector base (optional path prefix), not a signal-specific URL. Its origin must be explicitly approved in `ALLOWED_TELEMETRY_ORIGINS`. HTTP is allowed for trusted private-network collectors; public CLI-to-backend traffic requires HTTPS except local development. `PROXY.HEADERS` stays server-side. Caller authorization/cookies/query parameters are never forwarded. Redirects are refused; OTLP response bodies/statuses/Retry-After are preserved. Gzip uploads are decoded with a bounded expansion limit; collector requests are sent as uncompressed protobuf. Wire/decoded payload, response, record-count, timeout, and concurrent-request limits are enforced. The per-user-team rate limit and concurrency limit are **per backend worker**; add ingress/global controls for multiple workers and unauthenticated abuse.

Environment fallback retains standard HTTP/protobuf or gRPC exporters and environment-supplied headers/API keys. It never automatically attaches a Axon session, and its Git-email/installation-UUID attribution remains unchanged. Collector access and retention must cover verified employee identity and private repository names.

#### Pi startup defaults

The template enables codemode for managed Pi launches through:

```json
"CLI_CLIENT_CONFIG": {
  "PI": { "CODEMODE_ENABLED": true }
}
```

The config API projects this as `"pi": { "codemodeEnabled": true }`. Before launching Pi,
`axon` merges `"+codemode"` into `$AXON_HOME/pi/settings.json` (normally
`~/.axon/pi/settings.json`), preserving other tool choices, packages, and unrelated settings.
It leaves `codemode.inlineBudget` unset, so Pi uses its default of 3000 unless the user has configured it.
Standalone `~/.pi/agent/settings.json` is never modified.

These are defaults, not enforced policy: Pi CLI flags and trusted project settings can override them.
`CODEMODE_ENABLED: false` sets a disabled codemode startup default. Omit `PI` or set it to null to stop
managing the default; this leaves the last local settings untouched. Offline, administrative,
unauthenticated, and failed config fetches do not change Pi settings. Defaults are persisted locally
and reused offline. Unsafe settings or a busy settings lock are left untouched, without blocking launch.
Restart the backend after a config edit; defaults apply on the next online authenticated CLI launch.

### Model recommendations through LiteLLM

`POST /api/v1/model-recommendations` assesses a coding task with Jev and deterministically ranks
the compatible models in the backend catalog. Register `typesafe/jev-1.13` as a model alias in
LiteLLM and ensure the deployment supports **`POST /v1/systemone`**. This endpoint accepts our
existing `model`/`state`/`questions` payload and returns typed `answers`; `/v1/decisions` expects
a different format and is not interchangeable.

The backend reuses its app-owned LiteLLM HTTP pool and the private `LITELLM.UPSTREAM_URL`,
`UPSTREAM_ROOT_PATH`, and `API_KEY`. `LITELLM.DECISION_TIMEOUT_SECONDS` is a positive integer
(default 120) bounding the buffered assessment request. The configured service key must be
allowed to call `/v1/systemone` and access the Jev alias; it is never sent to the CLI.
The recommendation API, catalog, ranking, and assessment parsing are unchanged.
Failed requests or malformed assessments return a sanitized 502; disabled current models return
204 without inference, and Axon session authentication remains required.

There is no direct OpenRouter client or credential requirement in the backend. Remove the old
`OPENROUTER` block from private `config.json` files and restart the backend after deployment.
Provider credentials and routing now belong to LiteLLM. A Jev deployment configured as
`openrouter/typesafe/jev-1.13` still uses OpenRouter upstream; removing that dependency entirely
requires a supported alternative Jev provider configured in LiteLLM.

### Backend recommender telemetry

`OPEN_TELEMETRY` now optionally initializes app-owned OTLP/HTTP trace/metric providers for the model
recommender. Set `ENABLED: true`, `SERVICE_NAME`, `ENDPOINT` (collector HTTP base, usually port 4318),
`PROTOCOL: "http/protobuf"`, optional server-owned `HEADERS`, `SAMPLING_RATE` and
`METRICS_EXPORT_INTERVAL_MILLIS`. `HEADERS: {}` works for unprotected in-cluster collectors.
Providers are initialized/closed by the lifespan; no Vortex/event-loop monitor is installed.
Request, assessment and ranking operations record only controlled metadata and numeric scores,
never prompts or exception text. CLI response fields `requestId`/`policyVersion` correlate the
picker with backend traces/logs. Backend and CLI metrics use `component` to avoid double counting.
This does not automatically instrument every backend HTTP/DB operation. See
[product telemetry](../cli/src/harnesses/pi/telemetry/docs/product-telemetry.md). Restart after changing config.

### Storage architecture and S3 settings

`app/clients/s3.py` owns reusable SDK transport operations and connection cleanup;
`app/clients/cloudfront.py` signs download URLs locally with a key parsed once per signer.
`app/listeners/storage.py` initializes separate release and session S3 clients/services for each
application worker and closes their pools on shutdown or failed startup. Services receive injected
clients, so tests and standalone tools do not need to patch SDK construction. Session-only bucket
safety checks and bounded payload validation live in `services/sessions/bucket_policy.py` and
`services/sessions/integrity.py`; they are not generic S3 defaults.

Session backups are enabled **only** by `"ENABLED": true` inside `SESSION_BACKUPS` in backend `config.json` (omitted/`false` disables them). `SESSION_BACKUPS.ENABLED` accepts only JSON booleans; strings, numbers, and null are rejected. Environment variables cannot override this policy. Configure private storage first and restart after changing the flag. Managed Pi clients follow the authenticated backend policy automatically; users cannot enable, disable, or pause backups through the CLI or Pi. Notify users that enabled backups include complete sensitive session transcripts.

Both `CLI_RELEASES` and `SESSION_BACKUPS` use the same nested `S3` configuration:

```json
"S3": {
  "BUCKET": "your-private-bucket",
  "REGION": "ap-south-1",
  "ENDPOINT_URL": null,
  "CREDENTIALS": {},
  "CONNECT_TIMEOUT_SECONDS": 5,
  "READ_TIMEOUT_SECONDS": 10,
  "MAX_RETRIES": 1
}
```

`CREDENTIALS: {}` uses the AWS default credential chain, preferably short-lived role credentials.
For a separately credentialed bucket, private JSON can supply paired `ACCESS_KEY_ID` and
`SECRET_ACCESS_KEY`, plus an optional `SESSION_TOKEN`, inside `S3.CREDENTIALS`. `ENDPOINT_URL` is
optional and must be an HTTPS origin without credentials, query, fragment or path. Timeout values
are integers from 1–300 seconds. `MAX_RETRIES` is 0–10 **additional** attempts; `null` keeps SDK/environment
retry defaults. The template preserves release defaults of 60/60 seconds and SDK retries, versus
session defaults of 5/10 seconds and one retry. `KEY_PREFIX`, URL lifetimes and safety settings stay
at feature level. Neither section inherits the other section’s credentials or bucket policy.

**Migrating an existing private config:** move release `BUCKET`/`REGION` into `CLI_RELEASES.S3`.
For sessions, move `AWS_BUCKET_NAME`/`AWS_REGION` into `SESSION_BACKUPS.S3` as `BUCKET`/`REGION`;
move credential keys into `S3.CREDENTIALS` and any former `CREDENTIALS.ENDPOINT_URL` into
`S3.ENDPOINT_URL`. The old layout is not accepted for enabled storage. Leave real credentials in
the ignored `config.json`, not the template, and restart after changes.

See [session storage and reconciliation](../../docs/session-backup-and-restore.md#6-private-object-storage-configuration)
for private/create-only bucket requirements and operator tools.

### CLI releases (macOS arm64 only)

Copy the `CLI_RELEASES` section from `config_template.json` into the ignored `config.json`. The checked-in example is **disabled**, with placeholder bucket, signing credentials, and hashes. Set a private `S3.BUCKET`, `S3.REGION`, an immutable `KEY_PREFIX`, a random `UPLOAD_AUTH_KEY` of at least 32 characters, CloudFront `DISTRIBUTION_URL`, trusted `KEY_PAIR_ID` and RSA `PRIVATE_KEY` (PEM with newlines represented as JSON `\\n`). Supply each version's `s3_key`, compressed `archive_sha256`, and decompressed `binary_sha256` under `VERSIONS`, with `LATEST_VERSION` referencing an already published version (leave it empty while staging the very first release; public `latest` returns 503 until promotion). Set `ENABLED` to `true` only after real values are provided. The server validates enabled settings at startup. Settings are cached: **restart the backend** after staging a version or promoting `LATEST_VERSION`.

The private bucket should permit origin reads only through CloudFront Origin Access Control, and allow backend role `s3:PutObject` for the dedicated `cli/releases/` prefix (plus `s3:GetObject` only if internal direct GET signing is required). Enable bucket versioning / protect published keys against deletion. Allow the CloudFront trusted key group to verify signed URLs. Use short-lived AWS role credentials (default AWS credential chain); do **not** put AWS access keys, the upload secret, or the CloudFront private key into `install.sh`, checked-in config, frontend assets, or CLI builds. Anyone who can reach the public endpoint can obtain a short-lived download URL; the upload signer is secret-protected.

`POST /api/v1/cli/releases/uploads/presign` requires `Authorization: Bearer <UPLOAD_AUTH_KEY>` and JSON `{ "version": "0.2.0" }`. It signs **only** the preconfigured version's S3 key, returning `url`, `headers`, and `expires_in`. Send every returned header on PUT; the signed SHA-256 checksum makes S3 validate the bytes and `If-None-Match: *` refuses overwrites. Never log or share the URL. `GET /api/v1/cli/releases/latest/VERSION` and `GET /api/v1/cli/releases/<version>/checksums.txt` are public; the exact-version archive endpoint returns an uncached 302 to CloudFront. Upload and verify the new release **before** moving `LATEST_VERSION`. See [the manual publishing procedure](../cli/README.md#releasing).

Checksums obtained from the same backend detect corruption and mismatch, not compromise of that backend. Stronger independent artifact authentication would require a separately signed update manifest.

A missing asset under `/assets/` and an unknown path under `/api/` both return a plain-text 404 instead of `index.html`. FastAPI handles other HTTP exceptions with its normal status codes and response bodies; Vortex's legacy error envelope and status remapping are no longer installed. Vortex's request-context middleware, structured logging, Sentry, and OpenTelemetry integrations are not installed automatically; the optional backend-owned recommender telemetry above is separate.

`FRONTEND_DIR` in `config.json` points at the build (default `static/`, relative to this directory). When it is absent the service starts normally and serves the API only — which is the usual local setup, where `vite dev` serves the console on port 8010 and proxies `/api` here.

To serve the console locally from this service instead:

```bash
bun run build:frontend                 # from the repository root
cp -R ../frontend/dist ./static
```

`static/` is git-ignored; the Docker build populates it.

## Docker

The image builds the frontend and embeds it, so **the build context is the repository root**, not this directory:

```bash
sh scripts/build-backend-image.sh --build-arg SERVICE_NAME=axon-console-backend -t axon-console-backend
```

Or `bun run build:backend-image` from the repository root. Use the same script in CI; pass Docker build flags, but no build-context argument (the script supplies the repository root).

The script attempts to pull `831059512818.dkr.ecr.ap-south-1.amazonaws.com/python:wolfi-3.12.14-r8` for `linux/amd64`. If that pull fails (missing credentials, network access, or image), it builds with this project's existing public `cgr.dev/chainguard/wolfi-base:latest` instead. Run your CI's ECR Docker login **before** the script to enable the private base. A later build failure is not retried with another base.

Both Python stages use the selected image. The private base already supplies Python 3.12.14; the public base installs Wolfi's `python-3.12` package. Direct `docker build` uses the public base by default; `--build-arg PYTHON_BASE_IMAGE=...` explicitly selects a base without automatic fallback.

The Python dependencies resolve from PyPI; no Bitbucket SSH forwarding is required.

The build assumes it can reach npm, PyPI, and GitHub over untampered TLS. On a developer machine behind a TLS-intercepting proxy it will fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `invalid peer certificate: UnknownIssuer`; build from a network without interception.

### Stage layout

The frontend stage runs on `$BUILDPLATFORM` (natively), because its output is architecture-independent; pinning it to `linux/amd64` would run the whole Node toolchain under QEMU on an Apple Silicon machine. The Python stages stay on `linux/amd64` to match the deployment target, so they *are* emulated locally and are correspondingly slower. Node exists only in the frontend stage; the runtime image gets the built bundle and no JavaScript toolchain.

### Database migrations inside a pod

The image does **not** include dbmate. An administrator can run the reviewed SQL migrations with the image's Python and existing asyncpg dependency, using the pod's mounted `config.json`:

```sh
# In the backend working directory inside the pod, once per deployment:
python -m deployment.run_migrations
# Roll back only the latest migration, after reviewing its cleanup requirements:
python -m deployment.run_migrations down
```

`deployment/run_migrations.sh` wraps the same command. The runner serializes concurrent runs with a PostgreSQL advisory lock and commits each migration with its entry in `META_HARNESS_schema_migrations`. Re-running it skips applied versions; it never dumps shared database schemas. It requires the existing `public.user_teams(id BIGINT PRIMARY KEY)` prerequisite for session backups. See [migration safety](../../docs/session-backup-and-restore.md#5-database-and-migration-safety).

## Commands

```bash
make install       # create/update .venv from uv.lock
make lock          # update uv.lock
make lint          # run Ruff linting
make format        # apply Ruff lint and formatting fixes
make format-check  # verify Ruff formatting
make test          # run pytest once tests exist
make check         # format-check, lint, and test
make pre-commit    # run every pre-commit hook
```
