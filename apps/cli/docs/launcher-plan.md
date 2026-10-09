# Axon Harness Launcher Plan

## Implementation status — 2026-09-04

**Current milestone: launcher Phase 1 and initial Pi environment isolation complete; Phase 0 evidence and later adapter phases remain outstanding.**

### Completed foundation and launcher core

- [x] Established the Bun 1.4.1 and strict TypeScript project configuration.
- [x] Added Biome formatting/linting and a single `bun run check` quality gate.
- [x] Moved the executable entrypoint to `src/index.ts` with top-level await and Commander-owned launcher commands.
- [x] Added product identity, validated service-origin, managed-path, launcher exit-status, adapter-contract, environment-registry, and harness-registry modules.
- [x] Registered the `pi` harness and its executable override metadata.
- [x] Dispatches harness IDs before Commander and preserves every subsequent argument token.
- [x] Resolves validated overrides/PATH candidates and launches allowlisted executables directly with inherited cwd and stdio.
- [x] Strips Axon control variables, emits only redacted opt-in debug previews, and propagates child exit/signal status.
- [x] Added an isolated Pi setup-check pipeline with append-only, disabled-by-default organization MCP synchronization.
- [x] Added dedicated Pi agent/session paths and ordered environment overrides, including disabled Pi version checks and removal of Pi-documented provider API keys.
- [x] Added content-addressed Pi resource materialization, an independently typechecked core extension, and explicit resource arguments.
- [x] Added embedded required-package policy with exact/minimum/floating versions, locked reconciliation, and last-known-good fallback.
- [x] Added `harnesses`, `paths`, package-aware `doctor`, explicit Pi setup, and guarded `uninstall` commands.
- [x] Added launcher-core tests for registry behavior, environment stripping, argv passthrough, child exits, and reserved pre-launch statuses.
- [x] Added a native `darwin-arm64` development compile using ESM bytecode, external source maps, and disabled compiled dotenv/bunfig autoload.
- [x] Added Apple Silicon CI for frozen install, quality checks, launcher tests, compilation, and compiled smoke execution.

### Deliberately deferred

- [ ] All Phase 0 compatibility, auth, resource-loader, provisioning, and native-dependency evidence spikes.
- [ ] Complete Phase 0.5 golden argv coverage, PTY signal tests, and mechanical import-boundary enforcement.
- [x] Pi executable compatibility gate with cached version probing and a pinned, lock-protected managed Pi installation from Pi's release API.
- [ ] Remaining Phase 2 Pi auth behavior and runtime state writers.
- [ ] Installer, release, updater, rollback, interactive auth setup, and runtime garbage collection.

The Pi adapter preserves forwarded argument tokens. Pi has an additive MCP bootstrap check, dedicated `~/.axon/pi` agent/session paths, explicit Axon resource injection, and required-package reconciliation; auth onboarding remains for its dedicated phase.

---

## 1. Goal

Build a native CLI launcher named **`axon`** that starts Pi with Axon-managed configuration, environment variables, extensions, skills, prompts, and themes.

The core user experience is `axon pi`; Pi is the only supported harness.

Everything after the harness token is forwarded to that harness. The launcher owns preparation and process execution; the selected harness owns its UI, command behavior, sessions, and termination status.

```text
axon pi --model openai/gpt-4o "Review this repository"
axon pi -p -- "- Summarize these points"
```

---

## 2. Shared contracts with the shipping plan

This document and `shipplan.md` must use one set of product-level contracts. If either contract changes, update both documents in the same change.

### Product identity

| Contract | Value |
|---|---|
| Stable application ID | `axon` |
| Current command | `axon` |
| Display name | `Axon` |
| Home override | `AXON_HOME` |
| Default home | `~/.axon` |
| Pi agent directory | `${AXON_HOME}/pi` (default `~/.axon/pi`) |
| Pi session directory | `${AXON_HOME}/pi/sessions` (default `~/.axon/pi/sessions`) |
| Debug switch | `AXON_DEBUG=1` |
| Build service origin | validated `AXON_SERVICE_ORIGIN` compiled as `BUILD_SERVICE_ORIGIN` |
| Binary override for Pi | `AXON_PI_BIN` |

Pi uses one fixed Axon-owned data directory rather than a named profile.

### State ownership

Never let unrelated components atomically rewrite the same JSON object.

| File | Sole writer |
|---|---|
| `state.json` | launcher/runtime state |
| `update.json` | manifest cache, ETags, sequence, update checks |
| `hold.json` | rollback/update hold lifecycle |
| `staged/meta.json` | updater staging worker |

### Environment registry

All Axon-owned variables are declared in one module. Harness children use an explicit Axon-variable allowlist; by default strip every `AXON_*` control variable, including:

- `AXON_SWAPPED`
- `AXON_INTERNAL_NO_UPDATE`
- `AXON_PIN`
- `AXON_DEBUG`
- `AXON_NO_UPDATE`
- `AXON_ALLOW_CI_UPDATE`

Pass a Axon-owned variable into a harness only when the registry documents it as harness-facing. Document every variable's owner, consumers, whether it may reach a harness, and whether it is safe to print.

`AXON_SERVICE_ORIGIN` is build/development configuration, not a harness-facing variable. Local tooling reads it from the ignored `.env`; staging and production builds receive it from their GitHub Actions environment and compile it as `BUILD_SERVICE_ORIGIN`. Released binaries do not autoload `.env` or allow ambient project configuration to redirect service traffic.

The installer, signed distribution manifest, post-auth client config, and Pi MCP catalog use fixed paths under that one origin:

```text
${BUILD_SERVICE_ORIGIN}/install.sh
${BUILD_SERVICE_ORIGIN}/stable.json
${BUILD_SERVICE_ORIGIN}/api/v1/cli/config
${BUILD_SERVICE_ORIGIN}/v1/cli/pi/mcp.json
```

### Exit codes

No launcher- or updater-owned failure uses a code below 64. Child exit codes are passed through verbatim and may coincidentally equal a reserved launcher code; the range identifies failures only when no harness was successfully started.

| Code | Meaning before harness start |
|---|---|
| `120` | launcher usage or unknown harness |
| `121` | harness executable unavailable |
| `122` | resource materialization failure |
| `123` | harness preparation/provisioning failure |
| `124` | required update or updater failure |
| `125` | unsupported platform/environment |

### Startup network contract

The shared startup path performs a local first-run session check before normal Pi/setup/doctor/paths/harnesses commands. Missing-session interactive online runs complete browser onboarding before command work; scripted/CI/offline missing-session runs fail with guidance. Help/auth/update/uninstall and Pi administration are exempt. Interactive online Pi also consumes optional telemetry config with a 700 ms deadline; config failure never blocks launch. The updater rules below remain a proposal; see [shipplan.md](shipplan.md) for current release behavior.

- Read and enforce the cached signed manifest first.
- Refresh after the command in a detached worker.
- A bounded foreground refresh is allowed only when the cache is older than the configured TTL (initially six hours), the invocation is interactive, and stdin/stdout are TTYs.
- Print/piped/non-TTY invocations never pay foreground network latency.
- A newly banned version can receive one final run before a refreshed manifest reaches the cache. This is an explicit availability/latency trade-off.
- Mandatory updates may block and re-exec; ordinary updates stage in the background and swap after a later command exits.
- Protected client configuration is consumed only by interactive online Pi for telemetry; it is not required for launch, update, or recovery.
- The Pi-only MCP bootstrap is a narrow exception: it performs a best-effort request capped at 700 ms, writes only missing server names with `disabled: true`, and never blocks Pi after a setup failure. It does not consume post-auth client configuration or updater state.

---

## 3. Current harness capabilities and required spikes

This plan began from a locally inspected Pi `0.84.4` interface.

Treat those observations as evidence, not permanent API contracts.

### Pi

Pi exposes repeatable resource flags suitable for per-invocation activation:

- `--extension <path>`
- `--skill <path>`
- `--prompt-template <path>`
- `--theme <path>`
- `--append-system-prompt <text-or-path>`
- `--session-dir <path>`

It also exposes `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`. Every `axon pi` invocation, including Pi package commands, overrides inherited values with `${AXON_HOME}/pi` and `${AXON_HOME}/pi/sessions`. Axon should use explicit flags for Axon-owned resources and must not mutate the user's normal `~/.pi/agent` settings.

### Blocking unknowns

Do not implement an assumption until the spike records a command, version, observed paths, and expected behavior for it:

1. Where Pi stores auth and whether it can be imported separately from settings and sessions.
2. Whether Pi loads materialized TypeScript source from the installed compiled-binary layout.
3. Whether every native dependency, if introduced, embeds and executes in a compiled Bun binary.
4. Whether `--compile --bytecode --format=esm` builds and runs the real entrypoint with top-level await.
5. Whether file-type imported assets can be read from Bun's virtual filesystem and materialized byte-for-byte.

---

## 4. Command and argument-boundary contract

### Harness launches

```text
axon pi [pi arguments...]
```

Rules:

1. `axon --help` and `axon --version` belong to Axon.
2. `axon pi --help` launches `pi --help`.
3. Every token after the harness token is preserved exactly, including order, empty strings, newlines, leading dashes, and a literal `--`.
4. Harness options are never declared as Commander options.
5. Unknown first positional tokens are launcher errors; arbitrary executable passthrough is forbidden.

### Dispatch before Commander

Commander must never see harness arguments. The MVP command shape requires the harness or launcher command to be the first token, so dispatch can be exact and simple:

```ts
const [head, ...rest] = process.argv.slice(2);
const harness = registry.resolve(head);

if (harness) {
  return launchHarness(harness, rest); // `rest` is never parsed by Commander
}

return runLauncherCommand(process.argv.slice(2));
```

If global launcher options before a harness are added later, implement a dedicated boundary parser with an explicit option-arity table. Do not scan past unknown flag values looking for a harness token.

### Launcher-owned commands

```text
axon harnesses
axon doctor [harness]
axon paths
axon setup <harness> [--import-auth]
axon gc
axon rollback
axon uninstall
```

`doctor`, `paths`, `harnesses`, `rollback`, `uninstall`, `--help`, and `--version` remain available when a required-update gate blocks harness execution. Recovery and diagnostics must work offline.

### Adapter injection policy

Argument insertion is adapter-owned, not universally “before user args.”

- Pi resource flags precede exact user arguments where Pi's repeatable/last-value behavior is verified.
- Collision behavior must be explicit: append both, skip Axon's value, or reject. Never rely on accidental parser precedence.

Golden tests are the executable specification of these rules.

---

## 5. Architecture and source structure

Use four layers:

1. **CLI** — dispatches launcher-owned commands and selects a harness before Commander parsing.
2. **Launcher** — materializes resources and executes a prepared launch specification.
3. **Registry** — maps the Pi harness ID to its adapter.
4. **Adapter** — owns Pi arguments, environment, mutable data directory, resources, compatibility, and diagnostics.

The shared contract stays small:

```text
HarnessAdapter.prepare(context)
HarnessAdapter.buildLaunchSpec(context, userArgs)
HarnessAdapter.doctor(context)

LaunchSpec = executable + arguments + environment + cwd
```

Prefer functions and composition over inheritance. Duplicate code until its semantics are proven identical.

### MVP source tree

Start each adapter with about five implementation files. Split a file when it gains a real second responsibility or grows beyond roughly 200 lines; do not pre-create empty abstractions.

```text
src/
├── index.ts
├── build-info.ts
├── product/
│   ├── identity.ts
│   └── paths.ts
├── cli/
│   ├── dispatch.ts
│   ├── launcher-program.ts
│   └── commands/
│       ├── doctor.ts
│       ├── harnesses.ts
│       ├── paths.ts
│       ├── setup.ts
│       ├── gc.ts
│       └── uninstall.ts
├── launcher/
│   ├── contracts.ts
│   ├── materialization.ts
│   ├── environment.ts
│   ├── executable.ts
│   ├── exit-status.ts
│   └── spawn-harness.ts
└── harnesses/
    ├── registry.ts
    └── pi/
        ├── adapter.ts
        ├── environment.ts
        ├── installation.ts
        ├── setup/
        │   ├── index.ts
        │   ├── mcp-catalog.ts
        │   ├── packages/
        │   └── resources.ts
        └── resources/
            └── extensions/<resource-id>/...
```

Resource categories keep their depth because each resource earns an identity, manifest, source files, and compatibility metadata.

### Mechanical isolation

CI enforces these import rules:

- A harness may import shared contracts/primitives, product identity, and its own descendants.
- A harness may not import another harness.
- `src/cli/**` and `src/launcher/**` may not import a concrete harness except through `src/harnesses/registry.ts`.
- Resource modules may not cross harness roots.

Use an architecture test or a dependency graph tool. If dependency-cruiser is selected, generate explicit rules per adapter; do not rely on a capture group from one regex being interpolated into another rule, because that is not a valid cross-field backreference contract.

---

## 6. Runtime layout and ownership

```text
~/.axon/
├── bin/
│   ├── axon
│   └── axon.prev
├── runtime/
│   ├── current -> 1.4.2-a3f9c1
│   └── 1.4.2-a3f9c1/
│       ├── materialization.json
│       └── pi/...
├── pi/                              # PI_CODING_AGENT_DIR
│   ├── settings.json
│   ├── auth.json
│   ├── npm/
│   ├── git/
│   ├── tmp/
│   └── sessions/                    # PI_CODING_AGENT_SESSION_DIR
├── staged/
│   ├── axon
│   └── meta.json
├── locks/
├── state.json
├── update.json
└── hold.json
```

The runtime key is `<version>-<short-asset-manifest-hash>`, not version alone. This makes repeated `0.1.0-dev` builds and republished development builds rematerialize when resource bytes change.

Materialization creates the immutable versioned directory, then atomically replaces a temporary `runtime/current` symlink. Pi arguments use the immutable versioned path so a running process cannot change resources underneath it; `runtime/current` is for inspection only.

Keep old versioned directories because a running harness can still have one open. Runtime collection is explicit (`axon gc`), age-based (default retention: 30 days), and never runs on the launch path. It must not delete the current target or a directory known to be active.

The home directory is created with mode `0700`. On POSIX, refuse updater/materialization writes if the root is owned by another UID or is group/world writable; `doctor` reports exact remediation.

---

## 7. Resource packaging and materialization

Every resource manifest declares:

- stable ID and harness-specific type
- embedded source paths
- destination relative to its harness runtime root
- enabled state and compatibility range
- content checksum

Reject absolute destinations, empty path components, symlink traversal, and `..` before writing.

### TypeScript source assets

A Pi extension is source for Pi, not launcher code. Import it as an embedded file so Bun does not bundle it into the launcher's module graph:

```ts
import extensionPath from "./extension.ts" with { type: "file" };

const extensionBytes = await Bun.file(extensionPath).arrayBuffer();
```

The import value is a Bun virtual-filesystem path, not source text. The materializer reads the bytes and writes them to `runtime/<version>-<hash>/...`.

Because file-loader imports do not typecheck the extension as part of the launcher graph, maintain a second TypeScript project for `src/harnesses/*/resources/**`. CI typechecks it against the supported harness extension/plugin types.

### Atomic lifecycle

1. Hash the generated asset manifest and derive the runtime key.
2. Fast-path a valid content-keyed stamp.
3. Acquire the materialization lock only when work is needed.
4. Re-check after locking.
5. Write to a sibling temporary directory.
6. Verify every destination, size, mode, and checksum.
7. Rename the completed directory into place.
8. Atomically replace `runtime/current` with a temporary symlink rename.
9. Write final metadata last and release the lock.

A warm launch performs local stamp/path checks only and writes nothing.

---

## 8. Pi adapter, packages, and auth onboarding

Pi does not expose named profiles. Axon will create one fixed, mutable Pi data directory and override these values for every `axon pi` invocation:

```text
PI_CODING_AGENT_DIR=${AXON_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${AXON_HOME}/pi/sessions
```

The defaults are `~/.axon/pi` and `~/.axon/pi/sessions`. Both variables also apply when the forwarded Pi command is `install`, `remove`, `update`, `list`, or `config`, so package lifecycle operations target Axon's Pi directory rather than `~/.pi/agent`.

Axon-owned resources are content-addressed under `runtime/<version>-<hash>` and activated through explicit Pi flags using immutable versioned paths. Required community packages are declared in the embedded manifest and reconciled only inside the dedicated Pi directory. Exact versions change with the embedded manifest; minimum versions enforce a hard floor; floating versions remain under Pi/user update control. Healthy warm launches run local checks only, and unrelated package settings are preserved. See `plans/pi-package-provisioning.md` for the complete policy.

Directory isolation hides the user's normal Pi settings, auth, installed packages, temporary package cache, and sessions. It is not a security sandbox: project resources, other inherited credentials, and user-global paths may still be visible. The adapter sets `PI_SKIP_VERSION_CHECK=1` and removes every Pi-documented provider API key (listed in `PI_STRIPPED_PROVIDER_VARIABLES`), while retaining the organization LiteLLM variables. The Pi MCP adapter reads the standard user-global `~/.config/mcp/mcp.json` independently of `PI_CODING_AGENT_DIR`.

### Organization MCP bootstrap

Before Pi starts, its isolated setup pipeline fetches `${BUILD_SERVICE_ORIGIN}/v1/cli/pi/mcp.json` and reconciles only the response's `mcpServers` map into `~/.config/mcp/mcp.json`. A missing file is created with mode `0600`. Every organization entry is forced to `disabled: true` when first added.

Reconciliation is append-only by server name. Existing definitions and user enablement choices win, personal and organization-removed servers remain untouched, and an invalid or non-regular local file is never replaced. Remote top-level settings are ignored. Network and filesystem failures are best-effort, produce debug-only diagnostics, and never prevent Pi from starting; an unavailable first request creates an empty safe scaffold so a later launch can retry.

### Auth decision

Ship explicit, consented first-run import:

- On an interactive first launch, if managed auth is absent and a supported source auth file exists, explain the boundary and offer to copy only the auth material.
- On print/piped/non-TTY launches, never prompt. Fail with an actionable instruction: `axon setup pi --import-auth`.
- Copy rather than symlink so an atomic rewrite by the harness cannot replace the link unexpectedly.
- Preserve restrictive permissions (`0600` for credential files), never overwrite newer managed credentials, record import provenance without secret values, and validate the exact format/version before copying.
- `doctor pi` reports whether the dedicated Pi directory has usable credentials without printing providers, tokens, or file contents.
- Users may instead run the harness's login flow inside the dedicated Pi directory.

The Phase 0 spike must identify exact source/destination paths and confirm whether auth can be separated from non-auth settings. Environment credentials are never copied; ambient personal provider keys are unavailable to Pi, while organization LiteLLM variables remain available.

---

## 9. Environment policy

Build child environments in deterministic layers:

1. inherited process environment
2. removal of Axon control variables not explicitly allowlisted for harnesses
3. Axon public/shared variables that are explicitly harness-facing
4. Pi data-directory variables
5. other harness-specific variables
6. invocation-specific overrides, if introduced later

Later layers win.

### Composable environment overrides

Environment override support is implemented as a shared launcher primitive rather than assigning individual variables ad hoc in each adapter. Its API shape is:

```ts
type EnvironmentOverrides = Readonly<Record<string, string | undefined>>;

function createHarnessEnvironment(
  inherited: NodeJS.ProcessEnv,
  ...overrides: readonly EnvironmentOverrides[]
): NodeJS.ProcessEnv;
```

The helper first copies and sanitizes the inherited environment using the Axon registry, then applies each override object in order. A string sets or replaces a value, `undefined` explicitly removes a value, and a later override wins. It always returns a fresh object and never mutates `process.env` or an earlier layer.

Each adapter owns small, named override builders for its semantics and composes them at the launch boundary. For example, the Pi adapter includes this directory layer:

```ts
function createPiDirectoryOverrides(paths: AxonPaths): EnvironmentOverrides {
  return {
    PI_CODING_AGENT_DIR: paths.pi,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
  };
}
```

Future Pi features can add independent layers for package setup, invocation policy, or other Pi variables without rewriting sanitization or copying the full inherited environment. Tests cover precedence, explicit removal, adapter-specific credential policy, Axon-variable stripping, and input immutability. Foreign harness variables such as `PI_*`, `XDG_*`, or provider keys do not belong in the `AXON_ENVIRONMENT_REGISTRY`; that registry remains limited to Axon-owned controls.

Rules:

- Pi sets `PI_SKIP_VERSION_CHECK=1` and removes inherited Pi-documented provider API keys while retaining organization LiteLLM variables; persist auth only through the explicit import/login policy.
- Never print the complete child environment.
- Redact names containing `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL`, or `AUTH`.
- Redacted debug launch previews go to stderr only when `AXON_DEBUG=1`.
- Do not delete unrelated inherited variables unless an adapter documents the reason and tests it.
- Do not expose arbitrary environment-setting CLI flags in the MVP.
- Disable compiled-executable `.env`/`bunfig.toml` autoload; `.env` is consumed by local build/development tooling, not by a released launcher running inside an arbitrary project.

### Post-auth client configuration

There is no persistent post-auth application phase. The implemented [client configuration](plans/cli-client-config.md) uses authenticated `GET /api/v1/cli/config` only for interactive online Pi telemetry. Browser login stays separate; normal commands run first-time onboarding only when no saved session exists.

The optional config request has a 700 ms deadline and 16 KiB response limit, ignores unknown fields, refuses redirects, and has no disk cache. Valid remote telemetry settings override environment exporter/sampler/interval settings, except local disable and offline mode. Clear conflicting per-signal destinations and inherited collector headers/TLS identity overrides before configuring a remote sink. Config failure falls back without blocking launch.

Release policy, service origin, Pi/package pins, and managed provider endpoints are not remotely configurable. Never pass an arbitrary settings/environment map to Pi. Installer/update/recovery remain independent of client config. Account display and other consumers are deferred.

---

## 10. Process execution and termination

Execute allowlisted harnesses directly with a command array. Never use `Bun.$`, `sh -c`, or a shell string.

- preserve cwd
- inherit stdin/stdout/stderr
- wait for the child
- propagate normal exit codes verbatim
- re-raise child signals in the wrapper
- do not capture interactive output

Use one shared `exitLikeChild` implementation for harness execution and mandatory-update re-exec:

```ts
export function exitLikeChild(result: {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}): never {
  if (result.signalCode) {
    process.removeAllListeners(result.signalCode);
    process.kill(process.pid, result.signalCode);
    process.exit(128 + (SIGNAL_NUMBERS[result.signalCode] ?? 0));
  }

  process.exit(result.exitCode ?? 1);
}
```

The signal fallback is `1`/`128 + signal`, never success.

With inherited stdio and parent/child in the same foreground process group, the terminal already sends `SIGINT` to both. Do not forward it a second time. Keep the parent alive long enough for the harness to restore terminal state, and forward only signals such as `SIGTERM`/`SIGHUP` that the parent receives alone. PTY tests, not assumptions, define the final listener behavior for the pinned Bun/macOS build.

---

## 11. Registry, executable resolution, and version cache

| Stable ID | Candidate name | Override |
|---|---|---|
| `pi` | `pi` | `AXON_PI_BIN` |

An override is still validated as an executable path and never evaluated through a shell.

Do not spawn `--version` on every launch. Cache compatibility results in launcher state keyed by `(resolvedPath, mtimeMs, size)`. A harness upgrade invalidates the entry naturally. `doctor` may force a fresh probe.

Adding a harness requires its directory and one registry entry; it must not modify existing adapters.

---

## 12. Startup lifecycle

For a harness launch:

1. Apply the cached updater gate; allow recovery commands regardless of the gate.
2. Optionally perform the bounded stale-cache refresh only under the startup network contract.
3. Dispatch the first token before Commander and preserve the remaining vector untouched.
4. Resolve the registry entry and lazy-load only that adapter.
5. Build context and strip internal environment variables.
6. Resolve the executable using override/candidates.
7. Verify/materialize the content-addressed runtime.
8. Prepare/auth-check the Pi data directory.
9. Build the adapter-owned final launch spec.
10. Emit a redacted stderr preview only under `AXON_DEBUG=1`.
11. Spawn with inherited stdio and wait.
12. If an older verified update was staged before this invocation, swap it after the harness exits.
13. Start detached manifest refresh/staging when eligible.
14. Exit exactly like the harness.

Optional updates never add a re-exec hop around the harness. Mandatory foreground updates may re-exec because the gate must converge before launching. Fetching post-auth client configuration belongs to the later application lifecycle and is deliberately absent from this launch sequence.

---

## 13. Diagnostics, uninstall, and unsupported environments

`doctor` reports:

- executable path, override/candidates, version, and compatibility status
- version-cache key
- dedicated Pi directory and active runtime paths
- effective Pi agent/session directory environment values
- auth readiness without secrets
- resource/provisioning status
- Axon home permissions/ownership
- whether `~/.axon/bin` is on PATH
- whether `command -v axon` resolves to the managed binary rather than a shadowing package-manager copy
- platform/container status and remediation

`uninstall` removes the managed binary and can optionally remove cached runtimes. It always preserves Pi settings, auth, and sessions; it never silently destroys user data.

Both installer and CLI detect unsupported OS/architecture/container execution. The native macOS arm64 MVP may refuse containers; the message must acknowledge devcontainers as unsupported and tell users where to run the native launcher. Expect support demand and revisit this decision with usage evidence.

---

## 14. Security boundaries

- Harness IDs and executable candidates are compiled allowlists.
- No harness launch uses a shell.
- Manifest destinations reject traversal and absolute paths.
- Materialized bytes are checksum-verified.
- Runtime directories are immutable and separate from the mutable Pi directory.
- External plugins are pinned to versions or immutable revisions.
- Auth import requires consent, validates format, and preserves restrictive modes.
- `~/.axon` is same-user private; the local threat model trusts same-UID processes, as other user-space toolchain managers do.
- Staged binaries are re-hashed immediately before swap; a signed remote manifest does not protect a user-writable staging window by itself.
- Harness plugins/extensions execute with user permissions and are trusted release inputs.

---

## 15. Test strategy

### Fake harness

Create a tiny hermetic fixture that emits JSON for argv, cwd, selected env, and TTY state, and can exit with a requested code or signal. Point the Pi adapter at it through `AXON_PI_BIN`. CI must not require Pi for core launcher tests.

### Golden argument table

Store `(harness, userArgs) -> expected executable argv` cases for:

- harness `--help`
- bare `--`
- prompts with spaces/newlines/leading dashes
- Pi `-p -- ...`
- user-supplied resource options

### PTY and signal tests

Spawn the real compiled launcher against the fake harness under a PTY and assert:

- stdin/stdout are TTYs
- exit `42` remains `42`
- Ctrl+C preserves terminal behavior and signal status
- SIGTERM/SIGSEGV are not converted to exit `0`
- no signal is delivered twice
- print/piped invocations perform no foreground manifest request

Use Bun's PTY support or a pinned PTY test dependency only after the Phase 0.5 spike proves reliability on the supported runner.

### Materialization/data-directory tests

Use temporary `AXON_HOME` roots to verify the exact Pi agent/session paths, environment overrides on all forwarded Pi commands, separation from `~/.pi/agent`, traversal rejection, concurrent first launches, content-hash invalidation for `0.1.0-dev`, atomic `current` replacement, interrupted writes, auth import permissions, and explicit age-based GC.

### Architecture tests

Fail CI on cross-harness imports and on launcher/CLI imports that bypass the registry.

---

## 16. Implementation order

### Phase 0 — blocking compatibility/build spikes

1. Decide and prove exact Pi auth import/login behavior.
2. Verify Pi source assets materialize and load from a compiled installation.
3. Compile and run top-level await with `--compile --bytecode --format=esm`.
4. Verify file-loader asset paths and the separate resource typecheck project.
5. Verify native dependencies, if any, in the compiled target.
6. Record supported Pi versions and evidence.

### Phase 0.5 — executable contracts

1. Add the fake harness.
2. Add golden argv cases.
3. Add shared `exitLikeChild` and signal tests.
4. Add mechanical import-boundary enforcement.
5. Lock the exit-code and environment registries.

Complete this before Phase 1; it de-risks the exact passthrough claim.

### Phase 1 — launcher core

1. Add product identity and shared paths/state ownership.
2. Dispatch harnesses before Commander.
3. Add the Pi registry entry, override, and small adapter contract.
4. Implement direct inherited-stdio spawning and signal-correct termination.
5. Add `harnesses`, `paths`, basic `doctor`, `uninstall`, and debug preview.

### Phase 2 — Pi

1. [x] Add `${AXON_HOME}/pi` and `${AXON_HOME}/pi/sessions` path contracts through `AxonPaths.pi` and `AxonPaths.piSessions`.
2. [x] Extend the shared environment builder with ordered override layers, then use Pi-owned layers to override both directory variables and remove explicitly disallowed inherited credentials.
3. [x] Add content-addressed materialization and stable `runtime/current` paths.
4. [x] Add one real Pi extension plus its independent typecheck.
5. [x] Add explicit resource arguments.
6. [x] Add embedded required-package policy and explicit package setup/doctor checks.
7. [ ] Add consented auth import/setup and doctor checks.
8. [ ] Complete interactive, print, piped, session, help, `--`, exit, and signal validation.

### Phase 3 — packaging/release integration

1. Generate and embed the resource manifest.
2. Build with explicit ESM bytecode format and external source maps.
3. Compress release artifacts and publish maps separately.
4. Run compiled fake-harness and PTY smoke tests on native arm64 macOS.
5. Launch a locally installed Pi executable from a path containing spaces.
6. Integrate the updater from `shipplan.md`.

Delay optional background auto-staging until Pi provisioning is stable.

### Phase 4 — later

- user-selectable resources
- expanded platform/container support
- post-auth user-facing client configuration
- telemetry controls

---

## 17. MVP acceptance criteria

- Pi launches through the stable `pi` registry ID.
- Harness argv is preserved byte-for-byte at the token level, including `--`, whitespace, and newlines.
- Commander cannot consume harness `--help`/`--version`.
- Every `axon pi` invocation uses `${AXON_HOME}/pi` for `PI_CODING_AGENT_DIR` and `${AXON_HOME}/pi/sessions` for `PI_CODING_AGENT_SESSION_DIR` without modifying `~/.pi/agent`.
- Pi has an explicit first-run auth path for users with on-disk credentials.
- Warm print/piped launches perform no network request.
- Post-auth client config may be user-specific but is never required for startup, updates, recovery, or reaching that phase.
- Runtime materialization is content-addressed, checksum-verified, atomic, and invisible on warm launches.
- Pi receives immutable versioned runtime paths; GC never runs during launch.
- Exit codes and child signal deaths are preserved, including Ctrl+C under a PTY.
- Internal Axon variables do not leak into harness subprocess trees.
- Ordered environment overlays preserve inherited credentials, override harness values deterministically, support explicit removal, and never mutate `process.env`.
- Home ownership/modes and staged-binary hashes are verified.
- CI enforces adapter import isolation.

---

## 18. Decisions to keep explicit

1. Axon is a launcher, not a replacement harness.
2. The only supported harness ID is `pi`.
3. Pi resources remain separate from launcher code.
4. Adapter files start shallow; resource identity earns directory depth.
5. Harness arguments bypass Commander entirely.
6. Process execution is direct and signal-correct.
7. Cached update enforcement is local; ordinary refresh/staging is background work.
8. Pi uses one fixed Axon-owned data directory at `${AXON_HOME}/pi`; it is not modeled as a named profile, and isolation includes an explicit auth and package onboarding contract.
9. Harness environment customization uses one ordered, immutable overlay mechanism; the Pi adapter adds focused layers instead of duplicating environment construction.
10. Runtime identity is based on resource content, and Pi receives an immutable versioned path.
11. Optional updates swap after command exit; mandatory updates alone may re-exec before launch.
12. User-facing post-auth configuration is a separate client lifecycle; launch-critical controls stay in distribution policy or compiled defaults.