# Managed Pi settings: validation, reconciliation, and safe reset

**Status:** Proposed implementation plan; no runtime changes implemented.

**Scope:** Expand the authenticated CLI config path from a codemode toggle into general, validated startup-default management. Cover shared validation, nested merging, array semantics, Pi-compatible locking, and ownership/reset tracking. Do not turn startup defaults into enforced policy or silently authorize executable resources.

## Existing behavior and motivation

- Backend `app/core/cli_config.py` accepts only `CLI_CLIENT_CONFIG.PI.CODEMODE_ENABLED` and `LITELLM_MCP_ENABLED`; see [cli-client-config.md](cli-client-config.md#pi-consumption-and-precedence) for the current contract.
- CLI `src/cli/client-config.ts` accepts only `pi.codemodeEnabled` and `pi.litellmMcpEnabled`.
- `src/harnesses/pi/settings-defaults.ts` modifies `defaultTools`, preserving unrelated settings in an ordinary update.
- Managed Pi uses `$AXON_HOME/pi/settings.json`, not standalone `~/.pi/agent/settings.json`.
- Axon's package lock and Pi's native `settings.json.lock` are different. An isolated audit reproduced a Pi preference being lost when Axon renamed a stale settings snapshot over a concurrent Pi write.
- There is no settings ownership history. Removing the current backend PI section leaves its last applied value in place.

The existing targeted suites passed 49 CLI tests and 30 backend tests. These are the baseline, not proof of the proposed feature's correctness.

## Recommended behavioral decisions

1. Use native Pi setting names inside `PI.SETTINGS`; do not create an uppercase alias for every field.
2. Treat SETTINGS as the **complete desired set of managed settings**, not a one-off JSON merge patch.
3. First enrollment may replace a pre-existing local value, but must capture it before changing it.
4. Later reconciliation updates only still-owned values. A divergent local value, including deletion, becomes a local override and is preserved. Do not silently re-enroll it on later launches or backend revisions.
5. CLI options and trusted project settings retain Pi's existing precedence. Do not write project settings or enforce policy through this mechanism.
6. Missing/null PI, unavailable config, offline/admin launches, and account-verification failure leave settings and ownership unchanged. A successfully fetched `SETTINGS: {}` explicitly releases all currently owned settings.
7. Never guess a baseline or overwrite settings during ambiguous recovery.
8. Replace the special CODEMODE_ENABLED contract. This project is in initial development; do not add compatibility aliases unless deployment requirements explicitly demand them.

The local-override decision changes the current toggle's repeated-overwrite behavior and should be approved before implementation. If central enforcement is wanted instead, design it as a separate policy mode; do not ambiguously label it a default.

## Proposed operator and API contracts

Backend configuration:

```json
{
  "CLI_CLIENT_CONFIG": {
    "PI": {
      "SETTINGS": {
        "defaultTools": ["+codemode"],
        "codemode": {
          "mode": "on",
          "inlineBudget": 3000
        },
        "compaction": {
          "enabled": true,
          "reserveTokens": 16384
        },
        "quietStartup": "header"
      }
    }
  }
}
```

Proposed public response fragment:

```json
{
  "schemaVersion": 2,
  "pi": {
    "settingsSchemaVersion": 1,
    "piVersion": "1.2.0",
    "settings": {
      "defaultTools": ["+codemode"],
      "codemode": { "mode": "on", "inlineBudget": 3000 }
    }
  }
}
```

- Bump the outer schema version because the Pi response shape changes incompatibly. Update the CLI and backend together; an incompatible client safely retains its existing settings rather than guessing.
- Validate Pi's section independently after validating the envelope. An unsupported Pi settings version must not discard otherwise valid telemetry/web-search sections.
- Populate `piVersion` from the reviewed contract, which must match the repository's pinned Pi version. A runtime override to a different Pi version skips settings management with a bounded diagnostic, rather than applying an untested contract.
- Exclude unset fields from projection. **Do not inject Pi defaults through validator defaults**: an omitted setting must remain unmanaged.
- Preserve the existing authenticated, no-store, fixed-origin fetch and session-rotation behavior. Never put credentials in the public settings object or diagnostics.
- Keep the bounded fetch deadline and response size. Check the complete serialized response server-side against the CLI's current 16 KiB bound; cap collection sizes/depth in the contract. Increase the bound only through an explicit, tested contract change.

### Removal semantics

| Input/event | Action |
| --- | --- |
| No valid fetched config; missing/null PI | No reconciliation and no reset. |
| `PI.SETTINGS: {}` | Release all still-owned paths using safe restoration rules. Preserve local overrides. |
| A formerly managed path is omitted from a new valid SETTINGS object | Release that path only. |
| `defaultTools: []` | Explicitly request an empty startup tool selection, not release ownership. |
| A setting is null | Accept only if that setting's reviewed Pi contract actually permits null. Null is not a generic delete instruction. |
| User changes/deletes a managed path | Preserve it, record adoption/local override, and require explicit local re-enrollment to manage it again. |

## 1. Shared, version-pinned validation

Create a small checked-in contract package under `contracts/pi-settings/`:

- A canonical JSON Schema for the public settings object, derived from the reviewed subset of Pi 1.2's published `settings.schema.json`. Vendor the source from the pinned Pi release; do not fetch the unversioned `https://pi.dev/schemas/settings.schema.json` during launch. Schema validity does not authorize remote management: retain the excluded-field inventory below.
- Metadata describing the supported Pi version, each field's reconciliation rule, and explicitly excluded fields.
- Shared valid/invalid fixtures used by both language implementations.

Use established JSON Schema validators rather than hand-maintaining equivalent Pydantic and Zod field definitions:

- Backend: validate SETTINGS with a reusable `jsonschema` validator, wrapped by the existing Pydantic config/response models.
- CLI: generate an Ajv standalone validator and TypeScript declarations at build time. Keep Zod for the outer config envelope and call the generated validator for the Pi settings object.
- Disable coercion, default insertion, and unknown-property removal. Commit generated CLI artifacts and provide `--check` to detect stale outputs. Validate the schema itself in CI and backend initialization.

This keeps one runtime contract instead of two manually synchronized type systems. Prefer tested schema/type generation libraries to a custom schema-to-Pydantic/Zod generator. Do not bundle the entire Pi SDK or a runtime schema compiler into the launcher merely to validate JSON.

Validation requirements:

- Unknown supported-object fields are errors, not silently stripped.
- Strict booleans, finite numbers, safe integers where Pi requires them, and reviewed enums/ranges. Python must reject booleans as integers and numeric/string coercion just as the CLI does. Treat JSON numbers consistently across runtimes: an integral number such as `1.0` is not distinguishable from `1` in JavaScript. Explicitly reject non-finite Python values before schema validation.
- Model-ID maps support exact keys containing `/`; ordinary nested object keys remain schema-defined.
- Reject prototype-sensitive keys recursively; use own-property access/null-prototype maps in reconciliation.
- Bound strings, arrays, maps, depth, and total response bytes.
- Optional fields stay optional; no default-filling in the managed object.
- Do not validate or drop unrelated local settings through the managed schema. Preserve them as opaque JSON unless their shape prevents a safe managed update.

Extend `scripts/check-pi-version.ts` and CI so the pin, contract version, and reviewed field coverage stay synchronized. Newly introduced Pi fields must be explicitly supported or excluded. Numeric limits and semantic changes still require review and runtime tests; TypeScript types are not a runtime validator.

Start with ordinary settings: codemode, model/thinking defaults, compaction, branch summaries, retry/timeouts, tool selection, terminal/display/image settings, and other reviewed preferences. Keep package declarations under the existing package owner. Executable resources, commands, proxies, trust changes, identity/internal fields, and launcher-owned paths require explicit classification rather than generic passthrough. In particular, `sessionDir` cannot be promised to take effect while the launcher sets `PI_CODING_AGENT_SESSION_DIR`.

## 2. Nested merging through a pure reconciler

Implement a side-effect-free function taking current local settings, validated desired settings, and ownership state. Return next settings/state plus changed, restored, adopted, and conflicting paths.

- Reconcile scalar leaves independently; preserve unspecified siblings and unknown local keys.
- Use escaped JSON Pointer paths internally, not dot-separated strings. For example, a model ID containing `/` must remain one map key.
- Treat array fields as atomic ownership units, not individual numeric indices.
- Detect scalar/object shape conflicts in current local settings. Preserve and report them instead of replacing a malformed parent and losing unrelated data.
- Record which missing parent objects the manager creates. On release, prune only manager-created parents that remain empty; preserve pre-existing empty objects.
- Compute changes from the preserved baseline and latest desired value, not by repeatedly appending to the last managed output.
- Use structural JSON equality with order-insensitive objects and order-sensitive arrays. Identical reconciliation must not rewrite settings or state.

Example: managing `compaction.reserveTokens` must preserve the user's `compaction.keepRecentTokens` and unrelated `compaction.modelOverrides` entries. Dropping reserveTokens later restores/deletes only that leaf according to its recorded baseline.

## 3. Explicit array rules

Do not implement one universal concatenate/deduplicate rule.

| Field category | Rule |
| --- | --- |
| `enabledModels` and ordinary replacement lists | Desired array replaces the field while owned; preserve the original array for release. |
| `defaultTools` with a plain tool name, mixed names/modifiers, or `[]` | Use Pi's replacement-selection semantics. `[]` means no selected tools. |
| `defaultTools` containing only nonempty +/- modifiers | Apply modifiers on top of the recorded baseline selection, preserving other tool choices and modifier ordering. |
| Resource directive lists, if explicitly admitted later | Implement Pi's ordered include/exclude semantics; plain string concatenation or set deduplication is insufficient. |
| `packages` | Remain controlled by the existing package synchronizer; reject here to prevent two owners. |

The empty baseline tool array is a mandatory special case: applying `+codemode` to `[]` must produce only codemode, not restore Pi's inherited built-in tools. Recompute backend edits from the original baseline so old managed modifiers cannot accumulate.

Initially, ownership is whole-field for arrays. If a user subsequently adds, removes, or reorders array entries, adopt the whole field and preserve it. This intentionally sacrifices partial remote control rather than deleting user additions during reset. Per-entry ownership can be a later, separately tested feature.

Use the pinned Pi SettingsManager in development tests to verify actual tool resolution and project-overlay behavior. Do not copy assumptions about list semantics into tests without checking the runtime.

## 4. Pi-compatible read/modify/write locking

Introduce a shared settings transaction helper, for example:

```typescript
withPiSettingsTransaction(paths, ({ settings, ownership }) => {
  return reconcileManagedPiSettings(settings, desired, ownership);
});
```

Make `proper-lockfile` a direct runtime dependency rather than relying on Pi's transitive development dependency. Match the pinned Pi lock protocol: acquire the lock for the settings path with `realpath: false`, yielding the same `settings.json.lock` directory and compatible lease/heartbeat behavior.

Transaction rules:

1. For mutation, acquire Axon's existing package lock first, then Pi's native settings lock. Apply this ordering consistently.
2. Acquire the native lock before checking existence, reading the file, or taking the mutable snapshot; include creation of previously missing settings.
3. Re-read settings and ownership after acquisition, then reconcile and write while both locks are held.
4. Reject unsafe/non-regular/symlinked files; support the BOM format Pi itself accepts. Create temporary files exclusively and privately, preserve appropriate existing settings mode, flush, atomically rename, and release in finally blocks.
5. Use bounded lock waiting. Optional managed-default failure skips the update and does not block Pi launch. Required package setup retains its existing operation-specific failure policy.
6. Read-only package/doctor snapshots should also respect Pi's lock, because Pi can write settings in place. A snapshot is never a license to write later without re-reading under a transaction.

Update both defaults management and package synchronization to use the transaction helper. In package synchronization, acquire the native lock only for short reads or the final settings reconciliation. **Never hold it across `pi install` or `pi remove`**, since the child Pi acquires that same lock and would deadlock.

Any remaining low-level unlocked reader/writer must be private to the transaction implementation, not a public path callers can accidentally use with stale snapshots.

## 5. Ownership, restoration, and crash recovery

Store private provenance outside Pi's settings file, for example:

```text
$AXON_HOME/pi-managed-settings.json
$AXON_HOME/pi-managed-settings.pending.json
```

Both files require strict schema validation, regular-file/ownership checks, private permissions, and bounded size. Add their paths to `AxonPaths`.

Per owned scalar leaf or atomic array field, record:

- Escaped path and merge strategy.
- Whether the original baseline existed and its exact JSON value.
- Last applied value and the desired value it came from.
- Manager-created parent paths where needed.

Also record state schema version, Pi contract version, committed transaction ID, and sticky adopted/local-override paths. Policy hashes are informational/no-op aids, not a substitute for reading actual settings. Do not include credentials or emit baseline values in diagnostics.

### Three-way reconciliation

| Situation | Behavior |
| --- | --- |
| Newly managed path without a local override marker | Capture current baseline and apply the desired value; preserve an already equivalent value without redundant rewriting. |
| Still managed, current equals last applied | Compute the updated value from baseline and new desired settings. |
| Still managed, current differs from last applied | Preserve current, drop active ownership, and record a sticky local override. |
| Dropped from desired, current equals last applied | Restore baseline if originally present; otherwise remove only that managed leaf/field. |
| Dropped from desired, current differs from last applied | Preserve current and record/retain local override; never restore over it. |

A user deletion is a change, not an invitation to recreate the setting. Sticky local overrides survive backend revisions until an explicit local re-enrollment operation. CLI/project overrides do not modify the global file and must not trigger adoption.

Existing writes made by the legacy codemode toggle have no baseline history. Enrollment can capture only the settings present at migration time; it must not claim it can reconstruct or undo older changes.

### Crash-safe commit

Settings and provenance are two files; two independent atomic renames do not make one atomic transaction. Use a write-ahead journal under the transaction locks:

1. Prepare and durably persist the journal containing the transaction ID, affected before/after path values, and next ownership state.
2. Durably replace settings.
3. Durably replace ownership state with that transaction ID.
4. Remove the journal and durably complete cleanup where supported.

Before any future managed mutation, inspect pending recovery under the same locks:

- State already has the journal's committed transaction ID: cleanup only, preserving any later user edit.
- Affected settings match the prepared after-values: finalize ownership without replaying the settings write.
- Affected settings match the before-values: abort the uncommitted operation and retain prior ownership.
- Mixed/conflicting evidence, malformed state/journal, or unsupported state version: preserve settings and report a recovery conflict; do not replay a stale full-file snapshot. Skip management until explicit recovery.

Handle unchanged affected values explicitly so an operation with no settings change can still safely release ownership. Missing initial state means no restoration rights; never infer historical ownership from matching values. A known prior state/journal loss must not be treated as recoverable baseline information.

Extend `doctor pi` with concise owned-path, local-override, version-mismatch, lock, and recovery diagnostics. An explicit local re-enrollment/reset operation must have a preview and clear semantics; a local reset must not silently reapply the same backend settings on the next launch unless management is explicitly resumed.

## Files and modules

Existing files to change:

- `apps/backend/app/core/cli_config.py`: replace toggle parsing with the validated settings contract.
- `apps/backend/app/routers/cli_config.py`: versioned projection preserving unset fields.
- `apps/backend/config_template.json` and `apps/backend/README.md`: new operator contract and removal rules.
- `apps/cli/src/cli/client-config.ts`: independent Pi-section validation and version gating.
- `apps/cli/src/harnesses/pi/settings-defaults.ts`: thin transaction/reconciler integration.
- `apps/cli/src/harnesses/pi/setup/packages/settings.ts` and `sync.ts`: Pi-native locked reads and final narrow reconciliation.
- `apps/cli/src/harnesses/pi/adapter.ts`: preserve optional-default and account-verification behavior.
- `apps/cli/src/product/paths.ts`: provenance/journal paths.
- `apps/cli/scripts/check-pi-version.ts` and package scripts: contract synchronization checks.

Proposed new modules:

- `contracts/pi-settings/`: canonical schema, field strategies, fixtures.
- A backend schema-validation wrapper and generated CLI standalone-validator/type modules.
- `apps/cli/src/harnesses/pi/settings/transaction.ts`.
- `apps/cli/src/harnesses/pi/settings/reconcile.ts`.
- `apps/cli/src/harnesses/pi/settings/state.ts`.
- `apps/cli/src/harnesses/pi/settings/recovery.ts`.

## Implementation sequence and acceptance gates

### Phase A — close the existing lock gap

Implement the native settings transaction primitive and route current codemode/package writes through it. Keep the old wire shape temporarily within this implementation phase so locking can be tested independently, not as a permanent compatibility promise.

**Gate:** deterministic regression test for the reproduced lost update; cross-process contention with Pi's real lock; no deadlock during actual package subprocesses; existing targeted suites pass.

### Phase B — define and generate the settings contract

Create the reviewed field inventory, schema/strategy metadata, generator, cross-language fixtures, version checks, template, and new API shape. Add independent section parsing.

**Gate:** backend and CLI agree on every shared fixture; generated artifacts are reproducible; unknown keys, nulls, coercions, prototype-sensitive keys, bounds, and version mismatches fail safely. Invalid Pi settings do not erase valid unrelated config sections.

### Phase C — build the pure reconciler and provenance model

Implement nested paths, baseline-derived tool/list behavior, array ownership, local adoption, path removal, and parent pruning. Exercise it without filesystem/network work first.

**Gate:** idempotency; unrelated settings preserved; reset restores exact baseline; local edits and deletions survive; model IDs containing slashes work; empty tool selections resolve correctly in the pinned Pi runtime.

### Phase D — journaled integration and recovery

Add durable state/journal writes, recovery, adapter wiring, package coexistence, and doctor diagnostics. Never reset on config failure or omission/null PI.

**Gate:** kill/fail at every journal/settings/state boundary and recover conservatively; corrupt/symlinked state does not overwrite settings; two launches serialize; account-switch, offline/admin, fetch-timeout, and lock-timeout behavior remains correct.

### Phase E — documented activation

Replace the template's codemode toggle with `SETTINGS.defaultTools: ["+codemode"]`; deploy the updated CLI/backend contract together. Test packaged/compiled launcher behavior and dependency bundling on supported platforms. Document that existing legacy values lack pre-change provenance.

**Gate:** full CLI/backend suites and type/build checks pass; compiled-binary smoke tests preserve user settings; standalone Pi remains untouched; operator removal and local-override semantics are documented and verified.

## Required regression matrix

- Missing file, `{}`, existing scalar settings, partial nested settings, unknown local fields, BOM.
- DefaultTools absent/empty/replacement/modifier/mixed selections, redundant modifiers, backend enable/disable edits, and project/CLI precedence.
- Replacement arrays, duplicate/order-sensitive entries, local additions/removals/reordering, and whole-field adoption.
- Remote path removal, empty SETTINGS, null/omitted PI, repeated removal, restoration of absent/present baselines, and manager-created empty parents.
- Local value modification/deletion, sticky adoption across backend revisions, and explicit re-enrollment.
- Native Pi lock busy/stale/compromised, simultaneous Pi and Axon writers, concurrent package actions, lock release after exceptions, and identical-run no-op writes.
- Invalid managed payloads versus unsafe/corrupt local settings/state; section-isolated response handling; payload limits and runtime-version override.
- Crash recovery before/after every durable commit boundary, subsequent local edits, ambiguous journals, and state-version mismatch.
- Existing auth-rotation/account-switch safeguards and offline/admin/unauthenticated behavior.

## Definition of done

A reviewed Pi setting can be added by updating one canonical contract/strategy definition, regenerating validators, and adding shared fixtures/runtime tests—not by writing another special uppercase-to-camelCase mapping. Online launches safely reconcile only owned defaults; removal restores only proven-owned values; Pi and package writes share the native lock; failures and ambiguous recovery preserve local settings and do not block launch merely because optional defaults could not apply.
