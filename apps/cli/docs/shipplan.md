# DeputyDev Binary Shipping and Update Plan

## Implementation status — 2026-09-04

**Status note:** The sections below describe a future independently signed distribution policy, mandatory-update gates, and rollback command. The currently implemented path is manual S3 publication, backend-configured latest release, verified `install.sh` / explicit `ddcli update`, and a silent throttled post-session background worker. See [the current release procedure](../README.md#releasing).

### Completed foundation

- [x] Pinned Bun 1.4.1 project metadata and synchronized the frozen lockfile.
- [x] Added compile-time build identity fallbacks and validated local/build service-origin handling.
- [x] Added a native `darwin-arm64` development build with `--compile --format=esm --bytecode`, external source maps, and compiled autoload disabled.
- [x] Confirmed the current top-level-await entrypoint compiles and the resulting binary returns `0.1.0-dev` from `--version`.
- [x] Added strict typechecking plus Biome formatting/linting gates.
- [x] Added Apple Silicon CI for frozen dependency install, quality checks, native compilation, and smoke execution.
- [x] Established separate launcher/update/hold/staging path contracts without implementing any state writer.
- [x] Implemented the launcher-core command boundary, executable resolution, direct child spawning, reserved pre-launch statuses, and recovery/diagnostic command surface needed by later updater integration.

### Deliberately deferred

- [ ] Full Phase 0 proof for release flags, external maps, compression/dual hashes, embedded assets, detached workers, signing, and native dependencies.
- [ ] Release-please, release artifact publication, provenance, signing, and notarization workflows.
- [ ] Installer and managed installation verification.
- [ ] Signed manifest schemas, verification, replay/expiry controls, cache, and update locks.
- [ ] Foreground updates, cached gates, detached staging, swap-on-exit, rollback, and hold behavior.
- [ ] Updater, concurrency, tampering, local-server, filesystem, and PTY tests.

The historical checklists below predate the current S3 installer and updater. They track the larger signed-manifest/gate/rollout design, not the implemented manual publishing path.

---

## TL;DR

Ship one signed, compressed native binary for Apple Silicon macOS. Keep ordinary launcher startup local and split update work into four paths:

| Path | When | Blocking? | Behavior |
|---|---|---|---|
| **Cached gate** | Start of an eligible run | Local only | Enforce an already cached `minSupported`; honor a temporary rollback hold. |
| **Bounded refresh** | Only when cache TTL expired and invocation is interactive | Sometimes | Fetch a small signed manifest within a strict budget; print/piped/non-TTY runs skip it. |
| **Refresh + stage** | After the command | No | A detached worker fetches the signed manifest, downloads the compressed artifact, verifies both hashes, self-tests, and stages it. |
| **Optional swap** | After a later command exits | Local only | Re-hash the staged binary and atomically rename it into place. No re-exec. |

A mandatory update is the exception: when the cached or freshly accepted manifest says `current < minSupported`, download/verify/swap in the foreground and re-exec before launching the harness.

This design accepts one explicit trade-off: a newly banned release may receive one final run before a refreshed manifest reaches the local cache. That is preferable to imposing 300–700 ms of network latency on every transparent harness launch, especially `ddcli pi -p` in loops and pipelines.

---

## 1. Shared product contracts

This plan and `launcher-plan.md` share one contract. Update both in the same change when any item moves.

### Identity and platform

| Contract | Value |
|---|---|
| Stable application ID | `deputydev` |
| Current executable | `ddcli` |
| Home override | `DEPUTYDEV_HOME` |
| Default home | `~/.deputydev` |
| Pi agent directory | `${DEPUTYDEV_HOME}/pi` (default `~/.deputydev/pi`) |
| Pi session directory | `${DEPUTYDEV_HOME}/pi/sessions` (default `~/.deputydev/pi/sessions`) |
| Initial binary target | `darwin-arm64` |
| Supported runtime | native Apple Silicon macOS |

Docker/containers, Linux, Intel macOS, and Windows are out of scope for the initial release. Both installer and CLI must detect and clearly reject unsupported environments. Native Windows is not partially supported; its process/job-object and replacement behavior requires a separate plan.

### Environment variables

| Variable | Owner | Meaning |
|---|---|---|
| `DEPUTYDEV_HOME` | public | Relocate all managed files. |
| `DEPUTYDEV_NO_UPDATE=1` | public | Disable optional refresh/staging, not a required-update gate. |
| `DEPUTYDEV_PIN=<semver>` | public | Require the running version to equal the pin; mismatch is an error. |
| `DEPUTYDEV_ALLOW_CI_UPDATE=1` | public | Permit foreground self-update in CI. |
| `DEPUTYDEV_DEBUG=1` | public launcher | Redacted diagnostics to stderr; never pass to harnesses. |
| `DEPUTYDEV_INTERNAL_NO_UPDATE=1` | internal updater | Prevent recursion during worker/self-test. |
| `DEPUTYDEV_SWAPPED=<version>` | internal updater | Mandatory re-exec loop guard. |

Harness children use an explicit DeputyDev-variable allowlist. Strip all updater controls (`DEPUTYDEV_INTERNAL_NO_UPDATE`, `DEPUTYDEV_SWAPPED`, `DEPUTYDEV_NO_UPDATE`, `DEPUTYDEV_PIN`, `DEPUTYDEV_ALLOW_CI_UPDATE`) and `DEPUTYDEV_DEBUG` before launching a harness or anything in its subprocess tree. Pass a `DEPUTYDEV_*` variable through only when the shared registry marks it as harness-facing.

Harness-specific environment values are applied after sanitization through the ordered, reusable overlay mechanism defined in `launcher-plan.md`; adapters must not mutate `process.env` or duplicate environment-copy logic. The Pi adapter uses that mechanism to override `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`, set `PI_SKIP_VERSION_CHECK=1`, and remove every Pi-documented provider API key on every Pi invocation, including forwarded package commands.

DeputyDev-owned Pi resources are embedded, checksum-verified, and activated through `runtime/current`. Required community package policy is embedded in the CLI with typed Pi install actions: exact versions follow DeputyDev releases, minimum versions enforce a floor, and floating versions remain updateable by Pi or the user. Package reconciliation uses local metadata on warm launches, never parses `pi list`, and preserves unrelated package settings. Full behavior is recorded in `plans/pi-package-provisioning.md`.

Parse boolean environment values explicitly:

```ts
const isTrue = (value: string | undefined): boolean =>
  /^(1|true|yes)$/i.test(value ?? "");
```

`CI=false` must not be treated as CI.

### Service origin configuration

Installer, distribution-manifest, and post-auth client-config URLs share one origin. Development and release tooling read it from `DEPUTYDEV_SERVICE_ORIGIN`:

```text
DEPUTYDEV_SERVICE_ORIGIN=http://localhost:3000
```

The repository provides `.env.example` and an ignored `.env` for local development. Staging and production builds receive the same variable from their GitHub Actions environment. Normalize and validate the value as an absolute origin with no path, query, fragment, credentials, or trailing slash. Production and staging origins require HTTPS; loopback HTTP is allowed for local development and tests.

The build injects the validated value as `BUILD_SERVICE_ORIGIN`. Released binaries do not autoload `.env` and do not accept an ambient runtime variable that silently redirects update traffic. Building for local, staging, or production therefore produces a binary pinned to that environment's service origin.

### Exit codes

No DeputyDev-owned failure uses a code below 64:

| Code | Meaning before harness start |
|---|---|
| `120` | launcher usage/unknown harness |
| `121` | harness executable unavailable |
| `122` | materialization failure |
| `123` | harness preparation/provisioning failure |
| `124` | gate/update failure |
| `125` | unsupported platform/environment |

Once a harness starts, pass its exit code or signal through unchanged, even when it equals one of these numbers.

### State ownership

| File | Sole writer/purpose |
|---|---|
| `state.json` | launcher/runtime state |
| `update.json` | updater manifest cache, per-URL ETags, highest sequence, check timestamps |
| `hold.json` | temporary rollback hold |
| `staged/meta.json` | verified staged artifact metadata |

Do not merge launcher and updater state into one atomic JSON file; independent rename-based writers would lose each other's updates.

---

## 2. Distribution decision

The primary channel is a standalone Bun executable installed to a user-owned path:

```text
~/.deputydev/bin/ddcli
```

Properties:

- no Bun/Node requirement on user machines
- no `sudo`
- updater owns the managed binary path
- immutable S3 release keys served through signed CloudFront URLs
- manual stable-manifest publication

An npm/Homebrew channel may be added later, but it must be compiled/packaged with a non-self-mutating build kind and delegate upgrades to its package manager.

Never self-update a copy run from `/tmp`, a package-manager prefix, or an unrelated symlink. Compare device/inode with the managed binary before mutation.

---

## 3. Manifest publication and trust

Host these paths on the origin selected by `DEPUTYDEV_SERVICE_ORIGIN`:

```text
${DEPUTYDEV_SERVICE_ORIGIN}/stable.json
${DEPUTYDEV_SERVICE_ORIGIN}/install.sh
${DEPUTYDEV_SERVICE_ORIGIN}/v1/cli/config
${DEPUTYDEV_SERVICE_ORIGIN}/v1/cli/pi/mcp.json
```

`stable.json` and `install.sh` are public distribution resources. `/v1/cli/config` is also treated as public initially, but its transport may later become private without changing the client-config schema or its separation from distribution policy. `/v1/cli/pi/mcp.json` is a public, non-secret catalog of organization MCP server definitions; the launcher forces newly copied entries to `disabled: true`.

GitHub Actions publishes release assets and build-derived metadata. It does not publish `stable.json` or hold the manifest private key.

### Signed payload

The hosted response is an Ed25519 envelope:

```jsonc
{
  "payload": "<base64 canonical payload bytes>",
  "sig": "<base64 Ed25519 signature>"
}
```

The decoded payload contains:

```jsonc
{
  "schema": 1,
  "channel": "stable",
  "sequence": 42,
  "expires": "2026-09-11T10:00:00Z",
  "latest": "1.4.2",
  "minSupported": "1.2.0",
  "rollout": { "version": "1.4.2", "percent": 25 },
  "flags": { "newResolver": true },
  "notices": [
    {
      "level": "warn",
      "maxVersion": "1.3.0",
      "message": "A migration is required: https://example.com/migrate"
    }
  ],
  "publishedAt": "2026-09-04T10:00:00Z",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://YOUR_ORIGIN/api/v1/cli/releases/1.4.2/ddcli-darwin-arm64.gz",
      "sha256": "<compressed sha256>",
      "size": 16000000,
      "sha256Binary": "<decompressed binary sha256>",
      "sizeBinary": 45000000
    }
  }
}
```

Validate the envelope and payload with Zod before use. Distribution flags are restricted to behavior required before post-auth client config is available, including startup compatibility, update safety, recovery, and any control needed to reach that later phase. Every such flag has a safe compiled default.

### Offline signing

Sign the complete static manifest on a trusted maintainer machine:

```text
bun run scripts/sign-manifest.ts stable.draft.json > stable.json
```

The private key stays in a password manager or offline secret store. It is not imported into GitHub Actions or the config host.

The signing/publish script must:

1. parse and validate the draft
2. require `sequence` to increase monotonically
3. require a future `expires`
4. follow the artifact URL and verify it resolves
5. compare `Content-Length` when the origin provides one
6. download and hash the compressed asset
7. decompress and hash the binary
8. verify both sizes
9. sign canonical payload bytes
10. emit the final envelope

A HEAD response is advisory; the actual downloaded hashes are authoritative.

### Replay/freeze protection

- Persist the highest accepted `sequence` in `update.json`.
- Reject any fetched manifest with a lower sequence, even when its signature is valid.
- Reject expired fetched manifests for new flags, notices, rollout, or artifact selection.
- Continue enforcing the last locally accepted cached `minSupported` while offline; do not let an expired network response lower it.
- If only expired cache exists, allow ordinary execution unless its cached gate already blocks, skip optional staging, and emit at most one throttled warning.

Key rotation ships a binary trusting old and new public keys before the old key is removed.

### Pi organization MCP catalog

The Pi adapter may fetch a standard MCP config document from:

```text
${BUILD_SERVICE_ORIGIN}/v1/cli/pi/mcp.json
```

Only its `mcpServers` object is consumed. The launcher creates `~/.config/mcp/mcp.json` when absent and otherwise appends only server names that do not already exist. Every appended definition is forced to `disabled: true`; existing definitions, user enablement choices, personal entries, and entries removed from the hosted catalog are preserved. Remote settings are ignored. The request is capped at 700 ms and any network, validation, or filesystem failure leaves existing user data untouched and cannot block Pi startup.

This catalog is not binary update policy and is not stored in `update.json`. It is unsigned public convenience configuration pinned to the build service origin; disabled-by-default behavior prevents fetched commands or URLs from executing without a later user choice.

### Post-auth client configuration

After the client reaches the post-auth application phase, it may fetch user-facing configuration from:

```text
${BUILD_SERVICE_ORIGIN}/v1/cli/config
```

This endpoint is independent of `stable.json` and may return user-specific values such as product settings, UI/behavior configuration, and flags that are not required during startup or distribution. Treat it as public initially; the endpoint may later require access control. Authentication mechanics are intentionally outside this plan until that contract is finalized.

The client-config contract must follow these rules:

- Failure or unavailability must not prevent startup, update, recovery commands, or reaching the phase where the config can be fetched.
- Binary update policy, `minSupported`, artifact trust, endpoint selection, and pre-auth/launch-critical flags remain in the signed distribution manifest or compiled safe defaults.
- Validate responses with a versioned schema and ignore unknown fields for forward compatibility.
- Give every setting a safe compiled default; user-specific config may refine behavior only after it is available.
- Keep its refresh/cache lifecycle separate from `update.json` and the updater's replay sequence. Define persistence only when offline product behavior is finalized.

---

## 4. Build and versioning

Use conventional commits. For the distribution MVP, a maintainer creates a matching GitHub pre-release manually; `.github/workflows/release.yml` runs from the resulting `release.published` event. The package version, tag, and release title use the same canonical SemVer value without a `v` prefix. Release automation such as release-please can be reconsidered after the manual contract has proven stable.

Compile-time constants are the source of runtime identity:

```ts
declare const BUILD_VERSION: string;
declare const BUILD_KIND: "binary" | "managed" | "dev";
declare const BUILD_TARGET: string;
declare const BUILD_COMMIT: string;
declare const BUILD_SERVICE_ORIGIN: string;
```

The release build must explicitly use ESM bytecode because the entrypoint uses top-level await:

```bash
bun build src/index.ts \
  --compile \
  --format=esm \
  --minify \
  --bytecode \
  --sourcemap=external \
  --no-compile-autoload-dotenv \
  --no-compile-autoload-bunfig \
  --target=bun-darwin-arm64 \
  --define 'BUILD_VERSION="1.4.2"' \
  --define 'BUILD_KIND="binary"' \
  --define 'BUILD_TARGET="darwin-arm64"' \
  --define 'BUILD_COMMIT="0123456789abcdef0123456789abcdef01234567"' \
  --define "BUILD_SERVICE_ORIGIN=\"${DEPUTYDEV_SERVICE_ORIGIN}\"" \
  --outfile dist/ddcli-darwin-arm64
```

The build must fail if `DEPUTYDEV_SERVICE_ORIGIN` is absent or invalid. Runtime endpoint URLs are derived from `BUILD_SERVICE_ORIGIN` and fixed paths rather than maintained as unrelated hostnames.

`--bytecode` without explicit ESM format can select CJS behavior that rejects top-level await. The build matrix must compile and execute this exact command during Phase 0.

Use external source maps so minified production failures remain diagnosable without inflating/shipping maps inside the downloaded binary. Upload maps as separate release assets. Restrict their publication if source disclosure is a concern.

Benchmark cold start and artifact size before selecting a `--bytecode-depth`. A lower depth can reduce binary size at the cost of lazy compilation; do not choose it without measurements.

TypeScript harness resources imported with `with { type: "file" }` are read via `Bun.file(embeddedPath)` and typechecked by a separate resource tsconfig, as defined in `launcher-plan.md`.

---

## 5. On-disk layout and permissions

```text
~/.deputydev/
├── bin/
│   ├── ddcli
│   └── ddcli.prev
├── staged/
│   ├── ddcli
│   └── meta.json
├── locks/
│   ├── update.lock
│   ├── materialization.lock
│   └── pi-packages.lock
├── runtime/...               # content-addressed embedded harness resources
├── pi/                       # PI_CODING_AGENT_DIR
│   ├── npm/
│   ├── git/
│   └── sessions/             # PI_CODING_AGENT_SESSION_DIR
├── pi-packages.json          # verified package provenance and fallback state
├── state.json
├── update.json
└── hold.json
```

`staged/` and `bin/` must share a filesystem so the final rename is atomic. Never stage in `/tmp`.

Create the root with mode `0700` and credential files with `0600`. Before updater writes, verify on POSIX that the home is owned by the current UID and is not group/world writable. Refuse mutation and direct the user to `doctor` when ownership is unsafe.

The local threat model trusts same-UID processes, matching other user-space toolchain managers. Signed manifests protect the remote distribution path; they do not make a user-writable staged file immutable. Re-hashing at swap closes accidental/tampering windows but is not a sandbox against the same user.

---

## 6. Update-state and lock contract

### `update.json`

Persist validated fields such as:

```text
installId
lastCheckAt
etagsByUrl
manifest
highestSequence
lastExpiryWarningAt
```

ETags are keyed by endpoint URL. Do not send one host's validator to another fallback endpoint.

Write state via temporary sibling + atomic rename. Zod-validate all persisted state and recover safely from malformed files without deleting unrelated launcher state.

### Lock

The lock contains JSON:

```json
{ "pid": 1234, "startedAt": 1788516000000, "hostname": "macbook" }
```

Acquire with exclusive create. Reap when:

- the lock hostname is local and `process.kill(pid, 0)` proves the process no longer exists, or
- the metadata is invalid/remote and a conservative maximum age has elapsed

Treat `EPERM` as “process may still exist.” Keep the age fallback for PID reuse, crashed filesystems, and unreadable metadata.

Do not acquire the lock on every invocation. The optional-swap fast path first checks for `staged/meta.json`; if absent, return after one local existence check.

Downloading and swapping share the lock. Wait only for explicit foreground update/rollback operations; ordinary launch skips when another updater is active.

---

## 7. Cached gate and refresh policy

### Gate order

1. Return early for dev builds and internal updater self-tests.
2. Parse `DEPUTYDEV_PIN` as semver. If present and not equal to `VERSION`, print a deterministic configuration error and exit `124`; a mismatched pin is never a no-op.
3. Read and validate cached manifest locally.
4. Print applicable cached notices with throttling.
5. If `VERSION >= minSupported`, continue.
6. If a valid rollback hold covers the running version, warn once and continue.
7. Otherwise enter the mandatory-update path or print offline remediation.

Wrap `Bun.semver.order` behind a safe helper. Although baked `VERSION` and Zod validation make invalid input unlikely, an exception in the shared startup path must become a controlled update error rather than crash every invocation.

```ts
function compareVersions(left: string, right: string): -1 | 0 | 1 {
  try {
    return Bun.semver.order(left, right);
  } catch {
    throw new UpdateConfigError("invalid semantic version");
  }
}
```

### Foreground refresh eligibility

A bounded foreground refresh is allowed only when all are true:

- cache age exceeds six hours
- stdin and stdout are TTYs
- invocation is an interactive harness mode or explicit update command
- `DEPUTYDEV_NO_UPDATE` is not true
- CI is not true

Pi print mode, piped input/output, and other non-interactive adapter modes skip it. The request budget is shared across endpoints and initially capped near 700 ms.

### Gate bypass allowlist

These commands run without a hard gate so an offline user can recover:

```text
--help
--version
doctor
paths
harnesses
rollback
uninstall
```

`update --check` may read/fetch manifests but remains diagnostic and never mutates the binary.

### Mandatory update

A mandatory binary update:

1. requires a currently accepted signed artifact record
2. respects CI mutation policy
3. downloads with progress on TTY stderr
4. verifies compressed size/hash
5. streams gzip decompression into a sibling `.part` file
6. verifies binary size/hash
7. sets executable mode and self-tests `--version`
8. stages metadata
9. immediately re-hashes the staged binary
10. swaps under the lock
11. re-execs through the shared signal-correct exit helper

If the network is unavailable and cached policy blocks, print recovery commands and exit `124`; never report success.

---

## 8. Background refresh and staging

After the launcher command/harness exits, start one hidden worker that refreshes the signed manifest and stages an eligible update. It receives only a requested version/channel, never an artifact URL or checksum. It resolves those from a freshly verified manifest.

The worker process must actually detach from the parent process group/session on macOS and ignore all stdio:

```ts
import { spawn } from "node:child_process";

spawn(process.execPath, ["__stage-update", wantedVersion], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    DEPUTYDEV_INTERNAL_NO_UPDATE: "1",
  },
}).unref();
```

This uses Bun's Node-compatible no-shell process API and gives a typed `detached` contract. If native `Bun.spawn({ detached: true })` is preferred, first pin a Bun version whose public typings and runtime tests prove the option. `unref()` alone only releases the event-loop reference; it is not the process-group contract.

Phase 0 must prove with process-group inspection that the worker survives parent exit and terminal Ctrl+C on the supported macOS build. Native Windows detachment remains out of scope.

### Stage lifecycle

1. Fetch/verify a non-expired manifest and replay sequence.
2. Confirm the requested version is still eligible/latest.
3. Acquire the update lock.
4. Re-check staged metadata.
5. Download `*.gz` to `staged/ddcli.gz.part` with a five-minute timeout.
6. Hash compressed bytes while streaming; verify `sha256` and `size`.
7. Stream through `DecompressionStream("gzip")` into `staged/ddcli.part`.
8. Hash decompressed bytes; verify `sha256Binary` and `sizeBinary`.
9. Set mode `0755`.
10. Self-test with `DEPUTYDEV_INTERNAL_NO_UPDATE=1 ddcli.part --version`.
11. Rename the binary into `staged/ddcli`.
12. Write `staged/meta.json` last with version, both hashes/sizes, sequence, and timestamp.
13. Remove compressed/temp files and release the lock.

Detached worker errors are recorded in bounded updater diagnostics, never printed into a completed harness's terminal.

### Rollout

Use a stable install ID and hash `(installId + targetVersion)` into a deterministic bucket. A staged rollout affects optional staging only. A mandatory `minSupported` update ignores rollout percentage.

---

## 9. Optional swap-on-exit

Ordinary updates do not swap at startup and do not re-exec around a harness.

After the user command exits, but before returning its termination status:

1. Skip for internal worker, rollback, or unmanaged binary execution.
2. Fast-path return unless `staged/meta.json` exists.
3. Acquire the update lock without waiting.
4. Re-read and validate metadata.
5. Confirm the staged binary exists and the metadata version differs from the live version.
6. Confirm `process.execPath` and the managed binary are the same device/inode.
7. Hash `staged/ddcli` immediately before rename and compare `sha256Binary` and `sizeBinary`.
8. Self-test again only if metadata is stale or policy requires it.
9. Move the live binary to `.prev` and staged binary to live, restoring `.prev` if the second rename fails.
10. Delete staged metadata and release the lock.
11. Exit like the already-finished harness; do not re-exec.

This costs a hash only on the one invocation that consumes a staged binary. It avoids a second wrapper process in the ordinary launch path. The next invocation uses the new binary.

A running harness is unaffected by the post-exit rename. On macOS the launcher process retains its existing inode until it exits.

---

## 10. Mandatory re-exec and child termination

Mandatory update is the only normal path that swaps before command execution and re-execs. Use the same helper as harness execution:

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

Never use `result.exitCode ?? 0`; a child killed by a signal has no successful exit code.

Hoist `statSync` and all Node imports at module scope in the ESM build. Do not call `require("node:fs")` inside `sameFile()`.

Mandatory re-exec inherits stdio and sets `DEPUTYDEV_SWAPPED=<version>` only for the new DeputyDev process. Strip it before launching a harness.

---

## 11. Rollback and hold behavior

`ddcli rollback` is gate-exempt and uses the update lock. It verifies the managed installation, atomically restores `bin/ddcli.prev`, preserves the displaced binary as a possible next rollback, and clears staged files.

After a successful rollback, write:

```json
{
  "version": "1.4.1",
  "until": "2026-09-05T10:00:00Z",
  "reason": "manual rollback"
}
```

Default hold duration is 24 hours. The gate honors an unexpired hold only for that exact version, prints a one-line warning, and reports the expiry. `rollback` prints the same expiry so the user knows the gate will resume.

An expired/invalid hold is removed. A hold suppresses mandatory update but not explicit `ddcli update` initiated by the user.

Without this marker, rollback would immediately update back to the release the user was escaping.

---

## 12. Public and hidden commands

```text
ddcli --version
ddcli update
ddcli update --check
ddcli rollback
ddcli __stage-update <version>  # hidden
```

Harness dispatch happens before Commander, as specified in `launcher-plan.md`. Commander receives launcher-owned arguments only and can safely own updater commands.

- `update` performs a foreground update and re-execs without replaying `update` arguments.
- `update --check` reports current/latest and returns documented diagnostic status without mutation.
- `rollback` remains option-free in the bootstrap recovery path.
- hidden workers re-fetch and validate the manifest rather than trusting argv.
- Clack prompts are forbidden in gate, detached worker, swap, rollback, and CI paths.

Use plain stderr output in recovery paths. `performBlockingUpdate` shows a simple carriage-return percentage when stderr is a TTY and otherwise stays concise.

---

## 13. Manual S3 release assets

Bitbucket runs quality checks. Manual `bun run release:prepare-s3` on native macOS arm64 builds and ad-hoc signs the binary, creates a reproducible gzip archive and dual hashes, and writes the versioned S3 key/config snippet. `bun run release:publish-s3` uploads the archive with the secret-protected presigned PUT and verifies a CloudFront download. The maintainer promotes `CLI_RELEASES.LATEST_VERSION` only after verification. Existing GitHub Actions files are left untouched but are not part of this release path. Full instructions are in [Releasing](../README.md#releasing).

Local `release/` output includes `ddcli-darwin-arm64.gz`, `ddcli-darwin-arm64.map`, `checksums.txt`, `release-metadata.json`, `cli-release-config.json`, and `VERSION`. The archive alone is uploaded to the private bucket. The backend serves exact-version checksums and fresh signed CloudFront downloads using the configured key. The future independently signed distribution manifest can reference the stable backend **exact-version URL**, not an expiring CloudFront URL.

---

## 14. Installer

The manual installer:

1. requires Darwin arm64
2. rejects obvious container environments
3. downloads the compressed release asset to a temporary sibling under `~/.deputydev/bin`
4. downloads published checksums
5. verifies compressed hash
6. decompresses locally
7. verifies binary hash
8. sets executable mode
9. verifies code signature and `--version`
10. atomically renames into place
11. explains how to add `~/.deputydev/bin` to PATH
12. warns if `command -v ddcli` resolves elsewhere

A checksum file fetched from the same backend as the artifact selector detects corruption but not backend compromise. The implemented manual and background updater follows that trust model; an independently signed manifest remains future work.

The installer never uses `sudo` and never writes `/usr/local/bin`.

---

## 15. Test strategy

### Build tests

- compile top-level await with `--compile --bytecode --format=esm`
- run compiled `--version`
- confirm external map exists and is not required beside the executable
- materialize embedded `.ts` bytes and compare checksum
- verify gzip round-trip hashes and sizes
- run on native arm64 runner

### Fake harness and PTY

Use the shared fake harness from `launcher-plan.md` to verify argv, cwd, env stripping, TTY state, exit `42`, Ctrl+C, SIGTERM, and signal death. Mandatory re-exec uses the same exit-status tests.

### Local updater server

Use `Bun.serve` on a random local port and a temporary `DEPUTYDEV_HOME`. Cover:

- fresh, 304, timeout, invalid signature, malformed schema
- expired manifest and lower replay sequence
- cached offline gate
- no foreground fetch for print/piped invocations
- rollout bucketing
- compressed and binary hash mismatch
- interrupted download/decompression
- detached worker survival after parent exit/Ctrl+C
- staged tampering immediately before swap
- concurrent stage/swap/rollback
- dead-PID and aged lock reaping
- swap-on-exit with no re-exec
- mandatory update re-exec signal propagation
- rollback hold creation, warning, expiry, and explicit-update override
- separate launcher/update state writers

### Filesystem tests

- root ownership/mode refusal
- managed-binary device/inode check
- same-filesystem staging
- failed second rename restores live binary
- stale `.part` cleanup
- disk-full simulation where practical

---

## 16. Edge cases and required handling

| Situation | Handling |
|---|---|
| Offline/captive portal | Use cached signed policy; no cache means allow ordinary launch, but a cached hard gate remains enforced. |
| Frequent print/piped calls | No foreground network; local cache check only. |
| Concurrent invocations | Exclusive JSON lock; ordinary losers skip, foreground operations wait with timeout. |
| Stale lock | Reap dead local PID first, age fallback second. |
| Tampered staged binary | Re-hash immediately before swap, clear invalid stage, keep live binary. |
| Long harness session | Optional swap occurs after that session exits; running process remains on old inode. |
| Broken release | Lower rollout, publish corrected higher sequence, and let affected users rollback under a 24-hour hold. |
| Pin mismatch | Fail clearly; never silently continue. |
| `CI=false` | Parse false, not truthy string. |
| CI true | No background worker; required mutation only with explicit opt-in. |
| Unsupported artifact/platform | Exit `125` or `124` with reinstall guidance; never choose a “close” target. |
| Homebrew/npm copy | Managed build kind advises package-manager update and never self-mutates. |
| Symlink/wrapper invocation | Device/inode guard permits only the managed binary. |
| Disk full | `.part` files never become live; clean stale parts later. |
| Expired/frozen endpoint | Reject fetched policy for new updates, retain highest local sequence/gate, warn with throttling. |
| Source map disclosure | Publish separately and choose release visibility deliberately. |
| Container/devcontainer | CLI and installer refuse with native-host guidance; do not promise updater semantics. |

---

## 17. Ship order

### Phase 0 — prove assumptions

1. Prove ESM bytecode build with top-level await.
2. Prove external maps, gzip streaming, and dual hashes.
3. Prove embedded file assets materialize byte-for-byte.
4. Prove detached worker process-group survival on pinned Bun/macOS.
5. Prove arm64 runner label and codesign execution.
6. Prove native dependencies, if any.

### Phase 0.5 — shared correctness harness

1. Fake harness and golden argv table.
2. Shared `exitLikeChild` and PTY signal tests.
3. Architecture import rules.
4. Local signed-manifest/updater server.

### Week 1 — binary distribution only

1. Build/sign/notarize policy for `darwin-arm64`.
2. Prepare the native release on a trusted Apple Silicon Mac.
3. Upload the versioned `.gz` to private S3, then promote the backend's latest pointer.
4. Host `/install.sh` and exact-version downloads on the backend.
5. Ship `--version`, `update --check`, `update`, and the throttled post-session worker.

### Week 1 — manual foreground update

1. Add signed manifest verification, replay/expiry controls, and per-URL cache.
2. Add `update` and `update --check`.
3. Add dual-hash download/decompression and progress.
4. Add managed-path/permission checks.

### Week 2 — cached gate, rollback, and mandatory swap

1. Add local cached gate and bounded eligible refresh.
2. Add bypass allowlist.
3. Add mandatory foreground swap/re-exec with signal-correct status.
4. Add rollback with 24-hour hold.
5. Keep `minSupported` safely below current during rollout.

### After Pi provisioning — optional auto-update

1. Add detached refresh/staging only after Pi provisioning is stable.
2. Add optional swap-on-exit and staged re-verification.
3. Add rollout percentages and notices.

---

## 18. Acceptance criteria

- Warm launcher startup performs local checks only; print/piped invocations never fetch synchronously.
- Cached `minSupported` is enforced, with an explicit one-run freshness trade-off.
- Manifest signatures, expiry, and monotonic sequence prevent arbitrary binary substitution and replay downgrade.
- Private signing material is absent from CI and hosting.
- Installer, distribution manifest, and post-auth client config derive from the environment-specific compiled service origin.
- Post-auth client config is separate from distribution policy and is never required for startup, updates, or recovery.
- Build succeeds with ESM bytecode/top-level await and produces an external source map.
- Release artifact is compressed and both compressed/decompressed bytes are verified.
- Detached worker survives parent exit and terminal Ctrl+C on supported macOS.
- Optional update swap happens after command exit without re-exec.
- Mandatory re-exec and harness execution preserve exit codes and signal deaths.
- Staged bytes are re-hashed immediately before swap.
- Update lock is skipped on the no-stage fast path and reaps dead owners safely.
- Rollback creates a visible 24-hour hold and is not immediately undone.
- Recovery/doctor/version commands work while gated and offline.
- Launcher and updater state have separate writers.
- Root ownership and permissions are enforced.
- CI uses a verified arm64 runner and current official action majors.
- Local-server, concurrency, tampering, and PTY tests cover every critical update contract.

Note: Bun is installed at `/Users/vaibhavmeena/.bun/bin/bun`; use this path directly when Bun is unavailable through non-interactive shell initialization.