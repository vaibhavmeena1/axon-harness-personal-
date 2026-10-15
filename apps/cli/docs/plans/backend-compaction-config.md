# Backend-managed CLI preferences and environment precedence

**Status:** Implemented in the repository; external deployment validation and rollout remain pending. Native settings-lock interoperability remains a separately scoped hardening change.

### Implementation verification

- CLI full suite (with inherited managed telemetry markers removed from the test runner): **668 passed, 1 skipped, 0 failed**, including both compiled-launch variants, real provider fallback/cache checks, compaction consumption/failures, recommender 204, reload isolation, and launcher export/shutdown tests.
- Backend full suite: **734 passed, 2 failed**. Both failures are the existing recommendation contract assertions expecting `openai/gpt-5.6-sol` after the separately staged model catalog selects `openai/gpt-6.1-sol`; that catalog edit is intentionally untouched. Config/partial-section/shared-fixture and terminal projection tests pass.
- CLI resource/version/type checks, **68 targeted backend tests**, and modified-file Biome/Ruff checks pass. Workspace-wide Biome still reports unrelated existing formatting/import-order issues in `tests/installer/install.test.ts` and `tests/shared-auth-session.test.ts`; these files are untouched.
- The actual Vault/Kubernetes config-generation workflow is external to this checkout and has **not** been run. Validate null leaves and partial overrides in its rendered config before deployment. No backend restart, CLI publication, or fleet rollout has been performed.

## Decisions

- Keep the current `CLI_CLIENT_CONFIG.PI.CODEMODE_ENABLED` and `LITELLM_MCP_ENABLED` contract and behavior. Do not migrate to generic `PI.SETTINGS` for this feature.
- Add typed, allowlisted `COMPACTION`, `MODEL_RECOMMENDER`, and `LITELLM_CLIENT` sections to the existing authenticated CLI config endpoint.
- Manage `PI_MODEL_RECOMMENDER_DISABLED`, `PI_MODEL_RECOMMENDER_TIMEOUT_MS`, `PI_MODEL_RECOMMENDER_AUTO_SELECT_MS`, `LITELLM_DISCOVERY_TIMEOUT_MS`, and `LITELLM_DEFAULT_CONTEXT_WINDOW`, in addition to the five compaction variables. The requested `PI_MODEL_RECOMMENDER_AUTO_SELECT` refers to the existing millisecond countdown variable `PI_MODEL_RECOMMENDER_AUTO_SELECT_MS`; do not invent an alias or a separate auto-select boolean.
- For every explicitly supplied field in these new sections, backend values override inherited CLI environment values, including explicit `false` versus local `true`, backend `true` versus local `false`, and backend numeric values versus smaller local values.
- Omitted/null fields in the new sections retain the inherited local environment value, then existing extension/provider/native defaults if no environment value exists. Do not insert operational defaults into the new API objects.
- Change managed web search precedence: backend `enabled` and numeric values win, without a local-disable or lower-local-limit exception. Preserve the existing explicitly allowed local model-selection behavior; changing that behavior is not requested here.
- Change organization telemetry precedence: valid backend `enabled: true` cannot be disabled by local `PI_ORG_OTEL_ENABLED`, sampler, or exporter environment preferences. Backend `enabled: false` also wins over local enablement. Apply the decision to both the Pi extension and Axon's product telemetry, including shutdown flushing; add no local managed-telemetry opt-out command, setting, or flag.
- Explicit offline mode remains stronger than remote preferences: do not fetch config or enable managed search/telemetry/discovery while offline. Preserve administrative invocation behavior.
- Apply environment-based preferences on the **next authenticated online non-administrative Pi launch only**, including scripted launches. No background polling or environment refresh through `/reload`; the existing Pi-defaults reload flow remains separate.
- Do not persist these environment preferences to disk or mutate the launcher's `process.env`. Keep current telemetry command eligibility and bounds; do not introduce config fetches for previously exempt help/administrative commands solely for this feature.

## 1. Current codemode assessment

The existing approach is appropriate for a small, explicit startup-default contract:

- Backend and CLI validate both Pi toggles as booleans and reject unsupported Pi fields.
- The launcher uses Pi's native `defaultTools` semantics (`+codemode` / `-codemode`) rather than replacing the tool implementation or forking Pi.
- Updates preserve unrelated settings, tool selections, packages, and LiteLLM MCP preferences. Empty tool selections have an explicit special case.
- Repeated applications are idempotent. Invalid/symlinked settings are left untouched; optional defaults failures do not block launch.
- Backend values are reapplied at online launch and through the existing Pi-defaults reload flow, with credential rotation and account-change checks.
- Pi is version-pinned, and the repository checks that development dependencies match the pin.

Do not describe this as unrestricted future-proofing or central enforcement:

1. **Lock gap:** `settings-defaults.ts` and package synchronization use Axon's package lock, while Pi's `FileSettingsStorage` uses `proper-lockfile` on `settings.json` with `realpath: false`. Axon-to-Axon serialization does not prevent a concurrent Pi settings write from being lost.
2. **Startup-default semantics:** CLI flags and trusted project settings can override the defaults. A disabled built-in extension can also make an enabled tool default ineffective.
3. **Reload semantics:** Pi preserves already-active tools on `/reload`; changing the codemode default to false is not a guaranteed live deactivation.
4. **Removal semantics:** Omitting/nulling the backend PI section retains the last persisted defaults; it does not restore an earlier local value.
5. **Upgrade scope:** The two-toggle contract does not manage `codemode.mode`, `inlineBudget`, or arbitrary future Pi settings. Review native semantics and run integration tests on Pi upgrades rather than silently generalizing this contract.

Recommendation: retain the current design, fix native-lock interoperability in a separate hardening change, and keep regression tests against the pinned Pi runtime. There is no need for the broader ownership/journaling/settings-management redesign in [pi-managed-settings.md](pi-managed-settings.md) to deliver compaction environment overrides.

### Separate codemode/settings hardening

Use the existing direct `proper-lockfile` dependency to acquire Pi's native settings lock during settings transactions. Lock ordering must be Axon package lock, then Pi settings lock; read the latest file after acquiring the native lock, make the narrow update, write, and release in `finally`. Keep a bounded wait and preserve optional-default failure behavior.

Route defaults/provider-default writes and final package-settings reconciliation through the same transaction helper. Do not hold Pi's native lock across a `pi install` / `pi remove` subprocess, which can acquire that lock itself. Add cross-process tests using the pinned Pi writer, not just two callers of Axon's package lock. Test existing and missing settings files, busy locks, and loss of unrelated preferences. Also preserve Pi-compatible BOM reading and safe/private writes when introducing the helper.

This is independently shippable hardening, not a prerequisite or reason to expand the compaction feature into disk settings management.

### Reviewed baseline

The following targeted tests passed during planning; they do not cover the native-lock gap or prove correctness of the proposed feature:

- CLI: `tests/pi-settings-defaults.test.ts`, `tests/client-config.test.ts`, `tests/pi-client-config.test.ts`: **29 passed**.
- Backend: `tests/test_cli_config.py`: **36 passed**.

## 2. Operator and API contracts

Use siblings of `PI` under `CLI_CLIENT_CONFIG`: `COMPACTION` for Axon's compaction extension, `MODEL_RECOMMENDER` for the recommendation client's workflow, and `LITELLM_CLIENT` for the pinned provider's discovery/metadata fallback preferences. Keep `LITELLM_CLIENT` distinct from the backend's private `LITELLM` transport/auth configuration. These are not generic Pi settings or an arbitrary environment map.

Example operator configuration:

```json
{
  "CLI_CLIENT_CONFIG": {
    "PI": {
      "CODEMODE_ENABLED": true,
      "LITELLM_MCP_ENABLED": true
    },
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
  }
}
```

These are illustrative operator values, not validator defaults or a recommendation to assume the same context window for every model. Existing `CLI_CLIENT_CONFIG.TELEMETRY` and top-level `WEB_SEARCH` retain their configuration shapes; their precedence changes are specified below.

Projected response fragment:

```json
{
  "schemaVersion": 1,
  "compaction": {
    "enabled": true,
    "model": "litellm/your-summary-model",
    "thresholdTokens": 80000,
    "maxOutputTokens": 8192,
    "timeoutMs": 120000
  },
  "modelRecommender": {
    "enabled": true,
    "timeoutMs": 15000,
    "autoSelectMs": 10000
  },
  "litellmClient": {
    "discoveryTimeoutMs": 5000,
    "defaultContextWindow": 128000
  }
}
```

The existing `pi`, telemetry, search, and terminal wire shapes remain unchanged. Additive top-level fields do not require an envelope version bump: current clients ignore them, and updated clients accept absent new sections. However, the search/telemetry precedence changes require an updated CLI: old clients still honor their old local overrides. Deploy updated clients before claiming those precedence rules apply fleet-wide. No compatibility aliases or old-precedence mode are needed.

| Operator key | Public field | Child environment variable |
| --- | --- | --- |
| `ENABLED` | `enabled` | `PI_COMPACTION_ENABLED` |
| `MODEL` | `model` | `PI_COMPACTION_MODEL` |
| `THRESHOLD_TOKENS` | `thresholdTokens` | `PI_COMPACTION_THRESHOLD_TOKENS` |
| `MAX_OUTPUT_TOKENS` | `maxOutputTokens` | `PI_COMPACTION_MAX_OUTPUT_TOKENS` |
| `TIMEOUT_MS` | `timeoutMs` | `PI_COMPACTION_TIMEOUT_MS` |

Every field in the three new sections is optional. Do not insert validator defaults: a default-filled backend response would unexpectedly override local environment values.

### Model recommender and LiteLLM client mapping

| Section | Operator key | Public field | Child environment variable |
| --- | --- | --- | --- |
| `MODEL_RECOMMENDER` | `ENABLED` | `modelRecommender.enabled` | `PI_MODEL_RECOMMENDER_DISABLED` = `String(!enabled)` |
| `MODEL_RECOMMENDER` | `TIMEOUT_MS` | `modelRecommender.timeoutMs` | `PI_MODEL_RECOMMENDER_TIMEOUT_MS` |
| `MODEL_RECOMMENDER` | `AUTO_SELECT_MS` | `modelRecommender.autoSelectMs` | `PI_MODEL_RECOMMENDER_AUTO_SELECT_MS` |
| `LITELLM_CLIENT` | `DISCOVERY_TIMEOUT_MS` | `litellmClient.discoveryTimeoutMs` | `LITELLM_DISCOVERY_TIMEOUT_MS` |
| `LITELLM_CLIENT` | `DEFAULT_CONTEXT_WINDOW` | `litellmClient.defaultContextWindow` | `LITELLM_DEFAULT_CONTEXT_WINDOW` |

- Backend recommender `enabled: true` must replace local `PI_MODEL_RECOMMENDER_DISABLED=true` with `"false"`; `enabled: false` maps to `"true"`. Keep recommendation ranking and current-model eligibility in the backend's existing catalog/API; a client enable flag cannot override a server `204` policy-disabled response.
- Recommender `timeoutMs` and `autoSelectMs` must be integers in `1..300000`. Zero is not an auto-select-off sentinel: the existing parser would fall back to its default countdown. Disabling automatic selection independently would require a separately approved feature.
- `discoveryTimeoutMs` must be an integer in `0..300000`. Preserve `0` as the provider's discovery-disable value, not absence/fallback. It also affects provider integrations such as MCP, not just one model-list request.
- `defaultContextWindow` must be an integer in `1..2147483647`. It applies only when authoritative LiteLLM/catalog metadata is missing; it must not replace known per-model context windows, model output limits, or Pi settings. Prefer publishing correct `/model/info` metadata over a global fallback.
- Numeric validation must reject strings, booleans, fractions, and non-finite numbers, with equivalent integral-JSON-number semantics in Python and JavaScript as described for compaction below.
- Keep provider behavior version-pinned and validate against `pi-provider-litellm@4.2.0`. A changed fallback cannot be promised to rewrite all cached metadata when discovery is disabled. Test the provider's real fallback/cache behavior rather than silently overriding cached authoritative limits.

### Nulls, empty objects, and templates

- Missing/null `COMPACTION`, `MODEL_RECOMMENDER`, or `LITELLM_CLIENT`: no managed overrides from that section.
- `{}` or an object with all null fields: no managed overrides; omit that public section.
- Missing/null individual fields in these new sections: omit them from projection and preserve local environment values.
- Removing a previously supplied field restores environment/default fallback on the next launch. There is no previous managed value to reset on disk.
- Null on the public wire is treated as no override too, even though the backend normally omits it.
- Add structurally complete objects for all three new sections to `config_template.json`, with each supported leaf null. This exposes the known nested keys for deployment config generation without silently managing any field. Verify the actual Vault/Kubernetes config-generation workflow handles these null leaves before shipping.
- Do not change existing telemetry/search default-filling or nullable-level contracts under the guise of these new partial sections. A valid existing search policy is a complete configuration, not a collection of numeric maximums.

### Compaction validation

The common strict-type, unknown-field, and non-secret-error rules also apply to the other new sections, using their section-specific numeric ranges above.

- Reject unknown fields in the backend section and the CLI's compaction object; never accept an arbitrary environment/settings map.
- Booleans must be JSON booleans, not strings or integers.
- Numeric fields must be finite integers in `1..2147483647`, matching the extension's current environment parser. Python must reject booleans as integers. JSON representations such as `1` and `1.0` must have the same accepted integer semantics, since JavaScript cannot distinguish them after parsing. Use shared fixtures to enforce this rather than relying on Python strict-integer validation alone.
- Model must be a nonempty, trimmed `provider/model-id` string, at most 256 characters, without control characters; split only on the first slash so model IDs may contain slashes. Reject blank provider/ID components.
- Syntax validation does not prove a model exists or has credentials. Keep registry/auth validation at use time in the extension.
- Validate all supplied non-null values even if `enabled` is false; the public configuration contract remains strict.
- Invalid operator configuration fails backend startup with a bounded, non-secret diagnostic, as existing CLI settings do.

## 3. Resolution and lifecycle

Per field:

```text
validated, explicitly supplied backend value
    > inherited local PI_COMPACTION_* value
    > existing compaction extension / native Pi behavior
```

Examples:

| Backend | Local env | Effective value |
| --- | --- | --- |
| `thresholdTokens: 80000` | `PI_COMPACTION_THRESHOLD_TOKENS=100000` | `80000` |
| `enabled: true` | `PI_COMPACTION_ENABLED=false` | `true` |
| `enabled: false` | `PI_COMPACTION_ENABLED=true` | `false` |
| `model` absent/null | `PI_COMPACTION_MODEL=litellm/local-summary` | `litellm/local-summary` |
| `timeoutMs` absent/null | no local timeout | existing extension timeout, currently 120000 ms for custom summaries |

`enabled: true` alone does not invent a custom threshold/model/output budget; the existing extension still decides whether any actual overrides are configured.

The same per-field rule applies to `MODEL_RECOMMENDER` and `LITELLM_CLIENT`. A backend `discoveryTimeoutMs: 5000` overrides local `0`; backend `0` overrides a positive local timeout. Existing offline controls still suppress discovery.

### Managed web search precedence change

When a valid backend search section is accepted:

- Set `PI_WEB_SEARCH_ENABLED` from backend `enabled`, even if the inherited environment says false. Backend false also overrides local true. Offline still disables search.
- Set timeout, maximum query characters, maximum result characters, maximum output tokens, and maximum sources to the exact backend values. Remove the current `Math.min(local, backend)` behavior; smaller local numbers do not win. Invalid local values cannot poison a valid managed value.
- Keep existing backend temperature, thinking level, search context size, URL-context, and grounding mappings.
- Keep the existing allowed-local-model choice (`allowedModels`) and null optional-level handling unchanged. Do not conflate numeric/enable precedence with model authorization.
- Without an accepted search section, preserve existing environment/default fallback and pinned relay routing. Do not broaden any local fallback's credentials or destinations.

### Organization telemetry: no managed local opt-out

Resolve the decision in this order:

```text
explicit offline invocation -> disabled, no config fetch
accepted backend telemetry -> enabled/disabled exactly as configured
no accepted backend policy -> existing environment/default fallback
```

- An accepted backend `enabled: true` wins over all local false spellings of `PI_ORG_OTEL_ENABLED`, local `always_off`/zero sampling, and inherited exporter destinations. Apply backend sampling and interval values exactly; keep clearing inherited per-signal endpoints, auth headers, protocols, and TLS overrides as the existing managed transport does.
- Backend `enabled: false` disables telemetry even when local settings request export. A backend trace sample ratio of zero remains backend-directed sampling, not a local opt-out, and does not disable metrics/logs.
- Apply the same managed decision to the Pi extension, launcher product-telemetry initialization, buffered startup events, and shutdown flushing. Removing the check only in `createTelemetryOverrides()` is insufficient: `telemetry/client.ts` independently checks the parent environment during initialization and flush.
- Do not let a local false value skip an otherwise eligible bounded config fetch, erase buffered events before policy resolution, prevent managed runtime initialization, or suppress final flushing. Do not add a replacement managed opt-out CLI flag, slash command, or settings key.
- Carry accepted policy and resolution state in memory for the invocation. Distinguish “already fetched, no accepted policy” from “not resolved yet” so startup/flush does not refetch merely because a policy is absent. Reuse the startup result; existing other eligible command telemetry paths resolve policy once using their bounded authenticated fetch.
- Keep parent `process.env` unchanged. Pass the resolved decision through internal runtime/lifecycle APIs instead of setting global environment state or trusting an inherited managed marker.
- With no accepted policy, retain existing behavior: Pi may use configured environment exporters, whereas launcher product telemetry remains managed-only. A local disable still applies in this fallback path. Do not create a new environment-export mode for launcher product events.
- Account mismatch or inability to verify the current credential invalidates fetched telemetry/search and new-section preferences, not only Pi disk defaults. Retain safe credential rotations independently.
- This changes the earlier telemetry emergency-kill-switch contract. Update user/deployment/data-policy documentation and diagnostics so they no longer promise a local opt-out when the backend enables export. Do not conflate this feature with upstream Pi's separate `PI_TELEMETRY` setting.

“Backend wins every time” means every **successful, accepted config fetch** at an eligible launch. There is no supported local telemetry opt-out while a valid backend enable policy is active, but this remains client preference distribution, not an authorization or availability guarantee: offline operation, unavailable/invalid config, or a modified client cannot be made into guaranteed export by this plan. No last-known-policy disk cache or network-enforced mandatory telemetry is introduced. LiteLLM must continue enforcing actual model permissions, budgets, and rate limits.

### Launch lifecycle

| Situation | Compaction action |
| --- | --- |
| Successful authenticated online launch | Apply all explicitly supplied backend fields to the child environment. |
| Backend restart/config edit | New values apply on the next eligible launch, not to existing sessions. |
| Missing section or missing/null field | Preserve the corresponding local environment value. |
| Timeout, HTTP/auth error, malformed JSON, invalid envelope | Continue launch with local environment/default fallback; no cached policy. |
| Valid envelope/other sections, invalid compaction section | Ignore the entire compaction section, preserve other valid sections, use local fallback, and emit a bounded validation diagnostic. Do not partially apply malformed compaction fields. |
| Account changed or current account cannot be verified after fetch | Discard fetched compaction preferences; use local fallback. Preserve safe credential rotations independently. |
| Offline or administrative invocation | No config fetch and no managed compaction overrides; preserve existing local behavior. |
| `/reload`, new/resume/fork inside the same child process | Do not fetch/apply new compaction preferences. Continue using the launch environment. The existing Pi-defaults refresh remains separate. |

The lifecycle table above also applies to the new recommender/provider sections and to environment-based search/telemetry preferences, subject to their explicit offline/fallback rules. Retain the existing authenticated endpoint, fixed service origin, redirect refusal, 700 ms bounded fetch, 16 KiB response limit, no-store behavior, and credential rotation logic. Reuse the startup fetch for all sections; do not add one request per feature.

## 4. Implementation flow

```text
backend config.json: CLI_CLIENT_CONFIG + existing WEB_SEARCH
  -> validated, explicitly projected per-feature models on Settings
  -> existing GET /api/v1/cli/config
  -> CLI envelope validation + independent per-feature validation
  -> startup credential-rotation/account-consistency checks
  -> pure feature environment helpers + resolved telemetry decision
  -> effective discovery environment for provider/cache decisions
  -> createPiEnvironment(..., featureOverrides)
  -> existing extensions/provider read their known variables
  -> launcher product telemetry uses the same accepted telemetry decision
```

### Backend

- `apps/backend/app/core/cli_config.py`: add `CliCompactionConfig`, `CliModelRecommenderConfig`, `CliLiteLLMClientConfig` and their parsers; explicit uppercase-to-public-field mappings, strict validation, null normalization, and no injected operational defaults for the new sections.
- `apps/backend/app/core/config.py`: add optional feature fields to `Settings`, parse them from the existing JSON loader, and wrap validation errors consistently.
- `apps/backend/app/routers/cli_config.py`: add optional `compaction`, `modelRecommender`, and `litellmClient` to the response. Explicitly project only approved values, excluding null/unset fields and empty sections. Existing telemetry/search wire shapes need no change for the precedence fixes.
- `apps/backend/config_template.json` and `apps/backend/README.md`: document no-op new-section templates, partial overrides, backend restart, next-launch activation, exact managed search values, and backend-authoritative organization telemetry.
- Existing operator settings are deployment-wide; no new database, per-user storage, secrets, endpoints, or credentials in these sections.

### CLI

- `apps/cli/src/cli/client-config.ts`: add typed contracts and exported types for the three new sections. Normalize their nulls to absence. Validate each feature section independently so an invalid optional section cannot erase valid backend telemetry/search/other preferences and restore a local override accidentally. Invalid outer envelopes still invalidate the response; reject a malformed section as a unit rather than applying a subset of its fields. Preserve existing per-field validation rules unless explicitly changed here.
- Add pure `compaction-environment.ts`, `model-recommender-environment.ts`, and `litellm-client-environment.ts` helpers under `apps/cli/src/harnesses/pi/`. Use explicit allowlists. Return `{}` without a policy, map only provided non-null values, invert recommender enablement, and stringify booleans/integers. Do not drop `false` or provider timeout `0` through truthiness checks.
- `apps/cli/src/harnesses/pi/adapter.ts`: retain all accepted sections from the existing startup fetch. Discard all fetched preferences on account mismatch or account-verification exceptions; safe rotation persistence remains independent. Merge environment overrides after inherited values and preserve valid environment preferences if the separate optional Pi-defaults disk write fails.
- Compute an effective provider environment before the model-cache cleanup/discovery gate. The current gate reads inherited `LITELLM_DISCOVERY_TIMEOUT_MS`; it must instead see the final backend-overridden value so local `0` plus backend positive timeout triggers the proper stale-relay cleanup, and backend `0` preserves the disabled-discovery path. Keep `PI_OFFLINE` presence and `LITELLM_OFFLINE=1` semantics intact.
- `apps/cli/src/harnesses/pi/web-search-environment.ts`: replace local-disable-first and `boundedSetting(local, backend)` logic in the managed path with exact backend enable/numeric values. Leave fallback routing, credentials, allowed-local-model selection, and optional-level semantics intact.
- `apps/cli/src/harnesses/pi/telemetry-environment.ts`: order resolution as offline, accepted backend policy, then environment fallback. Preserve managed transport clearing/pinning and backend sampler/interval values.
- `apps/cli/src/telemetry/client.ts`: remove unconditional parent-environment disable short-circuits for accepted managed policy, retain queued events until the decision is known, reuse that decision during initialization/flush, and track whether policy lookup already occurred. Keep managed-only launcher exports, passive errors, bounded work, and existing command eligibility.
- `apps/cli/src/launcher/spawn-harness.ts`, `apps/cli/src/index.ts`, and internal launch/lifecycle contracts as necessary: pass actual offline status and the resolved telemetry decision consistently. Do not confuse `PI_ORG_OTEL_ENABLED=false` with explicit offline mode, or re-read the parent's false value after the child received a managed true value. Add no user-facing opt-out.
- Never mutate `process.env`, persist the new environment preferences in `settings.json`, accept arbitrary environment keys, or deliver credentials through these config objects.
- No relay/refresh endpoint or managed-reload-hook changes beyond consuming the validated additive envelope. Do not refresh these environment preferences on `/reload` or implement dormant live-refresh infrastructure.
- `apps/cli/src/harnesses/pi/resources/extensions/compaction.ts` and `model-recommender.ts`: retain native/environment consumption, cancellation, and failure behavior. Update configuration comments/guidance, without adding backend network calls.
- Update `apps/cli/README.md`, `apps/backend/README.md`, `apps/cli/docs/plans/cli-client-config.md`, `apps/cli/docs/shipplan.md`, and relevant telemetry deployment/data-policy documentation to remove superseded local-search-limit and managed-telemetry-kill-switch promises. Keep terminal permission behavior unchanged.

### Preserve existing compaction safety

This feature changes where preferences come from, not how compaction operates:

- `PI_COMPACTION_ENABLED=false` disables **extension overrides**, not native Pi compaction. Disabling native automatic compaction remains a Pi setting and is outside this feature.
- Native settings still govern retention and whether automatic compaction is enabled. Backend `enabled: true` does not override `compaction.enabled: false` in Pi settings.
- Custom threshold requests remain idle-time operations. Native overflow recovery is not suppressed by the custom threshold.
- Model IDs resolve through Pi's registered providers and their own authentication. No borrowing credentials, changing model limits, or silently switching to an unintended summary model.
- Invalid effective environment configuration or a configured-model/summary failure continues to cancel custom compaction rather than silently falling back to a different model; no successful compaction entry is appended by that failed attempt. Preserve existing warning, cooldown, and native recovery semantics.
- A configured threshold can be unsuitable for a model/context window or leave no useful history to summarize. This change must not promise all positive numeric combinations are operationally sensible or silently rewrite them.

## 5. Verification and delivery

### Contract/backend tests

Cover all three new sections: absent/null/empty input, partial values, explicit false/zero, unknown keys, wrong types, numeric bounds/non-finite values, model format/slashes/control characters, safe startup errors, and template loading. Check exact non-secret projection, no injected values, and a complete serialized response within the existing 16 KiB limit. Verify existing PI defaults and telemetry/search wire shapes are unchanged.

### CLI unit tests

- Backend wins for all ten new environment-variable mappings against conflicting local values; recommender enablement is inverted correctly.
- Explicit false and discovery timeout zero survive serialization. Recommender countdown zero is rejected, not interpreted as off.
- Unspecified/null fields in new sections keep inherited values; absent/all-null/empty policies produce no overrides.
- Managed search true beats every local false spelling; all five managed numeric values beat smaller, larger, and malformed local values. Allowed-local-model selection remains unchanged.
- Managed telemetry true beats every local false spelling and local disabled samplers; backend false wins over local true. Offline wins over both, and no-policy fallback preserves existing local behavior.
- Parent environment and unrelated environment variables remain unchanged.
- An invalid optional feature section does not discard valid other sections, especially a valid managed telemetry policy. Reject the whole malformed section rather than applying a subset.
- Run equivalent valid/invalid contract fixtures in Python and TypeScript.

### Adapter and extension integration tests

Extend `tests/pi-client-config.test.ts` to cover startup fetch reuse across all new sections and precedence changes, partial overrides, invalid/unavailable config fallback, scripted launches, offline/admin behavior, safe rotations, account-switch/read-failure discard, and independent Pi-defaults-write failures. Launch again after removing/changing a backend field to prove there is no stale managed cache. Verify none of the new environment preferences are persisted to disk.

Add actual managed telemetry lifecycle tests, not just child-env assertions: parent env false with backend true must initialize/export launcher product events, retain buffered startup events, enable the child's extension, and flush at shutdown. Assert bounded policy lookup occurs once even with a local false value; absent/invalid policy must not cause repeated lookup at shutdown. Cover accepted backend false, every false spelling, disabled local samplers/per-signal exporter overrides, account changes, explicit offline, and preserved help/admin exemptions. Existing tests asserting local telemetry/search disablement or lower search limits beat valid backend settings must be deliberately updated, not simply deleted. Update applicable `client-config`, `web-search-environment`, product-telemetry, and spawn lifecycle suites.

Test discovery gates using both conflict directions (local zero/backend positive and local positive/backend zero), plus offline/provider-offline behavior. Against the exact provider version, verify fallback context windows affect only metadata-missing models, authoritative per-model limits remain intact, and discovery-disabled cached behavior is accurately documented. Test the existing backend recommendation eligibility response still wins over client enablement.

Test effective environment consumption with the pinned Pi extension: configured model/auth lookup, false bypassing overrides without disabling native behavior, custom idle threshold scheduling, timeout/output-cap propagation, manual/overflow behavior, and retained existing failure behavior. Cover `/reload` retaining launch-time compaction/recommender/provider/search/telemetry values while existing Pi-default refresh still works.

### Delivery order

1. Add contract fixtures, backend parsers/projection/templates for the three new sections, and independent CLI feature-section parsing.
2. Add pure environment helpers, effective-provider discovery gating, and startup adapter wiring.
3. Change managed search precedence and implement one consistent backend-authoritative telemetry decision across child environment, launcher initialization, and shutdown flushing.
4. Add integration/regression tests and update operational/data-policy documentation, then run targeted and full checks plus a compiled-launch smoke test.
5. Ship the updated CLI and deploy backend config. Older clients ignore new fields but retain old search/telemetry opt-out behavior: client rollout is required to obtain the new semantics, not just a backend edit. No extra compatibility aliases/modes are needed.
6. Restart backend workers after edits; relaunch Axon/Pi to consume values. Communicate that managed organization telemetry no longer has a local opt-out.
7. Deliver native-lock interoperability separately without changing the approved codemode contract.

**Acceptance:** Accepted backend values beat local values for the ten new variable mappings and managed search enable/numeric settings. Valid backend-enabled organization telemetry has no supported local opt-out and applies to both Pi and launcher product telemetry through shutdown. Explicit offline remains respected; missing/null new fields and unavailable config retain documented fallback; codemode and terminal permission behavior remain unchanged; no new environment-policy state is persisted or refreshed live.
