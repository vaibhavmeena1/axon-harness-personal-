# Axon Backend

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
  "READ_TIMEOUT_SECONDS": 360,
  "MANAGEMENT_MAX_CONNECTIONS": 20,
  "DECISION_MAX_CONCURRENCY": 10,
  "IDENTITY_SYNC_ENABLED": true,
  "TEAM_ID": "",
  "TEAM_ROLE": "user"
}
```

For a backend running inside Docker on macOS, use `http://host.docker.internal:4000` instead. `API_KEY` is read only from JSON, never environment variables. Restart the backend after changing settings. Keep real credentials out of `config_template.json` and restrict access to your local `config.json`.

Use stock LiteLLM with a PostgreSQL database and set `API_KEY` to its master key for native user/team synchronization. With `IDENTITY_SYNC_ENABLED: true`, the backend provisions verified users, teams, memberships, and backend-only virtual keys through LiteLLM's management APIs. No custom authentication hook or shared identity-signing secret is needed. With synchronization disabled, the proxy uses `API_KEY` directly; it may be empty for a private deployment without upstream key authentication. The CLI continues to authenticate through Axon's backend using a saved Axon session, not the LiteLLM master key.

### LiteLLM browser dashboard (optional)

The CLI/API proxy at `/litellm/*` always requires an Axon session. To expose LiteLLM's
own browser login instead, set `LITELLM.UI_ENABLED` to `true` in private `config.json`.
It defaults to `false`; enabling it registers a separate `/litellm-admin/*` pass-through
before the frontend catch-all. This is the **whole native LiteLLM namespace**, including
its dashboard APIs, not just static UI files. LiteLLM must enforce its own authentication
and authorization. Never enable it against an unauthenticated LiteLLM deployment.

For production at `https://deputydev.ai/axon/litellm-admin/ui/`, configure LiteLLM:

```yaml
environment:
  SERVER_ROOT_PATH: /axon/litellm-admin
  PROXY_BASE_URL: https://deputydev.ai
```

Use LiteLLM v1.72.3 or newer and a pinned image. The UI directory must be writable
because LiteLLM rewrites its assets at startup; on a read-only filesystem, point
`LITELLM_UI_PATH` to a writable volume. Keep strong master/UI credentials configured.

In the backend's `config.json`, retain the other settings and update:

```json
"LITELLM": {
  "UI_ENABLED": true,
  "UPSTREAM_URL": "http://your-private-litellm-host:4000",
  "UPSTREAM_ROOT_PATH": "/axon/litellm-admin",
  "API_KEY": "your-existing-litellm-master-key",
  "IDENTITY_SYNC_ENABLED": true
}
```

`UPSTREAM_URL` is the private origin only. The configured `UPSTREAM_ROOT_PATH` is used
by both proxies and all identity/decision calls. Assuming ingress forwards `/axon/*`
to this backend and strips `/axon`, the browser request `/axon/litellm-admin/ui/`
becomes backend `/litellm-admin/ui/`, then upstream `/axon/litellm-admin/ui/`.
An existing CLI request `/axon/litellm/v1/chat/completions` keeps its public URL and
is forwarded to upstream `/axon/litellm-admin/v1/chat/completions` after Axon authentication.
The browser mount's bare root redirects to the configured upstream root plus `/ui/`.
Use the same public LiteLLM prefix in `SERVER_ROOT_PATH` and `UPSTREAM_ROOT_PATH`.
If the upstream root is `/`, root-relative redirects fall back to the browser's ASGI mount
(including an ingress root path when supplied). This fallback does not rewrite HTML/assets;
LiteLLM still needs its correct public root configuration for those URLs.

The browser proxy does **not** call Axon authentication, synchronize identities, or inject
the configured master key/virtual keys. It forwards the browser's own LiteLLM authorization,
API-key headers, login cookies, request bodies, and native responses (including 401/403).
Separate `Set-Cookie` headers and cookie security attributes are preserved. Explicit Axon
session/identity headers and named Axon session-cookie fields are stripped. Other cookies
are passed through, so scope unrelated sensitive application cookies away from this path.
The shared upstream pool does not retain browser cookies or merge client-default credentials.
Redirects to the private upstream origin are made root-relative; external SSO redirects and
malformed Location headers are preserved without a policy-parser crash. Dynamic HTML, login,
and session responses use `Cache-Control: no-store`. Successful static assets under the known
Next.js `/_next/static/` namespaces preserve native cache headers only when the response has
no `Set-Cookie` or credential-dependent `Vary`; caching is never invented for an uncached asset.
HTTP streaming is supported; WebSockets are not. Both modes use one shared request/response
lifecycle for body iteration, diagnostics, transport errors, cancellation and response closure.
The existing `/litellm/*` credential handling and protections remain unchanged.

Browser request limits are optional positive integers in `LITELLM`; existing configurations
need no edits:

| Setting | Default | Scope |
| --- | --- | --- |
| `UI_BODY_IDLE_TIMEOUT_SECONDS` | 30 | Waiting for the first and each subsequent incoming body frame |
| `UI_WRITE_TIMEOUT_SECONDS` | 30 | Each upstream socket write |
| `UI_REQUEST_TIMEOUT_SECONDS` | 360 | Total time through body ingestion and upstream response headers, including pool waits |
| `UI_MAX_REQUEST_BODY_BYTES` | 33554432 (32 MiB) | Declared and actually streamed browser request bytes |

Idle/total browser request timeouts return a sanitized 408; oversized bodies return 413.
An aborted upload releases the upstream connection. Upstream transport failures retain the
sanitized 502 behavior. These bounds do not cap response-stream duration or change CLI/API
upload timeouts. Request paths in both modes are limited to 8192 bytes and four percent-decoding
layers; oversized, excessively encoded, and dot-segment paths return 400 before body/key handling.
Enabling the browser mount emits `LiteLLM UI proxy mounted at /litellm-admin` at INFO level.

Restart/redeploy both services after changing their configuration. No separate Nginx location
is needed if ingress already sends the new path to this backend without an Axon session gate.
If ingress only forwards selected paths, add `/axon/litellm-admin/*` there as well. Keep the
LiteLLM port private. Verify the public UI login/assets, a denied anonymous dashboard API call,
a valid prefixed `/v1/models` request against LiteLLM, and existing CLI inference before rollout.

### LiteLLM connection pools and stream timeouts

Each backend worker owns separate HTTP pools for proxy streams and buffered identity/decision calls.
`MAX_CONNECTIONS` limits the streaming pool (default 100); `MANAGEMENT_MAX_CONNECTIONS` limits the
buffered pool (default 20), so stalled streams cannot consume provisioning capacity.
`DECISION_MAX_CONCURRENCY` (default 10, must be less than `MANAGEMENT_MAX_CONNECTIONS`) caps
in-flight recommendation decisions per worker so they cannot starve identity sync; requests beyond
the cap fail fast with a sanitized 502 instead of queueing.
`POOL_TIMEOUT_SECONDS` bounds streaming pool waits; buffered calls use their identity/decision
request timeouts, including while waiting for a connection.

`READ_TIMEOUT_SECONDS` is a positive integer (default 360) limiting upstream inactivity while waiting
for response headers or the next network chunk. It is not a total stream-duration limit: active
streams can run longer. Non-streaming requests send nothing until they finish, so it must exceed
the longest non-streaming client budget: Pi web search (`stream: false`) allows up to 300 seconds.
A timeout before response headers produces a sanitized 502; after headers it aborts the stream
and releases the upstream connection, without attempting to send a second HTTP response.

### Provisioning users into an existing LiteLLM team

With `IDENTITY_SYNC_ENABLED: true`, set `LITELLM.TEAM_ID` to an **existing LiteLLM team ID** and `TEAM_ROLE` to `"user"` (default) or `"admin"`. This assigns all provisioned Axon users to that team and binds their backend-only virtual keys to it. `TEAM_ROLE` is the **team membership role**, not the global LiteLLM user role, which remains `internal_user`. Grant `admin` only if those users should manage the team.

```json
"TEAM_ID": "your-existing-litellm-team-id",
"TEAM_ROLE": "user"
```

New users are created with a `teams` entry and `auto_create_key: false`; existing users missing membership are added through `/team/member_add`. The configured team must already exist and be active: provisioning fails rather than creating a replacement or falling back to another team. An empty `TEAM_ID` retains the verified Axon team ID and creates that native team if needed.

Native users are resolved **only by the verified auth-service email**, normalized by trimming whitespace and case-folding. The backend searches `/user/list?user_email=...`, verifies an exact email match locally (LiteLLM's filter is a substring search), and follows pagination. Ambiguous, malformed, unavailable, or excessive lookup results fail closed. A missing email is created through `/user/new` **without `user_id`**, letting LiteLLM generate its native ID; a competing create is accepted only after an exact-email read-back. There is no lookup fallback to an Axon account or membership ID.

All team memberships and virtual-key ownership checks use that resolved native ID. Multiple verified Axon memberships with the same email reuse one LiteLLM user. User metadata stores their membership references as a list under `deputydev-user-team-id`; each membership-scoped key stores its individual ID under the same field and retains `axon_team_id` for the original Axon team. These references are not native user IDs or authorization inputs. Missing references are merged through a metadata-only `/user/update` and read back before issuing/caching a key. The cache includes verified email as well as membership and native team, so a changed email cannot reuse a cached identity unchecked.

No maximum budget is sent. Set budgets, model access, MCP permissions, and other policy in the LiteLLM UI. User roles, budgets, model/MCP permissions, unrelated metadata, and existing membership roles are preserved; changing `TEAM_ROLE` affects newly granted memberships, not existing ones.

New backend-managed keys use `key_type: "default"` with an explicit route allowlist:
`["llm_api_routes", "/key/info", "/v2/user/info", "/team/*", "/v1/systemone"]`. Do not combine that list with the
`llm_api` key preset: LiteLLM overwrites explicit routes with the preset. This allows inference,
model recommendations via `/v1/systemone`, the two CLI key/user metadata reads, and all `/team/*` paths. The team wildcard is not read-only:
team writes are allowed through the key route gate, but LiteLLM's native role, membership, and
endpoint authorization checks still apply. It does not grant proxy-admin privileges or permit
key/user management writes.
The proxy pins GET `/key/info` to the current backend credential's SHA-256 hash, replacing any
caller-supplied `key` query parameters. LiteLLM therefore echoes only a hash, never the backend
credential, and callers cannot use this route to inspect another key. Other routes remain streamed unchanged.

After a backend restart, identity provisioning lazily upgrades active keys with a previous
harness default (`["llm_api_routes"]`, `["llm_api_routes", "/key/info", "/v2/user/info"]`,
or `["llm_api_routes", "/key/info", "/v2/user/info", "/team/*"]`)
only when their metadata identifies them as this harness's key for
the same verified membership (`source=meta-harness`, matching `deputydev-user-team-id`,
`axon_user_team_id`, or the older `deputydev_user_team_id` ownership marker). Native key
ownership is separately checked against the email-resolved LiteLLM user and selected team. The upgrade changes
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
  was resolved. `browser` means the optional dashboard proxy forwards only browser-supplied
  credentials; native 401/403 responses are preserved for that flow. A 403 from the CLI's
  `/key/info`, `/v2/user/info`, or `/mcp` should prompt inspection of
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
| `/litellm-admin/*` | Opt-in browser proxy (`LITELLM.UI_ENABLED`); LiteLLM's own login/auth, no backend credential injection |
| `/api/v1/otel/v1/{traces,metrics,logs}` | Session-authenticated OTLP/HTTP proxy with authoritative identity |
| `/api/v1/cli/releases/*` | Public release discovery, hashes, and CloudFront downloads; private upload-signing POST |
| `/ping` | FastAPI liveness route |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* the API routers, including `/install.sh`. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every registered route has been tried.

`/install.sh` serves the repository's `apps/cli/install.sh` with only its default release base URL substituted from `CLI_INSTALL.RELEASES_URL` in `config.json`. The Docker image copies that same script alongside the backend. Set `RELEASES_URL` to `https://YOUR_ORIGIN/api/v1/cli/releases` (no trailing slash); it is public and must contain no credentials. The script resolves `/latest/VERSION` once, then fetches `/<version>/checksums.txt` and `/<version>/axon-darwin-arm64.gz`. Downloads redirect to short-lived **signed CloudFront** URLs; S3 presigned GET is available internally but bypasses the cache. Installer, release pointer, checksums, and redirect responses are not cached. Users can install with `curl -fsSL https://YOUR_ORIGIN/install.sh | sh` or download the script for inspection first.

### Deployment under a path prefix

For `https://deputydev.ai/axon/`, keep the public mount consistent across the CLI, backend configuration, and ingress:

| Setting | Production value |
| --- | --- |
| CLI build/publishing `AXON_SERVICE_ORIGIN` | `https://deputydev.ai/axon` (no trailing slash) |
| Backend `CLI_INSTALL.RELEASES_URL` | `https://deputydev.ai/axon/api/v1/cli/releases` |
| Backend `AUTH_SERVICE.BROWSER_LOGIN_URL` | The actual browser login application's HTTPS URL ending in `/external-auth`; include its mount if applicable |

Ingress must strip `/axon` before forwarding to this app: `/axon/install.sh` becomes `/install.sh`, `/axon/api/v1/*` becomes `/api/v1/*`, and `/axon/litellm/*` becomes `/litellm/*`. Preserve HTTP methods, ordered queries, and streaming responses. Forward the entire mount, not only installer/release URLs. The backend's internal routes do not gain a hard-coded `/axon` prefix.

Restart the backend after changing its ignored `config.json` and rebuild the CLI with the prefixed service base. `CLI_RELEASES.KEY_PREFIX` controls S3 object keys independently; do not change CloudFront's distribution origin to a URL containing `/axon`.

Frontend console base-path support is deferred; the Dockerfile retains its root-based frontend build and needs no custom frontend build argument. See the [frontend follow-up note](../frontend/README.md#deferred-frontend-deployment-under-a-path-prefix). This does not block CLI or backend API deployment under `/axon`.

The current console is a scaffold, not the external-auth application. Only use `https://deputydev.ai/axon/external-auth` for `BROWSER_LOGIN_URL` if your deployment actually serves the login page there. The separate MCP catalog must likewise be available as JSON at `https://deputydev.ai/axon/v1/cli/pi/mcp.json`; the SPA fallback is not a catalog implementation.

Public smoke checks after publication:

```bash
curl -i https://deputydev.ai/axon/install.sh
curl -i https://deputydev.ai/axon/api/v1/cli/releases/latest/VERSION
curl -i https://deputydev.ai/axon/api/v1/cli/releases/0.2.0/checksums.txt
```

The release base URL itself has no GET route. An empty `LATEST_VERSION` intentionally makes `/latest/VERSION` return 503 until a verified release is promoted.

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

`GET /api/v1/cli/config` requires `Authorization: Bearer <Axon encrypted session>` and uses the shared auth-service guard. It returns only schema-versioned telemetry, web-search, terminal permissions, Pi defaults, and partial compaction/recommender/provider preferences, never private backend config, auth data, or credentials in the JSON body. Auth errors and successful responses use `Cache-Control: no-store`; auth-service refresh tokens remain response headers. Browser-login start/poll stay on their existing `/api/v1/auth/browser-login` routes. No public bootstrap endpoint is added.

The template includes a complete `CLI_CLIENT_CONFIG.TELEMETRY` object with `ENABLED: false`, explicitly disabling CLI telemetry by default. Its object structure lets the Vault/Kubernetes configuration generator compare nested keys against enabled environment configurations without recursing into a null template value. To enable centrally managed telemetry, configure an approved collector, for example:

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

Authenticated online Pi launches (interactive or scripted) fetch config best-effort with a 700 ms deadline and no response cache, even when telemetry and web search are locally disabled. Accepted telemetry enablement is backend-authoritative for the Pi extension and launcher product events, including startup buffering and shutdown flushing: there is no supported local opt-out via `PI_ORG_OTEL_ENABLED`, samplers, or exporters. Backend false also wins. Explicit offline disables export and skips config; help/administrative fetch exemptions are unchanged. Without accepted policy, Pi retains environment fallback and launcher exports remain managed-only. This is separate from upstream Pi's `PI_TELEMETRY`. Managed policy clears inherited exporter headers/TLS identity overrides and per-signal destinations. The embedded extension reads the shared saved Axon session for each batch, sends it only to the pinned backend proxy, and persists safe refresh headers with compare-and-swap so stale exports cannot overwrite a new login. No credentials or user profile are distributed in config JSON. Config/export failures never prevent Pi launch.

Clients that disconnect during a telemetry upload are treated as cancellations, not server errors:
the incomplete batch is not forwarded, concurrency capacity is released, and an INFO line records
`reason=client_disconnected` without a traceback or payload. The handler uses the conventional
499 cancellation status; the disconnected client may not receive a response.

The proxy accepts only POSTs to `/api/v1/otel/v1/traces`, `/v1/metrics`, and `/v1/logs` (all under the same prefix). It validates the shared session/subscription guard before reading protobuf, obtains verified email/name via auth data or the auth service’s existing POST `/verify-auth-token`, and rewrites identity in resources, scopes, records, events, links, datapoints, and exemplars. Client `user.*`/`enduser.*` fields are removed; `user.id` is the auth user ID when available, otherwise verified email. `user.email`, optional `user.name`, `pi.identity.source=axon_auth`, and `axon.user_team_id` are server-authoritative. Missing verified identity fails closed. No Git email is read by the extension in managed mode.

`PROXY.UPSTREAM_URL` is a private collector base (optional path prefix), not a signal-specific URL. Its origin must be explicitly approved in `ALLOWED_TELEMETRY_ORIGINS`. HTTP is allowed for trusted private-network collectors; public CLI-to-backend traffic requires HTTPS except local development. `PROXY.HEADERS` stays server-side. Caller authorization/cookies/query parameters are never forwarded. Redirects are refused; OTLP response bodies/statuses/Retry-After are preserved. Gzip uploads are decoded with a bounded expansion limit; collector requests are sent as uncompressed protobuf. Wire/decoded payload, response, record-count, timeout, and concurrent-request limits are enforced. The per-user-team rate limit and concurrency limit are **per backend worker**; add ingress/global controls for multiple workers and unauthenticated abuse.

Environment fallback retains standard HTTP/protobuf or gRPC exporters and environment-supplied headers/API keys. It never automatically attaches a Axon session, and its Git-email/installation-UUID attribution remains unchanged. Collector access and retention must cover verified employee identity and private repository names.

#### Pi startup defaults

The template enables codemode and the LiteLLM MCP bridge independently for managed Pi launches:

```json
"CLI_CLIENT_CONFIG": {
  "PI": {
    "CODEMODE_ENABLED": true,
    "LITELLM_MCP_ENABLED": true,
    "DEFAULT_PROVIDER": "",
    "DEFAULT_MODEL": ""
  }
}
```

When `PI` is configured, both toggles must be JSON booleans. The config API projects them as
`"pi": { "codemodeEnabled": true, "litellmMcpEnabled": true }`. Before launching Pi,
`axon` merges `"+codemode"` and `"litellm": { "mcp": { "enabled": true } }` into
`$AXON_HOME/pi/settings.json` (normally `~/.axon/pi/settings.json`), preserving other tool choices,
packages, LiteLLM MCP exposure/tool preferences, and unrelated settings. Enabling the bridge lets
Pi discover MCP tools through the authenticated LiteLLM relay; upstream permissions still apply.
It leaves `codemode.inlineBudget` unset, so Pi uses its default of 3000 unless the user has configured it.
Standalone `~/.pi/agent/settings.json` is never modified.

These are defaults, not enforced policy: Pi CLI flags and trusted project settings can override them.
On `/reload`, a managed online session fetches fresh backend Pi defaults through the launcher
relay before Pi reloads settings and provider extensions. This reapplies both Pi fields, including
restoring the backend MCP value after a local edit. It does not refresh telemetry/search or launch-only compaction/recommender/provider preferences
or poll in the background. Fetch/auth/schema failures preserve the current settings and warn safely.
Pi preserves already-active tools on reload: changing `CODEMODE_ENABLED` updates its tool-selection
default but does not forcibly deactivate an active codemode tool. The MCP bridge is recreated using
the freshly applied value.
`CODEMODE_ENABLED: false` sets a disabled codemode startup default; `LITELLM_MCP_ENABLED: false`
disables the LiteLLM MCP bridge without changing codemode or separately configured MCP servers.
`DEFAULT_PROVIDER` and `DEFAULT_MODEL` (for example `"litellm"` and `"openai/gpt-6.1-sol"`) set Pi's
`defaultProvider`/`defaultModel` and project as `pi.defaultProvider`/`pi.defaultModel`. Pi only uses a
saved default when both are present, so set both or neither; values must be trimmed text without control
characters, at most 256 characters. Empty strings or null leave the model unmanaged: nothing is sent and
the user's last `/model` choice stays. When set, the backend model is rewritten at every managed launch and
`/reload`, replacing a local `/model` choice; Pi's `--model`/`--provider` flags and resumed sessions still
take precedence. CLIs released before this field reject the whole `pi` section when the pair is set.
Omit `PI` or set it to null to stop managing all Pi defaults; this leaves the last local settings untouched. Offline, administrative,
unauthenticated, and failed config fetches do not change Pi settings. Defaults are persisted locally
and reused offline. Unsafe settings or a busy settings lock are left untouched, without blocking launch.
Restart the backend after a config edit; defaults apply on the next online authenticated CLI launch
or `/reload` in an updated managed online session. Existing sessions need one updated CLI launch
to load the managed reload hook.

#### Launch-only compaction, recommender, and provider preferences

Add optional siblings of `PI` under `CLI_CLIENT_CONFIG` (these are examples, not defaults):

```json
"COMPACTION": {
  "ENABLED": true,
  "MODEL": "litellm/your-summary-model",
  "THRESHOLD_TOKENS": 80000,
  "MAX_OUTPUT_TOKENS": 8192,
  "TIMEOUT_MS": 120000
},
"MODEL_RECOMMENDER": {
  "ENABLED": true,
  "TIMEOUT_MS": 15000,
  "AUTO_SELECT_MS": 10000
},
"LITELLM_CLIENT": {
  "DISCOVERY_TIMEOUT_MS": 5000,
  "DEFAULT_CONTEXT_WINDOW": 128000
}
```

The response uses `compaction` (`enabled`, `model`, `thresholdTokens`, `maxOutputTokens`, `timeoutMs`),
`modelRecommender` (`enabled`, `timeoutMs`, `autoSelectMs`), and `litellmClient`
(`discoveryTimeoutMs`, `defaultContextWindow`), without bumping schema version 1. Each supplied field
wins over its inherited CLI environment value. Missing/null fields retain local environment/default
fallback; absent/null/empty/all-null sections are omitted. No operational defaults are inserted.
Removing a field restores fallback on the next launch. These objects contain no credentials, URLs,
arbitrary environment keys, or generic Pi settings. `LITELLM_CLIENT` is distinct from private `LITELLM`.

Booleans are JSON booleans. Numeric fields must be integral JSON numbers (1 and 1.0 are equivalent),
not booleans, strings, fractions, or non-finite values. Compaction numbers and context fallback are
1–2147483647; recommender timeout/countdown are 1–300000 ms; discovery timeout is 0–300000 ms.
Zero disables provider discovery, including affected provider integrations. Recommender zero is not an
independent auto-select-off control. The model must be a trimmed `provider/model-id` (IDs may contain
slashes), at most 256 characters, without blank components or control characters. Registry/auth checks
remain at use time. All non-null fields are validated even if disabled; invalid operator settings fail
startup with a bounded non-secret diagnostic.

`COMPACTION.ENABLED=false` bypasses extension overrides, not native Pi compaction. Native settings
still govern automatic compaction/retention; model/auth checks, idle thresholds, overflow recovery,
and failure cancellation remain unchanged. Client recommender enablement cannot override a server
204 eligibility response. Provider context fallback only fills metadata gaps, never known context or
output limits. The pinned `pi-provider-litellm@4.2.0` may retain older custom fallback values in offline
caches; do not promise to rewrite all cached metadata without discovery. Publish correct model metadata.

Restart backend workers after edits; values apply on the **next authenticated online non-administrative
Pi launch**, interactive or scripted. They are launch-environment-only: no disk policy cache, background
polling, or `/reload` refresh. Pi's persisted two-toggle defaults remain separate. Unavailable config,
invalid individual sections, account changes/unverifiable credentials, offline, and administrative
launches retain documented local fallback. Explicit offline still suppresses managed discovery/search/
telemetry. Accepted `WEB_SEARCH` enablement and all five numeric values are also exact backend values;
local disables or lower limits no longer win. Authorized local `allowedModels` selection is unchanged.

The template contains structurally complete objects with every new leaf **null**, making them no-ops.
The external Vault/Kubernetes config generator is not included in this repository: before deployment,
run that actual workflow with null leaves and a partial populated section, inspect the rendered JSON,
and validate it with backend startup. Local template/parser tests are not evidence that the external
workflow ran. Roll out updated CLIs before relying on these semantics; older clients ignore new fields
but keep old search/telemetry overrides. Notify users that managed organization telemetry has no local
opt-out. This remains best-effort preference distribution, not guaranteed export or authorization.

### Model recommendations through LiteLLM

`POST /api/v1/model-recommendations` assesses a coding task with Jev and deterministically ranks
the compatible models in the backend catalog. Set the classifier model in backend `config.json`:

```json
"MODEL_RECOMMENDER": {
  "CLASSIFIER_MODEL": "typesafe/jev-1.14"
}
```

`CLASSIFIER_MODEL` is a non-empty LiteLLM model alias, not a deployment UUID. The default is
`typesafe/jev-1.14` when the section or field is omitted. Restart the backend after changing it.
This backend-only setting is separate from `CLI_CLIENT_CONFIG.MODEL_RECOMMENDER`, which controls
the CLI picker preferences; no CLI update is needed to change the classifier.

Register the configured alias in LiteLLM and ensure the deployment supports
**`POST /v1/systemone`**. This endpoint accepts our
existing `model`/`state`/`questions` payload and returns typed `answers`; `/v1/decisions` expects
a different format and is not interchangeable.

The backend reuses its app-owned buffered LiteLLM HTTP pool (isolated from proxy streams) and the private `LITELLM.UPSTREAM_URL`
and `UPSTREAM_ROOT_PATH`. Assessments always use the caller's backend-managed LiteLLM virtual
key, resolved from verified auth-service identity, even when `IDENTITY_SYNC_ENABLED` is false
for the proxy. The configured `API_KEY` is used only for management/provisioning in this flow,
never for assessment inference. There is no fallback to shared credentials. The caller's
user/team/key policy must allow `/v1/systemone` and the Jev alias. Keys never reach the CLI.
`LITELLM.DECISION_TIMEOUT_SECONDS` is a positive integer (default 120) bounding the buffered
assessment request. The recommendation API, catalog, ranking, and assessment parsing are unchanged.
Missing verified identity or failed provisioning returns a sanitized 503; disabled identities
return 403. Failed inference requests or malformed assessments return a sanitized 502; disabled
current models return 204 without inference, and Axon session authentication remains required.

There is no direct OpenRouter client or credential requirement in the backend. Remove the old
`OPENROUTER` block from private `config.json` files and restart the backend after deployment.
Provider credentials and routing now belong to LiteLLM. A Jev deployment configured as
`openrouter/typesafe/jev-1.14` still uses OpenRouter upstream; removing that dependency entirely
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

`CREDENTIALS: {}` or `CREDENTIALS: {"ACCESS_KEY_ID": "", "SECRET_ACCESS_KEY": ""}` uses the AWS
default credential chain, preferably short-lived role credentials. Paired empty strings are treated
as unset; partial credentials, whitespace-only values, or a session token without keys are rejected.
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
docker build --build-arg SERVICE_NAME=axon-backend -t axon-backend .
```

Both Python stages default to the private base `831059512818.dkr.ecr.ap-south-1.amazonaws.com/python:wolfi-3.12.14-r8`. Internal builds do not need to pass `PYTHON_BASE_IMAGE`, but the build runner must have ECR pull permissions and log in before building:

```bash
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin 831059512818.dkr.ecr.ap-south-1.amazonaws.com
```

Direct Docker builds fail if the selected base cannot be pulled; the Dockerfile does not automatically fall back.

### Public builds (no private registry access)

Use the public Wolfi base explicitly; no AWS credentials are required:

```bash
docker build \
  --build-arg PYTHON_BASE_IMAGE=cgr.dev/chainguard/wolfi-base:latest \
  --build-arg SERVICE_NAME=axon-backend \
  -t axon-backend .
```

Both Python stages use the selected image. The private base already supplies Python 3.12.14; the public base installs Wolfi's `python-3.12` package. The frontend stage remains `node:24-alpine`.

### Optional private-first fallback wrapper

`sh scripts/build-backend-image.sh --build-arg SERVICE_NAME=axon-backend -t axon-backend` (or `bun run build:backend-image`) attempts to pull the private base first and selects the public base if that pull fails. Run it after ECR login to enable private access. Pass Docker build flags without a build-context argument; the script supplies the repository root. A later build failure is not retried with another base.

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
