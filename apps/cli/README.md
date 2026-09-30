# DeputyDev CLI

This app lives at `apps/cli` inside the DeputyDev monorepo. Workspace-wide setup is described in the [root README](../../README.md).

Native Bun/TypeScript launcher for running Pi with DeputyDev-managed configuration and resources. The command is `ddcli`; existing persistent state and environment-variable names continue to use the stable `deputydev`/`DEPUTYDEV_*` identity.

## Current status

**Launcher Phase 1 and Pi resource/package isolation are implemented.** The CLI resolves and starts Pi while preserving user-supplied arguments. Pi is the only supported harness.

### Implemented

- Bun 1.4.1, strict TypeScript, Biome, and native `darwin-arm64` compilation
- Product identity, build metadata, service-origin validation, and managed paths
- Pre-Commander dispatch for `pi`
- First-run browser login before normal Pi and setup/doctor/paths/harnesses commands; local-only session status
- Authenticated, best-effort Pi telemetry preferences, with fetched config taking priority over OTEL environment settings
- Pi-only setup checks, including append-only organization MCP defaults at `~/.config/mcp/mcp.json`, requested only for interactive online launches and throttled locally
- Pi agent/session isolation under `${DEPUTYDEV_HOME}/pi`, with Pi version checks disabled and every Pi-documented provider API key removed from Pi only (LiteLLM variables are kept)
- Exact Pi 0.99.1 pin: DeputyDev uses only its isolated executable under `${DEPUTYDEV_HOME}/pi-runtime`, installed from Pi's release API with `npm ci`; the user's PATH Pi is never used or changed
- Content-addressed, checksum-verified DeputyDev Pi resources injected through explicit Pi flags that reference the immutable runtime directory
- Embedded required-package policy with exact, minimum, and Pi/user-managed floating versions
- Locked package reconciliation, last-known-good exact fallback, and local-only warm checks
- Exact Pi executable selection independent of PATH; override attempts are rejected
- Preserved user harness arguments and inherited stdio/cwd; adapters may add required generated resource or local-service options
- DeputyDev control-variable stripping and redacted debug launch previews
- Child exit-code and signal-status propagation
- `harnesses`, `paths`, basic `doctor`, and guarded `uninstall` commands
- Launcher-core tests for registry behavior, environment isolation, argv passthrough, and reserved exit statuses
- Verified, atomic installer for the native Apple Silicon binary
- S3/CloudFront release discovery, manual `ddcli update`, and throttled background updates after interactive Pi sessions

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Import of personal Pi provider authentication; automatic re-login on an expired DeputyDev session
- Apple Developer ID signing and notarization
- Independently signed update manifests, rollout policy, and rollback command (the current updater uses backend-served hashes)

## Installation

The initial `0.1.x` releases support Apple Silicon macOS only. The launcher does not bundle Pi. The installer checks for Node.js 22.19 or newer and npm before installing `ddcli`; if either is unavailable, it offers to install or upgrade Node.js with Homebrew in an interactive terminal. Non-interactive installations require Node.js and npm to be installed first. `ddcli pi` installs and uses its own exact Pi 0.99.1 release on first use, independently of any user-installed Pi.

Once the backend serves the public `/install.sh` endpoint (rendered from this repository's [`install.sh`](install.sh) using its configured release URL), install with:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://YOUR_ORIGIN/install.sh | sh
```

For an inspect-first installation:

```bash
curl --proto '=https' --tlsv1.2 -fsSLo install.sh https://YOUR_ORIGIN/install.sh
less install.sh
sh install.sh
```

The installer itself uses no `sudo` (Homebrew may request privileges when installing Node.js), installs to `${DEPUTYDEV_HOME:-$HOME/.deputydev}/bin/ddcli`, verifies compressed and decompressed SHA-256 hashes, verifies the ad-hoc code signature and exact version, preserves an existing binary as `ddcli.prev`, and atomically activates the replacement. Follow its printed PATH instruction, then run:

```bash
ddcli doctor
```

> **macOS trust limitation:** the MVP binary is explicitly ad-hoc signed, not Apple Developer ID signed or notarized. The verified terminal installer does not disable Gatekeeper. A browser-downloaded copy may receive a quarantine attribute and trigger an unidentified-developer warning. After independently checking its published checksum and signature, remove only that file's quarantine attribute if necessary: `xattr -d com.apple.quarantine ~/.deputydev/bin/ddcli`. Never disable Gatekeeper globally.

`ddcli update --check` reports whether the backend has a newer macOS arm64 release. `ddcli update` downloads it through CloudFront, checks both SHA-256 hashes, signature, and version, and atomically replaces **only the managed binary** while keeping `ddcli.prev`. Interactive Pi sessions schedule a best-effort, silent check **after the session exits**, at most once every 24 hours after success (one-hour retry after a failure); the worker installs a verified newer version for the next invocation. Set `DEPUTYDEV_NO_UPDATE=1` to disable background work without disabling explicit updates. CI and non-interactive commands do not schedule it. Updates never downgrade and never fetch on the ordinary launch path.

The checksums and URLs come from the same backend; they detect corruption but are **not independent proof of provenance** if the backend itself is compromised. The current release is ad-hoc signed, not Developer ID signed or notarized. Separately signed distribution manifests remain future work.

## Usage

```bash
ddcli pi [pi arguments...]
ddcli update --check
ddcli update
```

Everything after `pi` bypasses Commander and retains its relative token order. For example, `ddcli pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit DeputyDev-owned resource flags.

Launcher-owned commands:

```bash
ddcli auth login [--browser]
ddcli auth status              # local saved-session check; no network verification
ddcli harnesses
ddcli paths
ddcli doctor [pi]
ddcli setup pi --sync-packages   # installs Pi if needed, required packages, resources, and MCP defaults
ddcli uninstall [--remove-runtimes]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.deputydev/bin/ddcli`. It preserves Pi settings, authentication, and sessions under `${DEPUTYDEV_HOME}/pi`; `--remove-runtimes` removes only cached runtimes. Files created by earlier releases for other harnesses are not deleted automatically.

Set `DEPUTYDEV_DEBUG=1` for a redacted launch preview on stderr. `DEPUTYDEV_PI_BIN` is rejected. A different `DEPUTYDEV_PI_VERSION` is allowed only when running the CLI from source, not in any compiled CLI.

### First-run login and client configuration

Normal Pi sessions and `setup`, `doctor`, `paths`, and `harnesses` first check for a safely readable saved DeputyDev session. If absent, interactive online invocations offer browser login before doing any command work, then resume the original command after saving the credential. Non-TTY/CI/scripted or offline Pi invocations without a session fail with guidance to run `ddcli auth login` while online. Help/version, auth, update, uninstall, and Pi administrative commands remain exempt. A saved session avoids repeat onboarding; API routes still validate it server-side.

Interactive online Pi launches fetch `/api/v1/cli/config` using that session, capped at 700 ms and 16 KiB. Valid telemetry settings override environment endpoint/protocol/sampling/interval settings; unavailable, invalid, or absent telemetry config preserves the environment fallback. Explicit local `PI_ORG_OTEL_ENABLED=false` and offline Pi disable export and skip the config request. Scripted/print/RPC/JSON/CI/admin modes never perform this foreground fetch. There is no config disk cache and no public bootstrap/config endpoint. See [client configuration](docs/plans/cli-client-config.md) and [backend configuration](../backend/README.md#cli-client-configuration).

### Pi installation bootstrap

`ddcli pi` uses **only** the DeputyDev-managed executable at `${DEPUTYDEV_HOME}/pi-runtime/0.99.1/node_modules/.bin/pi`. It verifies the installed package and reported executable version, installs that exact version on demand if missing, and never reads or modifies `pi` on `PATH`, regardless of its version. This also applies to forwarded Pi administration (`install`, `auth`, etc.). `ddcli pi update` (including `--extensions`) is blocked before launching Pi; use `pi update` directly for a separate global installation. DeputyDev's own required-package reconciliation still works through its pinned executable.

The official `https://pi.dev/install.sh` cannot pin a version, requires an interactive terminal, and may edit shell profiles, so DeputyDev does not run it. Instead it follows the same steps as Pi's own managed `pi update`: it downloads `package.json` and `package-lock.json` for the exact version from `https://pi.dev/api/installer/releases/<version>/`, plus the release metadata from `https://pi.dev/api/installer/releases/<version>`, validates that all three describe `@earendil-works/pi-coding-agent@<version>`, merges the first-party tarball SHA-512 hashes from the metadata into the lockfile (the published lockfile omits them) so that every resolved tarball is integrity-checked, runs `npm ci --ignore-scripts --omit=dev --include=optional` in a staging directory under a same-user lock, verifies the installed package version and launcher, and atomically renames the tree into place. Shell profiles and `PATH` are never modified.

Installation requires Node.js 22.19.0 or newer and npm on `PATH`; otherwise the launch fails with a remediation that names Homebrew and the official installer. Offline launches (`--offline` or `PI_OFFLINE=1`) and `ddcli doctor` never install. The built CLI's exact pin comes from [`pi-version.json`](pi-version.json) and is embedded when compiling. `DEPUTYDEV_PI_BIN` fails with a clear error. A different `DEPUTYDEV_PI_VERSION` is accepted only in source development runs; compiled local and release binaries reject it. `pi --version` results are cached per executable path, size, and mtime in `${DEPUTYDEV_HOME}/pi-executable.json`, so warm launches do not spawn Pi twice. `ddcli uninstall --remove-runtimes` also removes `pi-runtime`.

### Pi version during development

Change [`pi-version.json`](pi-version.json) to change the default and future built CLI pin. Keep the exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` development dependencies in `package.json` aligned, run `bun install` from the workspace root to update `bun.lock`, and run `bun run --cwd apps/cli pi-version:check`. The CLI check and release build reject mismatches.

To try a different *exact* Pi version temporarily without changing the checked-in default, run from `apps/cli`:

```bash
DEPUTYDEV_PI_VERSION=0.87.1 bun run src/index.ts pi --version
```

This works **only for source runs**: the selected version is installed into its own `${DEPUTYDEV_HOME}/pi-runtime/<version>` directory and does not touch the global Pi or the default managed version. Test the bundled extensions and packages against the selected version. A compiled CLI (including `bun run build`) always uses its build-time `pi-version.json` value, even if `DEPUTYDEV_PI_VERSION` is set at runtime. `ddcli pi update` remains blocked in both modes.

### Pi data isolation

Every `ddcli pi` launch sets:

```text
PI_CODING_AGENT_DIR=${DEPUTYDEV_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${DEPUTYDEV_HOME}/pi/sessions
```

With the default DeputyDev home, these resolve to `~/.deputydev/pi` and `~/.deputydev/pi/sessions`. Pi settings, auth, installed npm/git packages, temporary package caches, and sessions used through DeputyDev therefore remain separate from the user's normal `~/.pi/agent` directory. The values override inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` settings, including for forwarded Pi package commands.

Pi launches set `PI_SKIP_VERSION_CHECK=1` to disable Pi's startup version request. They also remove every provider API-key variable documented by Pi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, and the rest of the list exported as `PI_STRIPPED_PROVIDER_VARIABLES` in [`src/harnesses/pi/environment.ts`](src/harnesses/pi/environment.ts)) so ambient personal credentials never select a provider implicitly. `LITELLM_*` variables, `GOOGLE_APPLICATION_CREDENTIALS`, cloud SDK configuration, and proxy variables are kept because the pinned `pi-provider-litellm` package is the organization provider path. This provider-key policy applies to every `ddcli pi` launch without mutating `process.env`.

### Pi resources and required packages

DeputyDev-owned extensions, skills, prompts, and themes are embedded in the CLI, materialized under `${DEPUTYDEV_HOME}/runtime/<version>-<hash>/pi`, and checksum-verified. Ordinary Pi sessions receive explicit resource arguments that reference that immutable directory, so a concurrently running launcher of another DeputyDev version can never swap resources underneath a session. The `runtime/current` symlink is maintained for inspection only. The core extension provides `/deputydev-status`. Resource source has an independent Pi extension typecheck.

Every non-administrative `ddcli pi` session also loads the embedded `pi-org-telemetry` extension. Its OpenTelemetry dependencies are bundled into one standalone ESM resource at DeputyDev build time, so `--extension <immutable-path>` does **not** run `npm install`, execute dependency lifecycle scripts, contact a package registry, or download dependencies. A new DeputyDev release materializes a new content-addressed bundle once; healthy launches verify and reuse it.

The telemetry extension stays inert without managed OTLP configuration. To export traces, metrics, and structured logs, configure the backend's `CLI_CLIENT_CONFIG.TELEMETRY` or provide `OTEL_EXPORTER_OTLP_ENDPOINT` (or all three per-signal endpoint variables) as a fallback in the environment used to start `ddcli`. A fetched policy uses only the pinned backend OTEL proxy with DeputyDev session auth, clears inherited exporter authorization/TLS overrides, and cannot select an external destination for the session. The extension reads the session for each batch and safely persists rotations. Managed mode supports HTTP/protobuf; environment fallback supports HTTP/protobuf and gRPC with normal env headers/API keys. Export failures are passive and bounded, and `PI_ORG_OTEL_ENABLED=false` is the emergency kill switch. The extension never exports prompt/completion text, system prompts, file contents, tool results, provider payloads, authorization headers, environment values, full session paths, raw Git remotes, or stack traces. Managed mode exports backend-verified user ID/email, optional name, and user-team membership after server-side identity replacement; environment fallback exports raw effective Git email when available or an installation UUID. Both export the normalized private repository slug; collector access and retention must be restricted accordingly. See [`src/harnesses/pi/telemetry/README.md`](src/harnesses/pi/telemetry/README.md), its [data policy](src/harnesses/pi/telemetry/docs/data-policy.md), and its [schema](src/harnesses/pi/telemetry/docs/telemetry-schema.md).

The embedded manifest in `src/product/manifest.ts` declares required community packages. It currently locks `pi-mcp-adapter` to `2.34.0` and `pi-provider-litellm` to `3.0.1`, while `@juicesharp/rpiv-ask-user-question` remains floating so Pi or the user can upgrade it. Package entries support:

- `exact`: only the declared version is accepted; a failed migration may use a verified, non-revoked last-known-good exact version
- `minimum`: the declared version is a hard floor; newer installed versions are accepted and never downgraded
- `floating`: no DeputyDev version constraint; Pi or the user may update it at any time

Minimum and floating entries can still be updated explicitly with `ddcli pi install <source>` inside DeputyDev's isolated Pi directory, but `ddcli pi update` is disabled to protect the executable pin. A direct `pi update` affects the user's separate global Pi and packages, not DeputyDev's Pi packages. DeputyDev does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded DeputyDev manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, offline (`--offline` or `PI_OFFLINE=1`), and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
ddcli setup pi --sync-packages
```

Package checks inspect `${DEPUTYDEV_HOME}/pi/settings.json` and installed package metadata directly; they do not parse `pi list`. State is written to `${DEPUTYDEV_HOME}/pi-packages.json`, synchronization uses a same-user lock, and unrelated user package entries are preserved. If a later manifest removes a package, DeputyDev removes it only when state and unchanged metadata prove it is still DeputyDev-owned.

> **Security:** Pi packages run with full user permissions. Extensions, skills, dependency install scripts, and update commands can execute code. Treat every required package and manifest change as release-grade code.

See [`docs/plans/pi-package-provisioning.md`](docs/plans/pi-package-provisioning.md) for the manifest schema, lifecycle decisions, and verification plan.

### Pi MCP defaults

Before Pi starts, DeputyDev requests the organization MCP catalog from:

```text
${BUILD_SERVICE_ORIGIN}/v1/cli/pi/mcp.json
```

The endpoint returns a standard MCP config shape:

```json
{
  "mcpServers": {
    "organization-tool": {
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

DeputyDev creates `~/.config/mcp/mcp.json` with mode `0600` when it is missing. Every fetched server is written with `"disabled": true`, regardless of the endpoint value. On later runs it only appends server names that are absent locally:

- existing server definitions and enabled/disabled choices are never replaced
- personal servers are preserved
- servers removed from the organization catalog remain in the user's file
- remote settings and other top-level fields are not copied
- invalid local files are left byte-for-byte unchanged

The request is best-effort and capped at 700 ms. It runs only for ordinary interactive, online launches; print, JSON/RPC, piped, CI, and offline sessions never wait on it. Attempts are recorded in `${DEPUTYDEV_HOME}/pi-mcp-sync.json`: after a successful request the catalog is not requested again for six hours, and after a failed one for fifteen minutes. `ddcli setup pi --sync-packages` ignores that throttle. If the catalog is unavailable on first run, DeputyDev creates a safe empty `mcpServers` scaffold and retries later. Setup failures never prevent Pi from starting; details are shown with `DEPUTYDEV_DEBUG=1`.

## Development

Bun must be available in your shell. The repository pins Bun `1.4.1`. Dependencies are installed once at the monorepo root; everything else runs from this directory.

```bash
bun install --frozen-lockfile   # at the repository root
cd apps/cli
bun run check                   # telemetry bundle check and typecheck
bun test
bun run dev -- --version
bun run build
./dist/ddcli --version
```

Formatting and lint run from the repository root with `biome ci .`, which the root `bun run check` includes.

Local development reads `DEPUTYDEV_SERVICE_ORIGIN` from the ignored `apps/cli/.env`. Copy `.env.example` in this directory when setting up a new checkout. Compiled release binaries receive a validated service origin at build time and do not autoload project environment files.

Every package this app imports must be declared in `apps/cli/package.json`. Bun uses isolated installs in the workspace, so a transitive dependency of another package is not resolvable from here.

## Releasing

Publishing is **manual on native Apple Silicon macOS**; Bitbucket performs checks but does not publish. The retained GitHub Actions files are not modified or needed for this release path. Releases use private S3, CloudFront signed GETs, and the backend's version configuration. Git tags can remain `cli-<semver>` for traceability, but no GitHub Release is created.

1. Configure the backend's ignored `config.json` following [CLI releases](../backend/README.md#cli-releases-macos-arm64-only): HTTPS `CLI_INSTALL.RELEASES_URL`, S3 bucket and region, key prefix, a random 32+-character `UPLOAD_AUTH_KEY`, and CloudFront trusted key group, URL and RSA PEM. Provision S3/CloudFront OAC and IAM; start with `CLI_RELEASES.ENABLED=true` and `LATEST_VERSION=""` if there is no published version yet. Never commit real secrets.
2. On a trusted macOS arm64 machine, update `apps/cli/package.json` to the desired canonical SemVer, merge and run the checks and installer tests. From `apps/cli`, set `RELEASE_VERSION` to that version, `BUILD_COMMIT` to the full tagged commit SHA, and `DEPUTYDEV_SERVICE_ORIGIN` to the production **HTTPS origin** (no path or trailing slash). Run `bun run release:prepare-s3`. This validates the version/commit/origin, compiles, ad-hoc signs and tests the binary, reproducibly gzips it, then writes `release/checksums.txt`, `release/VERSION`, `release/release-metadata.json`, and `release/cli-release-config.json`. The source map is copied locally; it need not be publicly distributed.
3. Add the entry from `release/cli-release-config.json` under `CLI_RELEASES.VERSIONS` in the ignored backend `config.json` **without changing `LATEST_VERSION`**. Restart the backend; test `GET /api/v1/cli/releases/<version>/checksums.txt`. The first release may have `LATEST_VERSION=""` until it is published. Do not reuse or overwrite an existing S3 version key.
4. Set `CLI_UPLOAD_AUTH_KEY` in the publishing shell to the same private upload secret as the backend, then run `bun run release:publish-s3`. It compares **both** backend hashes with the prepared files, asks the protected endpoint for a short-lived PUT, uploads with its mandatory checksum/immutability headers, and re-downloads the object via CloudFront to verify the archive hash. Treat the returned URL as a credential; never log it. If the upload succeeds but CDN verification fails, **do not retry the PUT** against the same immutable key. Wait for any cached 404 to expire, verify the exact-version CloudFront download and hashes manually, and promote only after that verification succeeds.
5. Only after verification set `CLI_RELEASES.LATEST_VERSION` to the new version and restart the backend. Confirm `GET /api/v1/cli/releases/latest/VERSION`, run the public `/install.sh` path and `ddcli update --check` from a prior managed binary. Keep the old version's config/key for existing clients. With an enabled `LATEST_VERSION`, new installs and foreground/background updates discover the change on their next check.

For example, run preparation with `RELEASE_VERSION=0.2.0 BUILD_COMMIT=$(git rev-parse HEAD) DEPUTYDEV_SERVICE_ORIGIN=https://YOUR_ORIGIN bun run release:prepare-s3` and publication with `RELEASE_VERSION=0.2.0 DEPUTYDEV_SERVICE_ORIGIN=https://YOUR_ORIGIN CLI_UPLOAD_AUTH_KEY=<secret> bun run release:publish-s3` (prefer a secret manager over shell history). `RELEASE_KEY_PREFIX` is optional for preparation and must match backend `KEY_PREFIX`; the default is `cli/releases/`. The production origin must also serve the separate `application/json` MCP catalog at `/v1/cli/pi/mcp.json`. The installer/updater release endpoints do not require a database.
