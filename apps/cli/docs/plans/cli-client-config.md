# CLI client configuration: first-run login, telemetry, and standalone web search

**Status:** Implemented in this change; deployment still requires configuring the backend and shipping the CLI. This replaces the earlier bootstrap/login-consolidation proposal. Browser login stays on its existing endpoint; telemetry is the first concrete protected-config consumer.

## API boundaries

| URL | Methods | Contract |
| --- | --- | --- |
| `/api/v1/auth/browser-login` | `POST` | Existing login start: generates a pairing ID and returns `session_id` and the session-specific `browser_url`. |
| `/api/v1/auth/browser-login/{session_id}` | `GET` | Existing polling: returns `PENDING` or `AUTHENTICATED` with `encrypted_session_data`. |
| `/api/v1/cli/config` | `GET` | Axon-session-authenticated telemetry, web-search, terminal, Pi, and launch-only compaction/recommender/provider preferences. No login actions or credentials in JSON. |
| `/litellm/*` | Any supported LiteLLM method | Existing authenticated proxy for models, search completions, discovery, and provider integrations. |
| `/api/v1/otel/v1/{traces,metrics,logs}` | `POST` | Authenticated OTLP/HTTP ingestion; backend rewrites user identity and proxies to a fixed private collector. |

There is no public bootstrap/config endpoint or preliminary config GET for login. The CLI opens the browser URL returned by login POST, not a URL assembled from config. Browser-login session ownership, expiry, and replay behavior still belong to the existing auth service; this work does not change that protocol.

## CLI first-run preflight

Each invocation dispatches a command or launches Pi. A shared local session check runs **before command work**, including Pi resolution/installation/setup. A safely readable saved session indicates local onboarding completion, not proof of current server validity. Underlying APIs continue validating the credential.

| Invocation | Behavior |
| --- | --- |
| Normal `axon pi`, `setup pi --sync-packages`, `doctor [pi]`, `paths`, `harnesses` | With a saved session, continue without onboarding. Without one, an interactive online invocation offers the existing browser login, saves the session, then continues the originally requested command once. |
| Help/version/empty invocation, invalid launcher usage, `auth ...`, `update ...`, `uninstall ...`, and Pi's forwarded help/auth/administrative commands | No implicit onboarding or client-config fetch. Explicit login uses the existing POST/poll flow. |
| An eligible command without a saved session in non-TTY/CI mode, scripted Pi modes, or offline Pi | Fail with guidance to run `axon auth login` interactively while online. Do not prompt, fetch config, or provision Pi. |

- Reuse `loadEncryptedSession`; no separate onboarded flag. The current shared file is `${AXON_HOME}/264325ba-cbd0-47d5-9269-ac4bd19067c2.json` (see `SESSION_FILE_NAME`). Unsafe/unreadable files fail safely. Cancellation does not continue the original command.
- Pi preflight uses the existing invocation classifier and offline detector, respecting `--` argument boundaries. Launcher hooks run after Commander parsing, so help/unknown options do not start onboarding. Invalid setup/doctor harness choices also bypass onboarding and report usage.
- Selecting most commands means first-run diagnostics such as `doctor` require onboarding. Update, uninstall, and explicit re-authentication remain exempt for recovery.
- A saved token is not validated online just to run a local command; automatic re-login on token expiry and an online auth-status mode are future work.

## Protected config and source of truth

Example response:

```json
{
  "schemaVersion": 1,
  "pi": {
    "codemodeEnabled": true,
    "litellmMcpEnabled": true
  },
  "telemetry": {
    "enabled": true,
    "endpoint": "/api/v1/otel",
    "protocol": "http/protobuf",
    "traceSampleRatio": 0.25,
    "metricExportIntervalMs": 10000
  },
  "webSearch": {
    "enabled": false,
    "model": "gemini-3.8-flash",
    "allowedModels": ["gemini-3.8-flash"],
    "timeoutMs": 60000,
    "maxQueryCharacters": 20000,
    "maxResultCharacters": 30000,
    "maxOutputTokens": 8192,
    "maxSources": 20,
    "temperature": 1,
    "useUrlContext": false,
    "requireGrounding": true
  }
}
```

- The route uses `require_authenticated_user`. It projects only approved per-feature settings; it never serializes auth data, private backend settings, exporter headers, or session credentials. Success and auth errors are `Cache-Control: no-store`.
- Settings come from deployment-wide `CLI_CLIENT_CONFIG.TELEMETRY` in the backend's `config.json`, separate from backend `OPEN_TELEMETRY`. There is no new team database or per-user policy storage. A missing/null telemetry section omits telemetry, preserving environment fallback; independent Pi/search sections remain available.
- Use `ENABLED`, optional fixed `ENDPOINT=/api/v1/otel`, `PROTOCOL=http/protobuf`, `TRACE_SAMPLE_RATIO`, and `METRIC_EXPORT_INTERVAL_MS`. Enabled managed policy requires an enabled `PROXY` and auth service. Trace ratio is 0–1; metric interval is 1,000–300,000 ms. Defaults are ratio 1 and interval 10,000 ms.
- Private collector origins must be explicitly approved in `CLI_CLIENT_CONFIG.ALLOWED_TELEMETRY_ORIGINS`. `PROXY.UPSTREAM_URL` and optional server-only `HEADERS` configure ingestion, never the public CLI destination. HTTP is allowed for trusted private networks. The CLI resolves the fixed proxy path against its compiled service origin, requiring HTTPS except loopback development.
- Backend settings are validated at startup and cached: restart after changing them. The checked-in template explicitly disables telemetry; new partial launch sections have null leaves and do not silently manage any fields.

## Pi consumption and precedence

`CLI_CLIENT_CONFIG.PI` independently controls `CODEMODE_ENABLED` and `LITELLM_MCP_ENABLED`;
both must be JSON booleans when the section is present. They project as `pi.codemodeEnabled` and
`pi.litellmMcpEnabled`. Optional `DEFAULT_PROVIDER`/`DEFAULT_MODEL` project as `pi.defaultProvider`/`pi.defaultModel`
and are written to Pi's `defaultProvider`/`defaultModel` as a pair; empty or null values are not sent and
leave the local model untouched. The launcher persists the tool-selection default and
`litellm.mcp.enabled` in its managed Pi settings before startup, preserving unrelated settings and
MCP exposure preferences. These are startup defaults, not enforced policy; normal Pi project/CLI
overrides remain available. Omitted/null `PI`, offline/admin launches, failed config fetches, and
account changes during the request retain the last local defaults. Restart the backend after edits;
updated clients pick them up on their next authenticated online launch or `/reload`. On reload, a
managed extension awaits `session_shutdown(reason: "reload")` to request a fresh fetch/apply through
`POST /_axon/pi-defaults/refresh` on the capability-protected loopback relay. The launcher alone reads
and rotates the real credential, validates the bounded config, and updates settings under the shared
lock after rechecking cancellation/account identity. The refresh endpoint is disabled for offline
launches. Quit/new/resume/fork do not fetch. Errors preserve current settings and do not block reload.
This refresh applies only Pi defaults, not telemetry/search/compaction/recommender/provider environment preferences. Pi rereads
settings and recreates provider extensions afterward, so the MCP flag takes effect; its native
reload behavior preserves already-active tools even when the codemode default changes. Organization
MCP catalog sync remains separate and still adds new catalog entries disabled.

After first-run login if necessary, an **online non-administrative Pi** invocation with a saved session makes one authenticated config GET while building its child environment, even with local telemetry/search switches off. The request is limited to 700 ms, including body reading, and 16 KiB, refuses redirects, validates schema version 1, and ignores unknown fields. There is no disk config cache.

Precedence is:

1. Explicit offline mode: export disabled and no config request.
2. An accepted fetched telemetry policy: enablement, endpoint, protocol, sampler, and metric interval win over local preferences, including all local false values or disabled samplers. Backend false also overrides local enablement. There is no supported local managed-telemetry opt-out.
3. Missing/unavailable/invalid policy: existing Pi environment settings (including local disablement); launcher product telemetry remains managed-only.
4. No policy or environment endpoint: the loaded extension remains inert.

The CLI maps known fields to `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_METRIC_EXPORT_INTERVAL`, and `PI_ORG_OTEL_ENABLED` in the **child environment only**, without mutating `process.env`. The extension consumes launcher-owned managed endpoint/home markers at session start and performs no config fetch itself. Its bundled managed HTTP transport safely reads the saved session for each batch, refuses redirects, honors bounded retries, and persists response rotation with compare-and-swap.

- Clear inherited per-signal destinations/protocols when config manages the collector; otherwise the OTEL SDK can give those precedence over the base endpoint. Do not forward inherited collector authorization headers or TLS identity overrides to the configured sink. Config does not deliver credentials or arbitrary environment maps. Managed transport attaches only the locally saved Axon session to the pinned proxy; environment fallback never automatically attaches that session.
- Local service name/resource attributes and bounded batch-queue tuning remain environment-owned. Managed proxy attribution replaces Git/installation identity with verified auth-service identity; other collection/redaction stays unchanged. Sampling applies to **traces**, not metrics/logs; setting ratio zero is not a full telemetry disable.
- Pi administrative and offline invocations make no foreground config request; authenticated online scripted modes do. Explicit offline Pi disables telemetry and search, including environment-configured export. Missing-session preflight still blocks eligible scripted/offline invocations.
- HTTP/auth/schema/network failures fall back without triggering re-login, deleting the saved token, or preventing Pi launch. Login completion itself is not followed by a separate config GET unless the original command launches online non-administrative Pi.
- If a successful authenticated response carries a safe, bounded `x-session-refresh-token` (even when its config JSON is invalid), save it atomically with 0600 permissions, preserving unrelated shared-file keys; keep the refreshed token in the launcher-owned session store. Pi's LiteLLM/recommender/search environment receives only a per-launch local relay capability. Serialized CLI writers compare the current token with the request token before replacement. External VS Code writers do not share this lock, so cross-client races remain best-effort. Discard all fetched preferences if the saved session changed or cannot be verified after the fetch. Safe rotations are independent of optional preference failures. Never print bodies, tokens, or headers.

## Partial launch-only preferences

`CLI_CLIENT_CONFIG.COMPACTION`, `MODEL_RECOMMENDER`, and `LITELLM_CLIENT` project as optional
`compaction`, `modelRecommender`, and `litellmClient` sections in schema version 1. They are typed
allowlists, not arbitrary settings/environment maps; each supplied backend value wins over inherited
local values. Missing/null fields preserve local environment then existing defaults. Empty/all-null
sections are absent, with no operational defaults. Explicit false and discovery timeout zero survive;
recommender enablement maps inversely to `PI_MODEL_RECOMMENDER_DISABLED`, and its countdown is the
positive `PI_MODEL_RECOMMENDER_AUTO_SELECT_MS`, never a boolean alias. Server 204 eligibility still wins.

Each optional feature section is validated independently and rejected as a unit when malformed; valid
other sections survive. Bad outer envelopes still reject the whole response. Diagnostics never print
inputs. Account mismatch or verification failure invalidates every fetched preference, not just disk
defaults. An optional Pi-defaults write failure alone does not invalidate environment preferences.

All environment preferences use the startup result only, on the next authenticated online
non-administrative launch (including scripted launches). No parent environment mutation, disk policy
cache, polling, or `/reload` refresh is added. Provider cache cleanup sees the final backend-overridden
discovery timeout. Explicit offline and provider-specific offline controls retain their semantics.
Launcher product telemetry carries both accepted policy and resolved-absence in memory, retains
buffered events until resolution, and reuses the decision during initialization and flushing.

See [the detailed contract](backend-compaction-config.md) and [operator setup](../../../backend/README.md#launch-only-compaction-recommender-and-provider-preferences)
for ranges, mappings, compaction safety, provider fallback/cache limitations, and rollout requirements.

## Standalone web search

Backend `WEB_SEARCH` publishes the standalone extension's non-secret preferences: `enabled`, `model`,
`allowedModels`, `timeoutMs`, `maxQueryCharacters`, `maxResultCharacters`, `maxOutputTokens`, `maxSources`,
`temperature`, optional `thinkingLevel` and `searchContextSize`, `useUrlContext`, and `requireGrounding`.
There is no search endpoint/key/header/identity in client-config. Null optional levels are omitted from
JSON and clear inherited overrides on managed launches. Generation/grounding defaults come from the
backend; accepted backend enablement and all five numeric settings win exactly over local values,
including local disablement, smaller limits, or malformed values. Authorized local model selection remains unchanged. Missing config preserves environment
preferences, but never changes managed routing.

The extension constructs a dedicated `stream:false` Chat Completions request with unified
`web_search_options`, its system prompt/current date, query, and attribution metadata. The launcher
pins the exact endpoint to `/litellm/v1/chat/completions` on the authenticated local relay. That relay
reads the current saved session, safely persists refreshes, and can recover an expired session using
the ordinary model-request flow. The backend proxy resolves the same native LiteLLM identity and
preserves upstream streaming. No separate backend search router/service exists.

The extension reads bounded raw JSON rather than Pi's normalized assistant result so Gemini grounding
metadata and citation annotations are retained. It explicitly sends the canonical Pi session header
and returns provider tokens and the LiteLLM cost header as tool usage because raw fetch bypasses
provider hooks. Reasoning uses `reasoning_effort`; search uses `web_search_options: {}` unless a context
size is configured. Gemini ignores that size in LiteLLM 1.104.0. URL context remains Gemini-specific.

Plain Pi use may resolve `pi-provider-litellm` auth/root/headers per call via Pi's public model registry,
or explicitly pair a URL/base with its own key. Credentials resolved for one root cannot be borrowed
for a different endpoint. The provider package is not forked or imported as a library. Search settings
are client preferences, not global authorization; LiteLLM owns model permissions, budgets, and rates.

## Trust and non-goals

Managed telemetry includes verified auth email/name and user-team membership; environment fallback includes Git email or installation identity. Both include private repository identity. Keep collector access and retention aligned with the [data policy](../../src/harnesses/pi/telemetry/docs/data-policy.md). Remote settings cannot broaden collection. Accepted managed enablement has no supported local opt-out, for either the extension or launcher product events through shutdown. Explicit offline still wins. This is separate from upstream Pi's `PI_TELEMETRY`. Unavailable policy, offline, or a modified client means this is not a guaranteed-export mechanism.

Keep Pi/package pins, service origin, managed LiteLLM/recommender URLs, and installer/updater decisions compiled or on their existing operation-specific APIs. MCP catalog sync remains separate. Config failure must not break launch/update/recovery. This work adds no release gates, downloaded extensions, public config, account-summary UI, disk config cache, or telemetry storage/collector deployment. The authenticated proxy forwards to a separately operated collector.

## Verification

CLI tests cover local completion, cancellation/unsafe files, missing-session noninteractive/offline guidance, help/admin/recovery exemptions, pinned config/auth paths, schema/URL/size/deadline validation, remote-over-env precedence, collector-header removal, env fallback, offline/no-policy local fallback, backend-authoritative enablement, buffered startup export and shutdown, once-only policy resolution, atomic refresh/stale responses, and actual Pi-adapter fetch/environment/rotation wiring. Backend tests cover guarded projection, safe 401/403/503 errors, no-store, optional settings, allowlisted private URLs/bounds, config-template loading, all three protobuf signals, gzip/body limits, record-level identity replacement, minimal auth-contract verification, private-header isolation, collector responses, rate/concurrency limits, and redirect refusal. Managed exporter tests cover real serialized signals, dynamic session reads/rotation, concurrent-login protection, environment isolation, retries/deadlines, redirect/auth failures, and missing Git reads.
