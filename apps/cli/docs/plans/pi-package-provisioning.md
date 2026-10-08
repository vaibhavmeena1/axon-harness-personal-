# Pi Resource and Package Provisioning Plan

## Implementation status

**Current state: implementation complete; Pi 1.0 native MCP replaces the retired `pi-mcp-adapter` package.**

Implemented:

- Embedded, schema-validated manifest with typed `pi.install` actions and exact, minimum, and floating policies.
- Required floating entry for `@juicesharp/rpiv-ask-user-question` and an exact `3.0.1` entry for `pi-provider-litellm`. The legacy `pi-mcp-adapter` is retired and removed by package reconciliation when verified as Axon-managed.
- Content-addressed Axon Pi resource materialization with checksum verification, atomic `runtime/current` activation, and a separately typechecked core extension.
- Local settings/package inspection, enforced required entries, package provenance state, same-user locks, direct Pi install/remove subprocesses, exact-version fallback, minimum floors, and Pi/user-owned floating updates.
- Automatic interactive provisioning, local-only non-interactive validation, forwarded Pi administration exemptions, explicit `axon setup pi --sync-packages`, and package-aware doctor output.
- Tests covering schema safety, versions, settings preservation, fallback/revocation, package retirement/adoption, locking/concurrency, subprocess environment, resource activation, and launcher integration.

Key implementation entry points:

- Manifest to edit: `src/product/manifest.ts`
- Manifest schema/normalization: `src/harnesses/pi/setup/packages/manifest.ts`
- Package reconciler: `src/harnesses/pi/setup/packages/sync.ts`
- Resource materializer: `src/harnesses/pi/setup/resources.ts`
- Package tests: `tests/pi-package-setup.test.ts`

Remaining follow-up for the next session:

1. Run `axon setup pi --sync-packages` against the selected real packages.
2. Smoke-test an ordinary interactive Pi session and `axon pi update --extensions` for the floating entries.
3. Before release, confirm licenses/install scripts and test each selected package against the pinned Pi compatibility version.

The first eligible synchronization installs the required entries; healthy warm launches continue to use local package and settings inspection only.

## Context

Axon launches Pi with an isolated `PI_CODING_AGENT_DIR` at `${AXON_HOME}/pi`. It needs to provide two classes of resources without modifying the user's normal `~/.pi/agent` installation:

1. Axon-owned, always-required extensions (including custom TUI behavior), skills, prompt templates, and themes.
2. Reviewed community Pi packages that are required and use one of three policies: an exact version, a minimum acceptable version, or no version constraint so Pi and the user retain control of update timing.

The package lifecycle must preserve unrelated user-installed packages, avoid network work on every warm launch, and treat package installation as privileged code execution. Pi's current `list` command reports configured package sources and paths, not authoritative installed versions, so reconciliation must not parse `pi list` output. The authoritative package manifest is embedded in the Axon CLI; package policy changes therefore ship through a Axon release rather than a remote configuration response.

## Approach

### Resource ownership

- Materialize Axon-owned resources with the CLI under `${AXON_HOME}/runtime/current/pi/` and pass them through explicit Pi resource flags. A TUI is implemented as an extension importing `@earendil-works/pi-tui`; it is not a separate Pi resource type.
- Describe community packages in a validated manifest embedded in the Axon CLI. Only manifest-owned package identities are reconciled; all unrelated Pi settings and user packages are preserved.
- Reconcile direct community package entries independently. A reviewed aggregate package can still appear as one ordinary manifest entry when redistribution and licensing make aggregation desirable, but the reconciler does not require that packaging model.

### Proposed manifest model

The manifest should declare typed Pi package actions, never executable names, shell command strings, or arbitrary argv:

```json
{
  "schemaVersion": 1,
  "revision": "2026-09-04.1",
  "pi": {
    "packages": [
      {
        "id": "required-tools",
        "source": "npm:@example/pi-tools",
        "required": true,
        "versionPolicy": { "kind": "exact", "version": "1.4.2" },
        "install": { "action": "pi.install" }
      },
      {
        "id": "minimum-tools",
        "source": "npm:minimum-package",
        "required": true,
        "versionPolicy": { "kind": "minimum", "version": "2.3.0" },
        "install": { "action": "pi.install" },
        "updates": { "owner": "pi-or-user" }
      },
      {
        "id": "community-floating",
        "source": "npm:community-package",
        "required": true,
        "versionPolicy": { "kind": "floating" },
        "install": { "action": "pi.install" },
        "updates": { "owner": "pi-or-user" }
      }
    ]
  }
}
```

The executor maps `pi.install` to the already-resolved Pi executable plus the fixed `install` subcommand and a target derived from `source` and `versionPolicy`:

- `exact 1.4.2` → `pi install npm:@example/pi-tools@1.4.2`
- `minimum 2.3.0` → `pi install npm:minimum-package@>=2.3.0`
- `floating` → `pi install npm:community-package`

The manifest cannot select another executable or add arbitrary arguments.

Planned validation rules:

- `install.action` is a closed typed union; the manifest schema initially supports only `pi.install`. The reconciler may internally construct the fixed `pi.remove` action for a stale, still-unmodified Axon-owned identity.
- `exact` requires a valid full semantic version and accepts only that installed version.
- `minimum` requires a valid full semantic-version floor, accepts any installed version greater than or equal to it, never downgrades a higher version, and persists a corresponding `>=floor` package source so native Pi/user updates remain possible.
- `floating` omits a version/ref and must declare `updates.owner: "pi-or-user"`. Axon installs and restores it when absent but never chooses when to update it.
- Git packages use exact immutable commits or floating upstream ownership; `minimum` is npm-only because Git refs have no semantic minimum ordering.
- Package names/identities are unique, package operations remain under the isolated Pi directory, and unknown fields are rejected according to the embedded schema version.
- The compiled Axon release is the package-policy trust boundary. No service response may add or replace executable package sources in this phase.

### Reconciliation and updates

- Add a Pi package setup stage beside the existing MCP setup pipeline, but keep required-package failures outside the MCP check's best-effort catch-and-continue behavior. Extend adapter preparation to receive the forwarded Pi arguments so setup can distinguish ordinary sessions from administrative commands.
- On the warm path, read the manifest hash, Axon package state, Pi `settings.json`, and installed package metadata under `${PI_CODING_AGENT_DIR}/npm/node_modules/...`; do not invoke `pi list`.
- Acquire a dedicated package lock, recheck state, then invoke the resolved Pi executable directly with the existing sanitized Pi environment when installation or repair is needed.
- Exact packages update only when a new Axon CLI release changes their exact policy. This requires `pi install npm:pkg@new-version`; Pi intentionally skips exact pins during `pi update --extensions`.
- Minimum packages trigger repair only when missing, invalid, or locally below the embedded floor. Versions at or above the floor are accepted without a registry request and are never downgraded. Their range source remains eligible for native Pi/user updates.
- Floating packages are kept as unversioned sources in Pi settings. Axon accepts any valid installed version and neither checks the registry nor schedules updates. Pi may report available updates, and the user may run `axon pi update --extensions` or another native Pi update command at any time.
- If a user pins, filters, disables, removes, or weakens the source constraint of a required minimum/floating entry, the next eligible reconciliation restores the embedded required entry. If Pi/user updated its installed version while retaining the required source policy, Axon accepts that version and refreshes only its observed local state.
- Verify command exit status, configured source, installed package identity/version, and expected package location before committing state. Write state last.
- On an interactive exact-version migration, preserve and launch the previously verified version if installing the newly embedded version fails. Restore its previous settings source and verify its package files before fallback; never launch an unverified or partially modified install.
- Allow the embedded manifest to revoke versions. A revoked previous exact version is not eligible for fallback. A package that has never installed successfully also cannot satisfy a required-package gate. A version below a `minimum` floor is never an acceptable fallback because the floor is a hard requirement.
- When a new embedded manifest removes a formerly managed identity, remove it only if package state proves Axon installed it and the current settings source/filter plus installed metadata still match the last Axon-managed state. If the user changed the entry, treat it as adopted and preserve it. Removal failure warns but does not block because the package is no longer required.

### Launch policy

- Explicit setup command: `axon setup pi --sync-packages`.
- The first ordinary interactive Pi launch automatically installs missing required packages before Pi starts and displays package identity plus progress. It does not ask for confirmation because these packages are declared product requirements, but installation risk is documented during Axon installation/setup.
- Warm ordinary launches do local checks only.
- Pi administrative forwarding (`help`, `version`, `install`, `remove`, `update`, `list`, and `config`) does not recursively trigger package synchronization; the next ordinary launch repairs required state.
- Non-interactive, print, JSON, RPC, piped, and CI launches never prompt or initiate package network activity. If a required package has no valid installed copy, fail with `axon setup pi --sync-packages` remediation.
- When a newly embedded exact version is not installed during a non-interactive launch, a non-revoked last-known-good version may run with a warning and setup remediation. Otherwise the launch blocks.
- `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_SKIP_VERSION_CHECK=1`, and the Pi-only credential removals apply to package subprocesses as well as the final Pi process.

### Safety and user control

- Document that Pi extensions, skills, dependency install scripts, and update commands can execute arbitrary code.
- Preserve unrelated settings keys and user packages byte-for-byte where possible.
- Required means enforced: the reconciler restores a removed, pinned, filtered, or disabled manifest-owned entry and its required resource enablement while leaving all unrelated package entries untouched.
- Never log complete environments, tokens, package registry credentials, or auth file contents.
- Surface package identity, desired policy, installed version, last check, and remediation through `doctor pi` without secrets.

## Files to modify

Expected implementation paths; final names may be adjusted to existing module boundaries:

- `src/product/paths.ts` — package state/lock paths.
- `src/launcher/contracts.ts` and `src/launcher/launch-harness.ts` — pass forwarded arguments into adapter preparation.
- `src/launcher/file-lock.ts` — new reusable lock primitive because the current tree defines lock paths but has no lock implementation.
- `src/product/manifest.ts` or a generated manifest module — embedded, schema-versioned package and resource policy.
- `src/harnesses/pi/adapter.ts` — compose required resource arguments and the existing Pi environment.
- `src/harnesses/pi/setup/index.ts` — orchestrate package setup separately from best-effort MCP setup.
- `src/harnesses/pi/setup/packages/manifest.ts` — schema validation and normalized package identities.
- `src/harnesses/pi/setup/packages/state.ts` — local reconciliation stamp, verified versions, fallback eligibility, and atomic state writes.
- `src/harnesses/pi/setup/packages/settings.ts` — narrow merge/restore of manifest-owned entries in Pi `settings.json`.
- `src/harnesses/pi/setup/packages/inspect.ts` — settings and installed-version inspection.
- `src/harnesses/pi/setup/packages/sync.ts` — locking, direct Pi subprocess execution, verification, rollback, and failure policy.
- `src/harnesses/pi/setup/packages/invocation.ts` — classify ordinary interactive, non-interactive, and administrative Pi invocations.
- `src/cli/commands/doctor.ts` — local package health reporting.
- `src/cli/launcher-program.ts` — explicit Pi package setup/sync command.
- `tests/launcher.test.ts` — launch/admin-command behavior.
- `tests/pi-package-setup.test.ts` — manifest, version policy, sync, failure, and concurrency tests.
- A dedicated resource tree and TypeScript config under `src/harnesses/pi/resources/` for Axon-owned extensions and TUI code.

## Reuse

- `createHarnessEnvironment()` and `EnvironmentOverrides` in `src/launcher/environment.ts` for sanitized package subprocess environments.
- `HarnessLaunchContext` in `src/launcher/contracts.ts` for the resolved Pi executable, cwd, environment, and paths.
- `preparePiSetup()` in `src/harnesses/pi/setup/index.ts` as the setup orchestration boundary, while separating blocking package checks from best-effort MCP checks.
- The direct `Bun.spawn` patterns in `src/launcher/spawn-harness.ts` and `src/cli/commands/doctor.ts`; `spawnHarness()` itself exits like the child and therefore cannot be reused for an intermediate package command.
- `resolveAxonPaths()` in `src/product/paths.ts` for the isolated Pi root and shared lock root.
- `resolveExecutablePath()` and direct `Bun.spawn` patterns in `src/launcher/` rather than shell execution.
- `BUILD_INFO` and the existing Bun compile-time define pipeline for binding the embedded manifest to a Axon release.
- Existing temporary-home/fake-harness test patterns in `tests/launcher.test.ts` and MCP setup dependency-injection patterns in `tests/pi-mcp-setup.test.ts`.
- The temporary-file, restrictive-mode, re-read, and atomic-rename patterns in `src/harnesses/pi/setup/mcp-config.ts`; extract a shared helper only if package settings/state need identical semantics.

## Steps

- [x] Define the embedded manifest schema with typed `pi.install` actions and exact, minimum, and Pi/user-managed floating policies.
- [x] Encode confirmed launch behavior: visible automatic interactive install, no non-interactive network provisioning, last-known-good exact fallback, and enforced required entries.
- [x] Add Axon-owned Pi resource package/materialization and independent extension typechecking.
- [x] Add manifest schema validation and normalize npm/Git package identities.
- [x] Add package state and dedicated lock paths plus a reusable same-user lock implementation with stale-owner handling and recheck-after-lock semantics.
- [x] Implement local inspection of Pi settings and installed package metadata without parsing CLI output, plus a narrow atomic merge that owns only manifest package identities.
- [x] Implement direct Pi install execution with the existing Pi-only environment, strict typed-action argv construction, inherited progress output, and signal cleanup.
- [x] Verify installed state and commit the reconciliation stamp only after success; restore the prior source/state when a failed exact migration leaves a verified fallback intact.
- [x] Remove identities dropped by a new manifest only when provenance and unchanged current metadata prove they remain Axon-owned; preserve adopted entries and make removal failure non-blocking.
- [x] Add exact-package updates driven by embedded manifest changes, enforce minimum-version floors without downgrading, and ensure minimum/floating packages remain eligible for native Pi/user updates without Axon-driven update checks.
- [x] Integrate package sync into explicit setup and ordinary interactive launches, add local-only validation/fallback for non-interactive launches, and exempt forwarded Pi administration commands.
- [x] Add `doctor pi` diagnostics and redacted debug events.
- [x] Document package security, exact/minimum/floating update ownership, and recovery.

## Verification

- Unit-test schema rejection of arbitrary commands, shell strings, malformed sources, duplicate identities, invalid exact/minimum versions, unsupported Git minimum policies, and mutable pinned Git refs.
- Verify exact packages do not perform network/update work when manifest and installed metadata match.
- Verify a minimum package below the floor is repaired, a version equal to the floor passes, a higher version passes without downgrade or registry access, and a below-floor version cannot be used as fallback.
- Verify Axon never performs registry/version checks for a healthy floating package, accepts versions updated by Pi/user, and restores an unpinned required settings entry if it is removed, pinned, filtered, or disabled.
- Verify missing/mismatched packages invoke the resolved Pi executable with exact argv and the isolated Pi environment.
- Verify interactive first install shows progress; first-install failure blocks with remediation; non-interactive first launch performs no package network command.
- Verify a failed exact migration restores and launches a non-revoked verified prior version, while a revoked or unverified prior version blocks.
- Verify unrelated settings and packages survive install, update, and repair; verify manifest removal deletes an unchanged Axon-owned package but preserves a user-modified/adopted entry.
- Verify concurrent first launches perform one synchronization and all waiters recheck after the lock.
- Verify help/version and forwarded Pi package commands bypass automatic sync.
- Verify interactive, print, JSON/RPC, piped, and CI behavior.
- Run `bun run check`, `bun test`, native build, and compiled fake-Pi smoke tests from paths containing spaces.

## Confirmed decisions

- Manifest commands are constrained typed Pi package actions; arbitrary executable argv is not allowed.
- The authoritative package manifest is embedded in the Axon CLI.
- Exact packages require one version; minimum packages enforce a hard floor while accepting newer versions; floating packages remain unpinned. Update timing for minimum/floating packages belongs to Pi or the user, and Axon does not run automatic update checks for them.
- Manifest-required entries are enforced and restored while unrelated user package configuration remains untouched.
- First ordinary interactive launch installs missing required packages automatically with visible progress.
- A failed exact-version migration uses a verified, non-revoked last-known-good version.
- Non-interactive launches perform no package installation/update network work and fail with explicit setup remediation when no acceptable installed version exists.
- A package removed from the embedded manifest is removed only while its persisted provenance and unchanged metadata show it is still Axon-owned; user-adopted entries are preserved.
