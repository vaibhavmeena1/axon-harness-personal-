# Axon CLI

This app lives at `apps/cli` inside the Axon monorepo. Workspace-wide setup is described in the [root README](../../README.md).

Native Bun/TypeScript launcher for running Pi with Axon-managed configuration and resources. The command is `axon`, managed state defaults to `~/.axon`, and launcher controls use `AXON_*`.

This is a clean-install rename: previous product installations are not automatically upgraded or migrated. Install Axon and update PATH and shell controls. Authentication reuses the shared DeputyDev token described below. Existing local sessions/settings and remote backups remain untouched; retain them until an explicit migration is reviewed. See the [rename progress and cutover checklist](../../docs/project-rename-to-loom.md).

## Current status

**Launcher Phase 1 and Pi resource/package isolation are implemented.** The CLI resolves and starts Pi while preserving user-supplied arguments. Pi is the only supported harness.

### Implemented

- Bun 1.4.1, strict TypeScript, Biome, and native `darwin-arm64` compilation
- Product identity, build metadata, service-origin validation, and managed paths
- Pre-Commander dispatch for `pi`
- First-run browser login before normal Pi and setup/doctor/paths/harnesses commands; local-only session status
- Authenticated, best-effort telemetry, standalone web-search, and Pi preferences from backend client-config
- Standalone web search through the existing authenticated LiteLLM relay, with grounding, session attribution, and tool usage/cost reporting
- Pi-only setup checks, including append-only organization MCP defaults at `~/.config/mcp/mcp.json`, requested only for interactive online launches and throttled locally
- Pi agent/session isolation under `${AXON_HOME}/pi`, with Pi version checks disabled and every Pi-documented provider API key removed from Pi only (LiteLLM variables are kept)
- Exact Pi 1.2.0 pin: Axon uses only its isolated executable under `${AXON_HOME}/pi-runtime`, installed from Pi's release API with `npm ci`; the user's PATH Pi is never used or changed
- Content-addressed, checksum-verified Axon Pi resources injected through explicit Pi flags that reference the immutable runtime directory
- Embedded required-package policy with exact, minimum, and Pi/user-managed floating versions
- Locked package reconciliation, last-known-good exact fallback, and local-only warm checks
- Exact Pi executable selection independent of PATH; override attempts are rejected
- Preserved user harness arguments and inherited stdio/cwd; adapters may add required generated resource or local-service options
- Axon control-variable stripping and redacted debug launch previews
- Child exit-code and signal-status propagation
- `harnesses`, `paths`, basic `doctor`, and guarded `uninstall` commands
- Launcher-core tests for registry behavior, environment isolation, argv passthrough, and reserved exit statuses
- Verified, atomic installer for the native Apple Silicon binary
- S3/CloudFront release discovery, manual `axon update`, and throttled background updates after interactive Pi sessions

### Deferred

- Phase 0 compatibility evidence and the complete Phase 0.5 PTY/import-boundary suite
- Import of personal Pi provider authentication; automatic re-login on an expired Axon session
- Apple Developer ID signing and notarization
- Independently signed update manifests, rollout policy, and rollback command (the current updater uses backend-served hashes)

## Installation

The initial `0.1.x` releases support Apple Silicon macOS only. The launcher does not bundle Pi. The installer checks for Node.js 22.19 or newer and npm before installing `axon`; if either is unavailable, it offers to install or upgrade Node.js with Homebrew in an interactive terminal. Non-interactive installations require Node.js and npm to be installed first. `axon pi` installs and uses its own exact Pi 1.2.0 release on first use, independently of any user-installed Pi.

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

The installer itself uses no `sudo` (Homebrew may request privileges when installing Node.js), installs to `${AXON_HOME:-$HOME/.axon}/bin/axon`, verifies compressed and decompressed SHA-256 hashes, verifies the ad-hoc code signature and exact version, preserves an existing binary as `axon.prev`, and atomically activates the replacement. It automatically adds the Axon bin directory to your shell startup configuration: `.zshrc` for Zsh (honoring `ZDOTDIR`), `.bashrc` and the selected login profile for Bash, `config.fish` for Fish (honoring `XDG_CONFIG_HOME`), and `.profile` for sh/dash/ksh. Existing configuration is preserved, and repeat installs or repeated sourcing do not duplicate PATH entries. Restart your terminal or run the printed shell-specific command to enable Axon in the current shell, then run:

```bash
axon doctor
```

> **macOS trust limitation:** the MVP binary is explicitly ad-hoc signed, not Apple Developer ID signed or notarized. The verified terminal installer does not disable Gatekeeper. A browser-downloaded copy may receive a quarantine attribute and trigger an unidentified-developer warning. After independently checking its published checksum and signature, remove only that file's quarantine attribute if necessary: `xattr -d com.apple.quarantine ~/.axon/bin/axon`. Never disable Gatekeeper globally.

`axon update --check` reports whether the backend has a newer macOS arm64 release. `axon update` downloads it through CloudFront, checks both SHA-256 hashes, signature, and version, and atomically replaces **only the managed binary** while keeping `axon.prev`. Interactive Pi sessions schedule a best-effort, silent check **after the session exits**, at most once every 24 hours after success (one-hour retry after a failure); the worker installs a verified newer version for the next invocation. Set `AXON_NO_UPDATE=1` to disable background work without disabling explicit updates. CI and non-interactive commands do not schedule it. Updates never downgrade and never fetch on the ordinary launch path.

The checksums and URLs come from the same backend; they detect corruption but are **not independent proof of provenance** if the backend itself is compromised. The current release is ad-hoc signed, not Developer ID signed or notarized. Separately signed distribution manifests remain future work.

## Usage

```bash
axon pi [pi arguments...]
axon update --check
axon update
```

Everything after `pi` bypasses Commander and retains its relative token order. For example, `axon pi --help` launches `pi --help`. Ordinary Pi sessions are prefixed with explicit Axon-owned resource flags.

Launcher-owned commands:

```bash
axon auth login [--browser]
axon auth status              # local saved-session check; no network verification
axon sessions                  # guided session management
axon sessions list             # plain listing for scripts
axon harnesses
axon paths
axon doctor [pi]
axon setup pi --sync-packages   # installs Pi if needed, required packages, resources, and MCP defaults
axon uninstall [--remove-runtimes]
```

`uninstall` only mutates an installation when the running executable is the managed binary at `~/.axon/bin/axon`. It preserves Pi settings, provider authentication, and sessions under `${AXON_HOME}/pi`, as well as the shared DeputyDev authentication file; `--remove-runtimes` removes only cached runtimes. Files created by earlier releases for other harnesses are not deleted automatically.

Set `AXON_DEBUG=1` for a redacted launch preview on stderr. `AXON_PI_BIN` is rejected. A different `AXON_PI_VERSION` is allowed only when running the CLI from source, not in any compiled CLI.

### First-run login and client configuration

Axon and the existing DeputyDev VS Code/binary application use the **same** user-wide authentication file: `~/.deputydev/264325ba-cbd0-47d5-9269-ac4bd19067c2.json`, under the `extension_auth_token` key. Axon does not use the separate `cli_auth_token` key. `AXON_HOME` changes only Axon's managed installation/runtime data, never this authentication location. Existing `.axon` authentication files are ignored; there is no fallback or migration.

Login and refresh write that shared token while preserving other JSON keys. Requests reload the live credential, and Axon's refresh writes use a shared `~/.deputydev/locks/session.lock` plus compare-and-swap checks so stale responses cannot replace an already changed credential. This coordinates Axon processes across different `AXON_HOME` values. The older DeputyDev writer does not acquire this lock, so sharing the file alone does not guarantee race-free writes between the two applications; full cross-app serialization requires DeputyDev to adopt the same locking protocol. Axon never deletes the shared credential on uninstall.

Normal Pi sessions and `setup`, `doctor`, `paths`, and `harnesses` first check for a safely readable saved Axon session. If absent, interactive online invocations offer browser login before doing any command work, then resume the original command after saving the credential. Non-TTY/CI/scripted or offline Pi invocations without a session fail with guidance to run `axon auth login` while online. Help/version, auth, update, uninstall, and Pi administrative commands remain exempt. A saved session avoids repeat onboarding; API routes still validate it server-side.

Online non-administrative Pi launches (including scripted modes) fetch `/api/v1/cli/config` using that session, capped at 700 ms and 16 KiB, even when telemetry/search are locally disabled. Valid telemetry and search preferences override their managed environment settings; unavailable or absent config preserves environment preferences, never changing authenticated search routing. Local kill switches still win. Offline and administrative launches skip the request. There is no config disk cache and no public bootstrap/config endpoint. See [client configuration](docs/plans/cli-client-config.md) and [backend configuration](../backend/README.md#cli-client-configuration).

### Session backups

Run `axon sessions` in a terminal for a guided menu: browse/search backed-up sessions, restore into an existing checkout, delete a remote backup, inspect status, or retry pending backups. The picker shows titles and local-time backup details and searches by title, date, or full ID. Checkout defaults to the current directory and is validated before restore; relative paths and `~/` are supported. Restore and deletion still require explicit confirmation (default **No**). Cancel any prompt to exit without starting that operation, or use **Back to menu** / **Done** to navigate. Restore prints the launch command rather than launching Pi automatically.

Existing `sessions list/status/retry/restore/delete` subcommands remain available for scripts. Bare `sessions` requires a TTY and offers browser login if no saved session exists.

Session backups are administrator-managed: the backend `config.json` boolean `SESSION_BACKUPS.ENABLED=true` enables automatic complete-transcript backups for authenticated managed Pi sessions. There is no user enable/disable/pause command or launcher override. `/axon-backups status` (or `axon sessions status`) checks policy and queue status; `/axon-backup-now` requests a checkpoint. If backend policy is unavailable, no new capture/upload is attempted. See [session backup and restore](../../docs/session-backup-and-restore.md) for sensitive-data scope and storage setup.

### Web search

The embedded `web_search` tool is standalone: it constructs a dedicated LiteLLM Chat Completions
request with `web_search_options`, reads bounded raw JSON, and returns a grounded answer and sources.
It does not modify the main agent's provider requests or send the agent's function-tool catalog.

On managed launches, backend `WEB_SEARCH` preferences select enablement, model, limits, temperature,
reasoning level, optional search context size, URL context, and grounding requirements. The launcher
always sets the destination to `/litellm/v1/chat/completions` on its capability-protected local relay.
The relay reads the saved Axon session per request, persists rotation, and supports session recovery.
Upstream requests run concurrently, including main-agent, subagent, and web-search calls; new requests
wait only while a rotated session is being saved. Login recovery is shared across waiting requests,
and cancelling one request does not cancel recovery for the others. If concurrent responses rotate
the same session, the first rotation is saved; should the auth service reject it, the relay adopts a
verified sibling rotation before asking for login. The backend proxy resolves the
native LiteLLM identity. The extension sees only the local capability,
never the real session or an upstream LiteLLM key. Raw calls explicitly carry Pi's canonical session
ID and search metadata and report tokens plus `x-litellm-response-cost` as tool usage.

`PI_WEB_SEARCH_ENABLED=false` disables the tool; offline launches also disable it. Local numeric limits
may lower backend limits. A local model preference is accepted when listed in `allowedModels`.
Backend generation/grounding preferences win when fetched, and absent/null thinking and search-context
levels clear inherited overrides. These are client preferences, not an authorization boundary;
LiteLLM enforces actual model access, rate limits, and budgets. The backend template defaults search to
**disabled**: set `WEB_SEARCH.ENABLED=true`, restart the backend, and relaunch Pi to enable it.

Outside Axon, copy `src/harnesses/pi/resources/extensions/web-search.ts` into Pi's extensions directory.
With `pi-provider-litellm`, the tool resolves the provider's current credentials, pinned root, and custom
headers per call, including `/login` and refresh. `PI_WEB_SEARCH_PROVIDER` selects an alias (default
`litellm`); `PI_WEB_SEARCH_MODEL` selects a search-capable model (default `gemini-3.8-flash`). Explicit
`PI_WEB_SEARCH_BASE_URL`/`URL` and `API_KEY` also work without the provider. An explicit destination
cannot borrow credentials from a different provider root. The file has no runtime imports or SDK dependency.

`PI_WEB_SEARCH_THINKING_LEVEL` and `PI_WEB_SEARCH_SEARCH_CONTEXT_SIZE` accept `low`, `medium`, or `high`.
Omitting them leaves reasoning at its model default and sends `web_search_options: {}`.
Gemini ignores `search_context_size` in LiteLLM 1.104.0; it is not a Gemini search-depth control.
`USE_URL_CONTEXT` is Gemini-specific, and `REQUIRE_GROUNDING` defaults to true. See `.env.example` for
all settings. `PI_WEB_SEARCH_MODE` and `PI_WEB_SEARCH_SEARCH_TOOL` are obsolete.

### Pi installation bootstrap

`axon pi` uses **only** the Axon-managed executable at `${AXON_HOME}/pi-runtime/1.2.0/node_modules/.bin/pi`. It verifies the installed package and reported executable version, installs that exact version on demand if missing, and never reads or modifies `pi` on `PATH`, regardless of its version. This also applies to forwarded Pi administration (`install`, `auth`, `mcp`, etc.). `axon pi update` (including `--extensions`) is blocked before launching Pi; use `pi update` directly for a separate global installation. Axon's own required-package reconciliation still works through its pinned executable.

The official `https://pi.dev/install.sh` cannot pin a version, requires an interactive terminal, and may edit shell profiles, so Axon does not run it. Instead it follows the same steps as Pi's own managed `pi update`: it downloads `package.json` and `package-lock.json` for the exact version from `https://pi.dev/api/installer/releases/<version>/`, plus the release metadata from `https://pi.dev/api/installer/releases/<version>`, validates that all three describe `@earendil-works/pi-coding-agent@<version>`, merges the first-party tarball SHA-512 hashes from the metadata into the lockfile (the published lockfile omits them) so that every resolved tarball is integrity-checked, runs `npm ci --ignore-scripts --omit=dev --include=optional` in a staging directory under a same-user lock, verifies the installed package version and launcher, and atomically renames the tree into place. Shell profiles and `PATH` are never modified.

Installation requires Node.js 22.19.0 or newer and npm on `PATH`; otherwise the launch fails with a remediation that names Homebrew and the official installer. Offline launches (`--offline` or `PI_OFFLINE=1`) and `axon doctor` never install. The built CLI's exact pin comes from [`pi-version.json`](pi-version.json) and is embedded when compiling. `AXON_PI_BIN` fails with a clear error. A different `AXON_PI_VERSION` is accepted only in source development runs; compiled local and release binaries reject it. `pi --version` results are cached per executable path, size, and mtime in `${AXON_HOME}/pi-executable.json`, so warm launches do not spawn Pi twice. `axon uninstall --remove-runtimes` also removes `pi-runtime`.

### Pi version during development

Change [`pi-version.json`](pi-version.json) to change the default and future built CLI pin. Keep the exact `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` development dependencies in `package.json` aligned, run `bun install` from the workspace root to update `bun.lock`, and run `bun run --cwd apps/cli pi-version:check`. The CLI check and release build reject mismatches.

To try a different *exact* Pi version temporarily without changing the checked-in default, run from `apps/cli`:

```bash
AXON_PI_VERSION=0.87.1 bun run src/index.ts pi --version
```

This works **only for source runs**: the selected version is installed into its own `${AXON_HOME}/pi-runtime/<version>` directory and does not touch the global Pi or the default managed version. Test the bundled extensions and packages against the selected version. A compiled CLI (including `bun run build`) always uses its build-time `pi-version.json` value, even if `AXON_PI_VERSION` is set at runtime. `axon pi update` remains blocked in both modes.

### Pi data isolation

Every `axon pi` launch sets:

```text
PI_CODING_AGENT_DIR=${AXON_HOME}/pi
PI_CODING_AGENT_SESSION_DIR=${AXON_HOME}/pi/sessions
```

With the default Axon home, these resolve to `~/.axon/pi` and `~/.axon/pi/sessions`. Pi settings, auth, installed npm/git packages, temporary package caches, and sessions used through Axon therefore remain separate from the user's normal `~/.pi/agent` directory. The values override inherited `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` settings, including for forwarded Pi package commands.

Pi launches set `PI_SKIP_VERSION_CHECK=1` to disable Pi's startup version request. They also remove every provider API-key variable documented by Pi (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`, and the rest of the list exported as `PI_STRIPPED_PROVIDER_VARIABLES` in [`src/harnesses/pi/environment.ts`](src/harnesses/pi/environment.ts)) so ambient personal credentials never select a provider implicitly. `LITELLM_*` variables, `GOOGLE_APPLICATION_CREDENTIALS`, cloud SDK configuration, and proxy variables are kept because the pinned `pi-provider-litellm` package is the organization provider path. This provider-key policy applies to every `axon pi` launch without mutating `process.env`.

The default `litellm` provider is labeled **Axon AI Gateway** in Pi. Set `LITELLM_DISPLAY_NAME` to customize it without editing settings:

```bash
LITELLM_DISPLAY_NAME="Company AI Gateway" axon pi
```

A `litellm.providers.litellm.displayName` value in Pi settings takes precedence over the environment variable. When the variable is unset, Axon supplies its branded default; explicit values are forwarded unchanged (empty, whitespace-only, or `"undefined"` values fall back to `LiteLLM` in the provider extension). Alias providers are unaffected, and the provider ID remains `litellm` for model references, authentication, and routing. No settings file is modified for this label.

Before an authenticated online Pi launch, Axon removes cached `litellm` models whose base URLs point to an obsolete Axon loopback relay. Otherwise Pi can restore the previous launch's random-port URLs over fresh discovery, causing “No models available.” Cleanup uses Pi's native model-store lock and an atomic write; other providers, unrelated LiteLLM endpoints, and current-relay models are preserved. Offline, administrative, and discovery-disabled launches leave the cache untouched. A busy or unsafe cache never blocks launch; use `/litellm-refresh` if models remain unavailable.

### Remote clipboard copying

For a remote multiplexer attachment or remote IDE session where Pi cannot detect SSH,
opt in to copying text to the client terminal clipboard with OSC 52:

```bash
PI_CLIPBOARD_OSC52=1 axon pi
```

Axon forwards this variable unchanged. It is not enabled by default and requires a
client terminal that supports OSC 52. Pi still attempts the local clipboard write.

### Pi resources and required packages

Axon-owned extensions, skills, prompts, and themes are embedded in the CLI, materialized under `${AXON_HOME}/runtime/<version>-<hash>/pi`, and checksum-verified. Ordinary Pi sessions receive explicit resource arguments that reference that immutable directory, so a concurrently running launcher of another Axon version can never swap resources underneath a session. The `runtime/current` symlink is maintained for inspection only. The core extension provides `/axon-status`. In interactive sessions it also replaces Pi's startup header with an Axon connected-node logo, TATA 1mg branding, the launcher version, and a “Powered by Pi” attribution. Live backup status is right-aligned beside the wordmark without adding header lines, with theme-aware activity, success, and warning colors. Shortcut hints follow the active keybindings and wrap as complete groups instead of being clipped; the tool-expansion shortcut (normally Ctrl+O) expands the help, and `/hotkeys` lists all shortcuts. Narrow terminals use a compact text header, and long version labels yield space to backup status without hiding the Axon wordmark. Pi's `quietStartup: true` still hides the header, and RPC/JSON/print modes are unchanged. Resource source has an independent Pi extension typecheck.

Every non-administrative `axon pi` session also loads the embedded `pi-org-telemetry` extension. Its OpenTelemetry dependencies are bundled into one standalone ESM resource at Axon build time, so `--extension <immutable-path>` does **not** run `npm install`, execute dependency lifecycle scripts, contact a package registry, or download dependencies. A new Axon release materializes a new content-addressed bundle once; healthy launches verify and reuse it.

The telemetry extension stays inert without managed OTLP configuration. To export traces, metrics, and structured logs, configure the backend's `CLI_CLIENT_CONFIG.TELEMETRY` or provide `OTEL_EXPORTER_OTLP_ENDPOINT` (or all three per-signal endpoint variables) as a fallback in the environment used to start `axon`. A fetched policy uses only the pinned backend OTEL proxy with Axon session auth, clears inherited exporter authorization/TLS overrides, and cannot select an external destination for the session. The extension reads the session for each batch and safely persists rotations. Managed mode supports HTTP/protobuf; environment fallback supports HTTP/protobuf and gRPC with normal env headers/API keys. Export failures are passive and bounded, and `PI_ORG_OTEL_ENABLED=false` is the emergency kill switch. The extension never exports prompt/completion text, system prompts, file contents, tool results, provider payloads, authorization headers, environment values, full session paths, raw Git remotes, or stack traces. Managed mode exports backend-verified user ID/email, optional name, and user-team membership after server-side identity replacement; environment fallback exports raw effective Git email when available or an installation UUID. Both export the normalized private repository slug; collector access and retention must be restricted accordingly. See [`src/harnesses/pi/telemetry/README.md`](src/harnesses/pi/telemetry/README.md), its [data policy](src/harnesses/pi/telemetry/docs/data-policy.md), and its [schema](src/harnesses/pi/telemetry/docs/telemetry-schema.md).

The embedded manifest in `src/product/manifest.ts` declares required community packages. Pi 1.0 provides MCP support natively, so Axon no longer installs `pi-mcp-adapter`; upgrading to a CLI with this manifest removes the adapter on the next package synchronization when its ownership state and settings entry are unchanged. If it was adopted or modified, remove it manually with `axon pi remove npm:pi-mcp-adapter@2.34.0`. The manifest locks `pi-provider-litellm` to `4.2.0` and `@juicesharp/rpiv-ask-user-question` to `2.13.8`. Package entries support:

- `exact`: only the declared version is accepted; a failed migration may use a verified, non-revoked last-known-good exact version
- `minimum`: the declared version is a hard floor; newer installed versions are accepted and never downgraded
- `floating`: no Axon version constraint; Pi or the user may update it at any time

Minimum and floating entries can still be updated explicitly with `axon pi install <source>` inside Axon's isolated Pi directory, but `axon pi update` is disabled to protect the executable pin. A direct `pi update` affects the user's separate global Pi and packages, not Axon's Pi packages. Axon does not query registries or schedule updates for healthy minimum/floating packages. It only installs a missing package, repairs a below-minimum package, or restores the required unfiltered settings entry. Exact versions change only with a new embedded Axon manifest.

A first ordinary interactive launch installs missing required packages with visible progress. Print, JSON/RPC, piped, CI, offline (`--offline` or `PI_OFFLINE=1`), and other non-interactive launches perform no package installation network work and instead direct the user to:

```bash
axon setup pi --sync-packages
```

Package checks inspect `${AXON_HOME}/pi/settings.json` and installed package metadata directly; they do not parse `pi list`. State is written to `${AXON_HOME}/pi-packages.json`, synchronization uses a same-user lock, and unrelated user package entries are preserved. If a later manifest removes a package, Axon removes it only when state and unchanged metadata prove it is still Axon-owned.

> **Security:** Pi packages run with full user permissions. Extensions, skills, dependency install scripts, and update commands can execute code. Treat every required package and manifest change as release-grade code.

See [`docs/plans/pi-package-provisioning.md`](docs/plans/pi-package-provisioning.md) for the manifest schema, lifecycle decisions, and verification plan.

### Optional git-ai tracking

Every non-administrative `axon pi` session loads an embedded git-ai checkpoint extension. It tracks the built-in `edit`, `write`, and `bash` tools, including nested calls made through codemode. It does **not** install git-ai, modify shell configuration, alter Git configuration, or change `PATH`.

The extension discovers an existing executable at `~/.git-ai/bin/git-ai`, then on absolute `PATH` entries. Set `PI_AXON_GIT_AI_BIN` to an absolute executable path to override discovery (an invalid override does not fall back to another binary). Availability is checked once per extension load with a two-second timeout. Missing/broken git-ai produces one warning and disables tracking without blocking Pi. Checkpoints have a five-second timeout; failure disables tracking until `/reload` or a new Pi process. Warnings use Pi notifications (including structured RPC UI notifications); modes without UI use stderr, never raw protocol stdout. Ephemeral sessions without a transcript are not tracked.

Optional custom file-edit tool policies use `${AXON_HOME}/pi/git-ai.override.json` (the directory selected by `PI_CODING_AGENT_DIR`), with the git-ai version-1 override schema. For example:

```json
{
  "version": 1,
  "tools": {
    "custom_edit": { "kind": "mutating", "canonical": "edit", "filepath_fields": ["file_path"] },
    "write": { "kind": "ignore" }
  }
}
```

The built-in Bash checkpoint path is always enabled when tracking is available. Invalid/missing override files leave defaults intact. Overrides are read once per extension load; use `/reload` after changing them.

**Git integration is separate:** checkpoint hooks alone do not configure attribution preservation for later commits. Users still need git-ai's Git proxy/integration for Git operations, including commits made from another terminal or IDE. git-ai receives session paths, model IDs, tool inputs/results, and edited file contents; its own storage/network behavior is controlled by the installed git-ai, not Axon's content-free OpenTelemetry policy.

### Pi MCP defaults

Before Pi starts, Axon requests the organization MCP catalog from:

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

Axon creates `~/.config/mcp/mcp.json` with mode `0600` when it is missing. Every fetched server is written with `"disabled": true`, regardless of the endpoint value. On later runs it only appends server names that are absent locally:

- existing server definitions and enabled/disabled choices are never replaced
- personal servers are preserved
- servers removed from the organization catalog remain in the user's file
- remote settings and other top-level fields are not copied
- invalid local files are left byte-for-byte unchanged

The request is best-effort and capped at 700 ms. It runs only for ordinary interactive, online launches; print, JSON/RPC, piped, CI, and offline sessions never wait on it. Attempts are recorded in `${AXON_HOME}/pi-mcp-sync.json`: after a successful request the catalog is not requested again for six hours, and after a failed one for fifteen minutes. `axon setup pi --sync-packages` ignores that throttle. If the catalog is unavailable on first run, Axon creates a safe empty `mcpServers` scaffold and retries later. Setup failures never prevent Pi from starting; details are shown with `AXON_DEBUG=1`.

## Development

Bun must be available in your shell. The repository pins Bun `1.4.1`. Dependencies are installed once at the monorepo root; everything else runs from this directory.

```bash
bun install --frozen-lockfile   # at the repository root
cd apps/cli
bun run check                   # generated extension bundle checks and typecheck
bun test
bun run dev -- --version
bun run build
./dist/axon --version
```

Terminal permissions ship as a generated standalone `.mjs` asset so the launcher can import the TypeScript command validator without colliding with Bun's file loader. After editing `src/harnesses/pi/resources/extensions/terminal-permissions.ts`, run `bun run terminal:build` and commit the generated bundle. Development/release builds and `bun run check` reject stale bundles with `terminal:check`.

Formatting and lint run from the repository root with `biome ci .`, which the root `bun run check` includes.

Local development reads `AXON_SERVICE_ORIGIN` from the ignored `apps/cli/.env`. Copy `.env.example` in this directory when setting up a new checkout. Compiled release binaries receive a validated service base URL at build time and do not autoload project environment files. Despite its name, `AXON_SERVICE_ORIGIN` accepts an optional deployment path, such as `https://deputydev.ai/axon`, and preserves it for all backend requests. Use HTTPS without a trailing slash, credentials, query, or fragment; path segments must be plain URL-safe names (no encoded or dot segments).

Every package this app imports must be declared in `apps/cli/package.json`. Bun uses isolated installs in the workspace, so a transitive dependency of another package is not resolvable from here.

## Releasing

Publishing is **manual on native Apple Silicon macOS**; Bitbucket performs checks but does not publish. The retained GitHub Actions files are not modified or needed for this release path. Releases use private S3, CloudFront signed GETs, and the backend's version configuration. Git tags can remain `cli-<semver>` for traceability, but no GitHub Release is created.

1. Configure the backend's ignored `config.json` following [CLI releases](../backend/README.md#cli-releases-macos-arm64-only): HTTPS `CLI_INSTALL.RELEASES_URL`, S3 bucket and region, key prefix, a random 32+-character `UPLOAD_AUTH_KEY`, and CloudFront trusted key group, URL and RSA PEM. Provision S3/CloudFront OAC and IAM; start with `CLI_RELEASES.ENABLED=true` and `LATEST_VERSION=""` if there is no published version yet. Never commit real secrets.
2. On a trusted macOS arm64 machine, update `apps/cli/package.json` to the desired canonical SemVer, merge and run the checks and installer tests. From `apps/cli`, set `RELEASE_VERSION` to that version, `BUILD_COMMIT` to the full tagged commit SHA, and `AXON_SERVICE_ORIGIN` to the production **HTTPS base URL** (optional deployment path, no trailing slash), for example `https://deputydev.ai/axon`. Run `bun run release:prepare-s3`. This validates the version/commit/origin, compiles, ad-hoc signs and tests the binary, reproducibly gzips it, then writes `release/checksums.txt`, `release/VERSION`, `release/release-metadata.json`, and `release/cli-release-config.json`. The source map is copied locally; it need not be publicly distributed.
3. Add the entry from `release/cli-release-config.json` under `CLI_RELEASES.VERSIONS` in the ignored backend `config.json` **without changing `LATEST_VERSION`**. Restart the backend; test `GET /api/v1/cli/releases/<version>/checksums.txt`. The first release may have `LATEST_VERSION=""` until it is published. Do not reuse or overwrite an existing S3 version key.
4. Set `CLI_UPLOAD_AUTH_KEY` in the publishing shell to the same private upload secret as the backend, then run `bun run release:publish-s3`. It compares **both** backend hashes with the prepared files, asks the protected endpoint for a short-lived PUT, uploads with its mandatory checksum/immutability headers, and re-downloads the object via CloudFront to verify the archive hash. Treat the returned URL as a credential; never log it. If the upload succeeds but CDN verification fails, **do not retry the PUT** against the same immutable key. Wait for any cached 404 to expire, verify the exact-version CloudFront download and hashes manually, and promote only after that verification succeeds.
5. Only after verification set `CLI_RELEASES.LATEST_VERSION` to the new version and restart the backend. Confirm `GET /api/v1/cli/releases/latest/VERSION`, run the public `/install.sh` path and `axon update --check` from a prior managed binary. Keep the old version's config/key for existing clients. With an enabled `LATEST_VERSION`, new installs and foreground/background updates discover the change on their next check.

For example, run preparation with `RELEASE_VERSION=0.2.0 BUILD_COMMIT=$(git rev-parse HEAD) AXON_SERVICE_ORIGIN=https://YOUR_ORIGIN bun run release:prepare-s3` and publication with `RELEASE_VERSION=0.2.0 AXON_SERVICE_ORIGIN=https://YOUR_ORIGIN CLI_UPLOAD_AUTH_KEY=<secret> bun run release:publish-s3` (prefer a secret manager over shell history). `RELEASE_KEY_PREFIX` is optional for preparation and must match backend `KEY_PREFIX`; the default is `cli/releases/`. The service base must also serve the separate `application/json` MCP catalog at `<base>/v1/cli/pi/mcp.json` (for example `/axon/v1/cli/pi/mcp.json`). The installer/updater release endpoints do not require a database.

For production under `/axon`, use the same base URL for preparation and publication:

```bash
# From apps/cli, after committing the intended release source.
export RELEASE_VERSION=0.2.0  # Must match package.json.
export BUILD_COMMIT="$(git rev-parse HEAD)"
export AXON_SERVICE_ORIGIN=https://deputydev.ai/axon
export RELEASE_KEY_PREFIX=axon-prod/cli/releases/
# Stop if checks or tests fail; do not prepare a release after a failed test run.
bun run check && bun run test && bun run release:prepare-s3

# Stage release/cli-release-config.json in backend CLI_RELEASES.VERSIONS,
# keep LATEST_VERSION unchanged, and restart the backend.
# Load CLI_UPLOAD_AUTH_KEY securely into the publishing shell, then:
bun run release:publish-s3
```

After upload/CDN verification succeeds, promote `CLI_RELEASES.LATEST_VERSION` and restart the backend. Set `CLI_INSTALL.RELEASES_URL=https://deputydev.ai/axon/api/v1/cli/releases`; the shell installer does not infer the binary's service base. Ingress must forward `/axon/*` to backend `/*`, stripping `/axon`. Auth, configuration, model/recommendation/search traffic, telemetry, backups, MCP discovery, and update/release requests all retain the public prefix; per-launch loopback relay URLs do not. See [base-path deployment](../backend/README.md#deployment-under-a-path-prefix) for backend settings and the deferred frontend follow-up.
