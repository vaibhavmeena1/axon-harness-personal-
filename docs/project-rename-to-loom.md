# Project rename: DeputyDev / ddcli → Axon / axon

## Summary

**Yes: this project can expose `axon pi` without changing Pi itself.** The executable would be named `axon`; the existing dispatcher would still recognize `pi` as the harness argument.

**Repository implementation is complete and locally validated. Operational cutover/release publication is still pending.** The user selected **Axon** as the product name and **`axon`** as the executable. This file retains its original filename at the user's request. Paths below are relative to the repository root.

The original pre-implementation case-insensitive scan of tracked files found the previous identity in **140 files**: 102 CLI, 25 backend, 5 frontend, and 8 repository/CI files. This includes tests, documentation, lockfiles, and generated bundles—not 140 independent functional changes. The full matching-file inventory is at the end.

The rename has three distinct layers:

1. **Command:** `ddcli` → `axon`, including executable/build/install/update filenames.
2. **Product:** DeputyDev → Axon across the CLI, backend, frontend, documentation, and internal symbols.
3. **Persistent/external identity:** `.deputydev`, environment variables, telemetry schema, S3 paths, database/deployment names, and external authentication branding. The confirmed items below will be renamed; their cutover/data-handling strategy still needs review.

### Confirmed rename scope

The user confirmed these are **included in the rename**, not optional legacy identities to retain:

- **Product-specific environment variables:** `DEPUTYDEV_*` → `AXON_*`, `PI_DEPUTYDEV_*` → `PI_AXON_*`, and `_DDCLI_RELEASES_URL` → `_AXON_RELEASES_URL`.
- **Product-specific telemetry identity/schema:** service names, metric/span names, attributes, labels, event channels, identity-source values, and corresponding dashboards/tests will use the new name.
- **S3 object paths/keys/prefixes:** rename old-brand paths and release asset filenames, including `deputydev/sessions/` → `axon/sessions/` and `ddcli-darwin-arm64.gz` → `axon-darwin-arm64.gz` in release keys. Generic prefixes such as `cli/releases/` need not change just for branding.
- **Managed home:** `~/.deputydev` → `~/.axon`, with all derived paths and the home override updated consistently.

**S3 bucket names will remain unchanged**, for both releases and session backups. Update object paths and path-based permissions/configuration within the existing buckets; do not rename or replace buckets as part of this work.

`axon` is the approved target. Database names and external authentication/deployment changes still need their own scope decisions. Existing-data migration and telemetry-history handling are cutover decisions, not decisions about whether to rename the four confirmed areas above.

The project guidance says backward compatibility is not a priority. A clean rename is therefore a reasonable default; aliases and automatic migration are **not** assumed. Existing user data and deployed resources should still not be silently deleted or disconnected.


## Implementation progress

### Decisions and safety boundaries

- Approved target: **Axon**, command **`axon`**, home **`~/.axon`**, variables **`AXON_*` / `PI_AXON_*`**, telemetry **`axon.*` / `axon_*`**, session prefix **`axon/sessions/`**.
- Clean rename: no old command/environment aliases or automatic home/object migration. **User clarification: older sessions and other legacy user data can be ignored; preserving, importing, or supporting them is not required.** No legacy-data preservation or migration logic was added. Existing files were simply left untouched, not carried forward into Axon. Historical migration/retention suggestions below are not implementation requirements.
- Preserve all existing S3 bucket names, upstream provenance, generic Pi/OTEL variables, `META_HARNESS_` tables, and the LiteLLM HMAC domain separator.
- Templates may use fresh Axon database/service names; existing databases, domains, auth services, and private deployment config are not renamed automatically.
- Retain and update the deprecated GitHub workflows; do not reactivate their release path.
- Pre-existing untracked `apps/cli/docs/plans/pi-managed-settings.md` is included for branding only; `claudegrafana.json` is left untouched.

### Work log

- **Started:** inspected repository status, identity, manifests, build/release contracts, configuration templates, and rename inventory. Working tree initially had only the three untracked files noted above (including this document). All required toolchains and app dependencies are present.
- **Implemented:** product/package/bin/build/internal symbols renamed to Axon; installer/updater/backend filenames, checksum parsing, and release-key validation changed together; environment producers/consumers/filtering, relay control path, extension filename/resource ID, slash commands, persisted restore entry, telemetry schema/protections/dashboard, and session prefixes updated. S3 bucket fields and generic release prefixes are unchanged.
- **Resources and metadata:** manifest revision bumped from `9` to `10`; Bun and uv lockfiles regenerated; frontend pnpm metadata validated (lockfile unchanged); telemetry and backup bundles rebuilt from source. Deprecated GitHub workflows retained with Axon names. Updated the pre-existing untracked managed-settings plan for branding only.
- **Local development:** renamed only the `apps/cli/.env` service-origin key to `AXON_SERVICE_ORIGIN`, preserving its value. Private backend/frontend config remains untouched to avoid switching existing databases, buckets, domains, or historical release keys without a cutover.
- **Validation complete:** `bun run check`, `bun run test`, frontend production build, native Apple Silicon build, installer syntax, and isolated native CLI/Pi smoke checks passed. Applied only rename-related Ruff/Biome formatting fixes. Strengthened identity/default-home/home-override regression assertions.
- **Build cleanup:** removed only the obsolete ignored `apps/cli/dist/ddcli` and `ddcli.map` build artifacts after successfully generating `dist/axon` and `axon.map`. Existing managed homes and published artifacts were not changed.
- **Residual scan reviewed:** no old product/command/env/schema strings remain in tracked source, templates, tests, docs, or locks outside this historical audit and the explicit build-path/filename exceptions below. Two old-name matches in the rebuilt telemetry bundle are Bun-generated absolute `@grpc/grpc-js` build paths containing the unchanged checkout directory `deputydev-cli`; these are not product identity and were not hand-edited. The CLI README intentionally links to this unchanged `project-rename-to-loom.md` filename.
- **Pending external acceptance:** live installation/login/chat/update, immutable release publication, deployed telemetry/dashboard checks, and S3 policy/config cutover. Legacy-session retention/migration is not a gate or required work. No external state will be changed by this implementation.

### Local verification results

| Check | Result |
| --- | --- |
| `bun run check` | Passed CLI pin/resource checks and both TypeScript configurations, frontend ESLint/typecheck, backend Ruff format/lint/tests, and repository Biome CI |
| `bun run test` | Passed: 289 CLI tests, 1 optional load-test skip; 207 backend tests |
| `SESSION_BACKUP_LOAD_TESTS=1 bun run test:cli` | Passed: **290 CLI tests, 0 failures, no skips** (including the 100 MiB boundary test) |
| `bun run build:frontend` | Passed Vite/TypeScript production build |
| `bun run --cwd apps/cli build` | Passed; generated native `apps/cli/dist/axon` and its source map |
| `sh -n apps/cli/install.sh` / `git diff --check` | Passed |
| Native `axon --version` / `axon --help` | Passed; version `0.1.0-dev`, Axon command/help branding |
| Native `axon pi --help` / `axon pi --version` | Passed in a disposable `AXON_HOME`, offline, with a cloned existing pinned runtime; Pi reported **1.1.0** |
| Native `axon auth status` | Correctly reported no saved Axon session in that disposable home; did not reuse old credentials |
| Lock validation | Bun frozen-lockfile, uv offline `--check`, and pnpm offline frozen-lockfile checks passed; dependency versions unchanged. Bun retained stale root-name metadata during regeneration, so that metadata was corrected and frozen validation rerun |
| Preserved contracts | Release/session bucket fields, auth-service configuration, generic `cli/releases/` prefix, upstream provenance, LiteLLM HMAC separator, and database table/migration identities unchanged |

The backend emits one existing FastAPI/Starlette `httpx` deprecation warning; tests still pass. No production authentication, collector, live S3 policy, real update between published releases, or interactive chat acceptance was claimed.

### Remaining operator cutover

1. Keep existing S3 bucket names. Review IAM/lifecycle prefix scopes for `axon/sessions/` before changing private runtime config. Start fresh under the new namespace; legacy sessions/backups need not remain accessible or be migrated. No legacy-data cleanup was requested or performed.
2. Publish freshly built/signed/hashed Axon releases under **new immutable version keys**; do not simply rename old release config keys or reuse checksums. Retire/separate the old release naming contract explicitly.
3. Review private backend/frontend config, shell/PATH exports, deployment/image names, auth UI, and external integration credential paths. The template database name is `axon` for fresh provisioning only; existing database names and table prefixes are untouched. OpenRouter referer is a placeholder (`https://YOUR_ORIGIN`), not an invented Axon domain.
4. Roll out new telemetry schema/services/dashboards/alerts with an explicit historical-data boundary. Confirm live identity protections and data flow.
5. Run installed-release login/Pi/chat auth recovery, backups/restore, real update, and uninstall acceptance. Users reinstall/sign in using `~/.axon`; no automatic old-home migration or aliases are provided.

## 1. Approved naming map

| Surface | Previous identity | Approved target |
| --- | --- | --- |
| Product display name | `DeputyDev` | `Axon` |
| Application ID / root package | `deputydev` | `axon` |
| Terminal command | `ddcli` | `axon` |
| CLI package | `deputydev-cli` | `axon-cli` |
| Frontend package/service | `deputydev-console` | `axon-console` |
| Backend package/service/image | `deputydev-console-backend` | `axon-console-backend` |
| Managed home | `~/.deputydev` | `~/.axon` |
| Launcher environment prefix | `DEPUTYDEV_*` | `AXON_*` |
| Launcher-to-Pi markers | `PI_DEPUTYDEV_*` | `PI_AXON_*` |
| Release binary/archive | `ddcli-darwin-arm64[.gz]` | `axon-darwin-arm64[.gz]` |
| Core Pi resource | `deputydev.ts` / `deputydev-core` | `axon.ts` / `axon-core` |
| Product event channel | `deputydev:telemetry` | `axon:telemetry` |
| Telemetry names | `deputydev.*` / `deputydev_*` | `axon.*` / `axon_*` |
| Session-storage prefix | `deputydev/sessions/` | `axon/sessions/` |
| S3 bucket names (releases and backups) | Existing configured names | **Unchanged** |

The package/service names in this map have been adopted. The executable is `axon`; the CLI workspace package is `axon-cli`.

## 2. Central identity and command entry point

### Primary change locations

| File | Finding / required change |
| --- | --- |
| `apps/cli/src/product/identity.ts` | Central `PRODUCT_IDENTITY`: change `applicationId`, `command`, `displayName`, `homeEnvironmentVariable`, and `defaultHomeDirectoryName` for a full rename. |
| `apps/cli/package.json` | Change package name/description, the `bin` key from `ddcli` to `axon`, and the development build output from `dist/ddcli` to `dist/axon`. |
| `package.json` | Change monorepo name/description and the `build:backend-image` service argument/image tag. The `cli` script can stay named `cli`; it is a development task, not the installed command. |
| `bun.lock` | Regenerate after package/bin changes. It records both workspace names, the CLI bin mapping, and the CLI workspace package entry. |
| `apps/cli/src/product/paths.ts` | Managed live, previous, and staged executable paths already derive from `PRODUCT_IDENTITY.command`. Default home derives from the identity too. Internal symbols still contain DeputyDev. |
| `apps/cli/src/cli/launcher-program.ts` | Commander name, overall description, and harness help already use `PRODUCT_IDENTITY`; many command descriptions and update messages are still hardcoded. |

### Why `axon pi` works

`apps/cli/src/index.ts` takes `process.argv.slice(2)` → `src/cli/dispatch.ts` resolves the first token through `src/harnesses/registry.ts` → the Pi adapter launches the managed Pi executable.

The dispatcher does **not** require the executable name to be `ddcli`. Keep the harness ID `pi` and its forwarding behavior unchanged. Changing only the display identity is insufficient, however: the built/installed executable and release pipeline must also use the new name.

## 3. Installer, updater, and release contract — change together

The asset name is duplicated across TypeScript, shell, and Python. These are functional dependencies, not just labels.

| File | Finding / required change |
| --- | --- |
| `apps/cli/install.sh` | Change `PROGRAM`, `ARCHIVE_NAME`, `BINARY_ASSET_NAME`, `DEPUTYDEV_HOME`/default home, `_DDCLI_RELEASES_URL`, temporary-file prefixes, and printed commands/messages. Derived live and previous binary paths then follow `PROGRAM`. |
| `apps/cli/scripts/build-release.ts` | Change `RELEASE_ASSET_BASENAME` and build-time service-origin variable. |
| `apps/cli/scripts/generate-release-metadata.ts` | Change `BINARY_NAME`; archive name is derived. Basename validation, checksum entries, metadata, and generated GitHub asset URL use these names. This is the retained GitHub metadata path, not the current S3 publication path. |
| `apps/cli/scripts/prepare-s3-release.ts` | Change archive/executable constants and service-origin variable. This determines S3 keys, checksum names, source-map filenames, and release metadata/config snippets. |
| `apps/cli/scripts/publish-s3-release.ts` | Change archive constant, service-origin variable, and publication message. |
| `apps/cli/src/updater/release.ts` | Change archive/binary constants **and the two literal checksum regexes** in `releaseHashes`. Updating constants alone will still reject renamed releases. |
| `apps/cli/src/updater/update.ts` | Change no-update environment variable, `.ddcli-update-` staging prefix, hardcoded staging backup `ddcli.prev`, and user guidance. Final managed paths derive from the identity. |
| `apps/backend/app/services/cli_releases.py` | Change `ARCHIVE_NAME` and `BINARY_NAME`; backend checksum responses and archive routes import these constants. |
| `apps/backend/app/core/config.py` | Release-key validation explicitly requires a key ending in `/ddcli-darwin-arm64.gz`; update it or new release config is rejected. |
| `apps/backend/config_template.json` | Change example `CLI_RELEASES.VERSIONS.*.s3_key` suffix. Apply equivalent changes to actual deployment config separately. |

### Important dependencies

- `apps/backend/app/routers/cli_releases.py` constructs the download route and checksum contents from the service constants. It has no old-name literal itself, but its API output changes when those constants change.
- `apps/backend/app/routers/install.py` serves the CLI shell template. It has no brand literal, so a name-only change does not require rewriting it. Preserve its exact `DEFAULT_RELEASES_URL` substitution marker unless deliberately changing both sides.
- The updater and uninstall checks require the running executable to be the managed installation. Merely renaming an arbitrary copied binary is not a complete installation strategy.
- Rebuild, sign, compress, and calculate **new hashes**. Do not reuse old checksum/config entries for a newly built binary, and do not overwrite immutable published version keys.
- Generic `/install.sh`, `/api/v1/cli/releases`, `CLI_RELEASES`, `CLI_UPLOAD_AUTH_KEY`, `RELEASE_*`, and `cli-<semver>` tags do not contain the old product identity and can remain.

### Existing-client cutover risk

Old binaries request `ddcli-darwin-arm64.gz` and parse checksums containing the old asset names. The backend currently exposes one shared naming scheme, not a per-version scheme. Changing its constants/validator therefore also affects old configured releases and clients.

For a clean break, document an explicit Axon install/reinstall and retire or separate the old release service/config. **Do not assume an old `ddcli update` can transparently become `axon`.** If preserving old installations is required later, design a dedicated transition; that is additional work, not a prerequisite imposed by this audit.

## 4. Environment-variable producers, consumers, and isolation

Rename the variables consistently across source, build tooling, tests, examples, and actual shell/deployment settings.

### Launcher controls

| Current variable | Main locations / behavior |
| --- | --- |
| `DEPUTYDEV_HOME` | Product identity/path resolver, installer, extension credential/backup path adapters, tests, docs. |
| `DEPUTYDEV_DEBUG` | `src/index.ts`, `launcher/launch-harness.ts`, `harnesses/pi/setup/index.ts`, doctor guidance. |
| `DEPUTYDEV_NO_UPDATE` | `src/updater/update.ts` and environment registry; controls background updates. |
| `DEPUTYDEV_SERVICE_ORIGIN` | `src/build-info.ts`, release build/prepare/publish scripts, `.env.example`, retained GitHub release workflow. Built releases embed the origin; renaming the variable does not change that behavior. |
| `DEPUTYDEV_PI_VERSION` | `harnesses/pi/installation.ts`; source-development override / compiled pin validation. |
| `DEPUTYDEV_PI_BIN` | `harnesses/registry.ts`; override is intentionally rejected. Rename the rejected variable and diagnostics, not the policy. |
| `_DDCLI_RELEASES_URL` | Source-installer release-URL override; example target `_AXON_RELEASES_URL`. |

`src/launcher/environment.ts` also registers `DEPUTYDEV_PIN`, `DEPUTYDEV_ALLOW_CI_UPDATE`, `DEPUTYDEV_INTERNAL_NO_UPDATE`, and `DEPUTYDEV_SWAPPED`. They are registry/documentation entries without matching functional updater consumers in the inspected code. Rename or remove intentionally; do not present them as implemented features. `DEPUTYDEV_FUTURE_INTERNAL_CONTROL` and `DEPUTYDEV_OPENCODE_BIN` are test fixtures, not supported product controls.

**Security-sensitive:** `createHarnessEnvironment` filters all names starting with `DEPUTYDEV_`. Update the prefix check and registry together to `AXON_`, preserving stripping of unknown launcher controls and debug redaction. Renaming readers but leaving the old filter would leak the new controls into Pi.

### Trusted launcher-to-Pi markers

Change every producer and consumer of:

- `PI_DEPUTYDEV_CLI_VERSION` → `PI_AXON_CLI_VERSION`
- `PI_DEPUTYDEV_LAUNCH_STARTED_AT` → `PI_AXON_LAUNCH_STARTED_AT`
- `PI_DEPUTYDEV_AUTH_RELAY_URL` / `PI_DEPUTYDEV_AUTH_RELAY_KEY` → `PI_AXON_AUTH_RELAY_URL` / `PI_AXON_AUTH_RELAY_KEY`
- `PI_DEPUTYDEV_BACKUP_HOME` / `PI_DEPUTYDEV_BACKUP_SERVICE_ORIGIN` → `PI_AXON_BACKUP_HOME` / `PI_AXON_BACKUP_SERVICE_ORIGIN`

Locations: `harnesses/pi/environment.ts`, `harnesses/pi/adapter.ts`, `launcher/launch-harness.ts`, the core extension, `harnesses/pi/session-backup/index.ts`, and telemetry `src/environment.ts` / `src/index.ts`.

Standard Pi/provider/OpenTelemetry names such as `PI_CODING_AGENT_DIR`, `PI_SKIP_VERSION_CHECK`, `PI_ORG_OTEL_*`, `LITELLM_*`, and `OTEL_*` should remain unchanged. Their values may point to the new home/service.

## 5. Pi extensions, resources, and session records

| File | Finding / required change |
| --- | --- |
| `apps/cli/src/harnesses/pi/resources/extensions/deputydev.ts` | Rename the source file to `axon.ts`; update function name, `deputydev-status` entry/command, `deputydev-auth` UI status key, messages, auth markers, and local auth control URL. |
| `apps/cli/src/product/manifest.ts` | Update asset import/path, asset variable, `DEPUTYDEV_CORE_RESOURCE`, `deputydev-core` ID, resource destination `pi/extensions/deputydev.ts`, and `DEPUTYDEV_MANIFEST`. The source filename and manifest destination must agree. Review/bump manifest revision when changing resource identity. |
| `apps/cli/src/cli/auth/session-recovery.ts` | Local relay control prefix is `/_deputydev/auth`; change it together with the core extension's request path. Otherwise in-chat login recovery stops working. |
| `apps/cli/src/harnesses/pi/session-backup/index.ts` | Rename `/deputydev-backups`, `/deputydev-backup-now`, UI status key, trusted backup markers, and its home override. Example commands: `/axon-backups` and `/axon-backup-now`. |
| `apps/cli/src/harnesses/pi/resources/extensions/model-recommender.ts` | Hardcoded emitter `deputydev:telemetry` must match the renamed event-channel consumers. |
| `apps/cli/src/telemetry/product-events.ts` and telemetry `src/index.ts` | Event-channel declaration/registration must be kept in sync with backup and recommendation emitters. |
| `apps/cli/src/sessions/restore.ts` | Rename custom transcript entry `deputydev.restore` and setup guidance. This changes a persisted session-record label, not the Pi session format itself. |

### Generated files: rebuild, do not search-and-replace

These tracked resources embed old strings and even bundled copies of path/credential logic:

- `apps/cli/src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs`
- `apps/cli/src/harnesses/pi/resources/extensions/session-backup.mjs`

Update their sources first, then from `apps/cli` run:

```bash
bun run telemetry:build
bun run backups:build
bun run telemetry:check
bun run backups:check
```

`apps/cli/scripts/build-pi-telemetry.ts` also has a branded temporary-directory prefix. Bundle filenames `pi-org-telemetry.mjs` and `session-backup.mjs` are generic and need not change. Rebuild native binaries/maps and release artifacts; do not edit compiled output.

## 6. Telemetry and dashboards — a coordinated schema rename

Product-specific telemetry naming is confirmed in scope. This rename affects emitted data and queries, not just the service display name.

| Area / files | Findings |
| --- | --- |
| `apps/cli/src/telemetry/client.ts` | `OTEL_SERVICE_NAME=deputydev-cli`, `deputydev.cli.version` resource attribute, and `deputydev_auth` identity source. |
| `apps/cli/src/harnesses/pi/telemetry/src/environment.ts` | Embedded extension version includes `-deputydev.1`; choose the renamed fork/version identity and update its version assertion. |
| Telemetry `src/identity.ts`, `src/product.ts`, `src/otel/product-instruments.ts`, `src/otel/runtime.ts` | Identity-source enum; `deputydev.*` spans/metrics/attributes; `deputydev_cli_version` metric label; product log text. |
| Telemetry `src/otel/managed-exporter.ts` | Credential path resolution uses `resolveDeputyDevPaths({ DEPUTYDEV_HOME: home })`; change with the renamed home resolver. |
| `apps/backend/app/telemetry.py` | Backend recommender metrics/spans, tracer/meter `deputydev-products`, identity and correlation attributes, and metric-view instrument names. |
| `apps/backend/app/proxies/otel.py` | Server-authoritative `deputydev_auth` source and `deputydev.user_team_id` attribute. Rename the identity-overwrite protection and admission lookup too, not just emitted values. |
| `apps/backend/app/routers/model_recommendations.py`, `app/services/model_recommendation/service.py` | `deputydev.recommendation.id` correlation attribute. |
| `apps/cli/src/harnesses/pi/telemetry/grafana.json` | PromQL metric prefixes/labels, release-version legend, user-variable queries, and TraceQL span names. Update together with instrumentation and `tests/grafana.test.ts`. |
| Backend configuration | `SENTRY.SERVICE_NAME` and `OPEN_TELEMETRY.SERVICE_NAME` use the old backend name. |

Renamed telemetry will create new time series/service identities. Decide whether a historical boundary is acceptable or dashboards should query both generations during a transition. Update deployed dashboards, alerts, and collector rules outside the repo as applicable. Do not rename generic `pi.*` metrics merely because they share the dashboard.

Preserve `UPSTREAM_PACKAGE.json`, `UPSTREAM_README.md`, `UPSTREAM_SNAPSHOT.sha256`, and upstream copyright/license attribution: they describe provenance, not this product's chosen name.

## 7. Backend, frontend, and deployment branding

### Backend

- `apps/backend/pyproject.toml`: package name and description. Regenerate `apps/backend/uv.lock` with `uv lock` after changing metadata.
- `apps/backend/app/main.py`: FastAPI description; title derives from configured `NAME`.
- `apps/backend/config_template.json`: `NAME`, database `DB_NAME`, the `REDIS_CACHE_HOSTS.deputydev` label, Sentry/OTEL service names, release keys, session prefix, OpenRouter `APP_TITLE`, and `HTTP_REFERER`.
- `apps/backend/app/clients/litellm.py`: fallback team alias `DeputyDev team ...` and metadata keys `deputydev_user_team_id` / `deputydev_team_id`. Rename future metadata carefully; existing LiteLLM records are external state and may retain their existing aliases/metadata.
- Backend authentication, clients, proxy, router, and package docstrings/comments also use DeputyDev; see the inventory.
- `apps/backend/deployment/litellm/config.yaml`: branded explanatory comment.

**Operational names are not resources:** changing `DB_NAME` does not rename/copy a PostgreSQL database. Changing a Sentry/OTEL service label does not move history. Review these separately from package metadata.

### Frontend

- `apps/frontend/package.json`: `deputydev-console` package name.
- `apps/frontend/config_template.json`: `NAME`.
- `apps/frontend/index.html`: browser title.
- `apps/frontend/src/App.tsx`: heading.
- `apps/frontend/README.md`: branding and monorepo references.
- Validate with the frontend's own pnpm install/build. `pnpm-lock.yaml` currently has no old-name matches; do not force an unnecessary textual edit.
- `public/favicon.svg` contains no old-name text; a different icon is a design decision, not a required command rename.

### Containers / CI

- Root `package.json` and backend README name the image/build argument `deputydev-console-backend`.
- `Dockerfile` is parameterized by `SERVICE_NAME`; no direct old-brand string was found. Supply the renamed argument/tag and coordinate deployment paths rather than rewriting the generic Dockerfile.
- **Current documented publishing path:** manual Apple Silicon build → private S3 → CloudFront, with Bitbucket checks. `bitbucket-pipelines.yml` has no old-name literal requiring replacement.
- **Retained/deprecated GitHub files:** `.github/workflows/ci.yml` hardcodes `dist/ddcli`; `release.yml` hardcodes binary/archive/map paths, asset/checksum names, attestation path, and `DEPUTYDEV_SERVICE_ORIGIN` repository variable. They are not needed for the current release path. For a zero-old-brand repository, explicitly update or remove/archive them; do not accidentally treat their GitHub publishing path as active.

## 8. Managed home, credentials, and session-storage consequences

### Local home

The managed-home rename from `~/.deputydev` to `~/.axon` is confirmed in scope. Changing the identity default relocates all derived paths: `bin`, live/previous binaries, Pi settings/auth/sessions, managed Pi installations, bundled resources, locks, package state, update state, and session-backup state.

A clean Axon install will not automatically discover `~/.deputydev`. Users may need to log in and provision Pi again. If existing local sessions/settings matter, choose and test an explicit migration rather than treating caches and user data as interchangeable.

`apps/cli/src/cli/auth/session.ts` stores credentials in the UUID-named `264325ba-cbd0-47d5-9269-ac4bd19067c2.json` using the key `extension_auth_token`. **Neither needs renaming just for branding.** The code says this file may be shared with the VS Code integration. A home change breaks that location sharing unless the external integration is updated or a deliberate sharing/migration strategy is chosen. That integration is not implemented in this repository.

### Remote backups

- Rename the session object prefix to `axon/sessions/` in both defaults in `apps/backend/app/core/session_storage.py`, the backend template, and `apps/backend/deployment/test_session_s3.py`.
- **Keep the existing session-backup and release bucket names unchanged.** Only object paths/keys/prefixes are being renamed.
- Update the session-backup runbook's S3/IAM prefix examples and path-based policy resources, keeping the bucket component of S3 ARNs unchanged.
- Review actual bucket IAM/lifecycle policies and database object-key references before switching prefixes within the existing buckets. `app/services/sessions/storage.py` lists/checks policies using the configured prefix; `service.py` creates pending keys and performs prefix-based checks with it.
- A prefix change does not move existing objects or rewrite stored object keys. Decide how to retain access to historical objects, migrate them explicitly, or start fresh under the new prefix without destroying existing backups.

## 9. Documentation and test expectations

### Documentation

Update root `README.md`, `SECURITY.md`, `CLAUDE.md`, all three app READMEs, CLI `.env.example`, CLI launcher/shipping/package/client-config/rollout/workflow/UX plans with old-name matches, telemetry documentation, and `docs/session-backup-and-restore.md`.

The CLI README explicitly says the command is `ddcli` while persistence/env retain DeputyDev identity. That statement must be rewritten for a full rename.

Historical plans may describe obsolete behavior. Rename examples as needed, but do not accidentally implement old proposals or advertise them as current functionality. In particular, `.env.example` contains an outdated authoritative `DEPUTYDEV_PI_BIN` description even though the implementation rejects that override.

### Tests

The detailed inventory includes all matching tests. Important clusters:

- `apps/cli/tests/release-contract.test.ts` explicitly asserts `ddcli` **while retaining** `.deputydev`. Replace those expectations with the chosen full identity/home.
- `launcher.test.ts`: help/commands, paths, variable stripping, debug output, resource paths, fake harnesses.
- `tests/installer/install.test.ts`, `tests/update.test.ts`, backend `tests/test_cli_releases.py`: filenames, checksum text, routes, installer overrides, managed paths, backup binaries.
- CLI auth/client-config/Pi installation/package/MCP/session tests: home overrides and names/imports.
- CLI telemetry tests and telemetry `tests/*`: metrics, identity source, versions, event channels, dashboard queries, bundle import/integration.
- Backend LiteLLM identity, OTEL proxy, product telemetry, and session-backup tests: metadata/identity fields and storage prefix.

Also rename branded test temporary-directory prefixes. They are low risk but still old-brand strings.

### Internal code symbols

For genuinely renaming everything, update exports/imports and test references together:

`DeputyDevPaths`, `resolveDeputyDevPaths`, `DeputyDevManifest`, `deputyDevManifestSchema`, `parseDeputyDevManifest`, `hashDeputyDevManifest`, `DEPUTYDEV_MANIFEST`, `DEPUTYDEV_CORE_RESOURCE`, `DEPUTYDEV_ENVIRONMENT_REGISTRY`, `ensureDeputyDevSession` / `ensureDeputyDevSessionInternal`, and branded extension/asset/local variable names.

Prefer neutral internal names such as `ProductPaths` / `resolveProductPaths` and `ProductManifest` where useful, while keeping public product strings explicitly Axon. Internal symbol changes are not what makes `axon pi` work, but leave no DeputyDev-specific source API behind if that is the goal.

## 10. Local files and external work not covered by tracked replacements

### Local working copy

- Ignored `apps/backend/config.json` and `apps/frontend/config.json` exist and contain old-name references. Template changes will not modify these or deployed configuration. No private values are copied into this report.
- Update `apps/cli/.env` if present, shell exports/profiles, PATH entries, and publishing-machine environment variables.
- Existing ignored `apps/cli/dist/ddcli` and `ddcli.map` are build artifacts; remove obsolete output deliberately and regenerate under the chosen new name.
- Untracked `apps/cli/docs/plans/pi-managed-settings.md` also contains old names. Include it if it will become part of the project; it was left untouched.
- Untracked `claudegrafana.json` had no direct old-name matches in the scan and was left untouched. The tracked telemetry dashboard is the identified dashboard change.

Other working-tree changes appeared while this audit was running. They were not reverted or edited; this report is a snapshot of the inspected tree.

### Outside this repository

Review, as applicable: repository display/slug and clone URLs, checkout directory, command-name/PATH collisions, domains/DNS/TLS, production service origin, authentication website branding and browser-login URLs, image/deployment names, database provisioning, S3/CloudFront/IAM policies, Sentry projects, deployed Grafana dashboards/alerts, and developer onboarding material.

The local checkout directory is named `deputydev-cli`, but the configured Git remote uses a `meta-harness` repository slug. A package rename does not rename either. Both are separate administrative choices; renaming the checkout is not necessary for `axon pi`.

The backend talks to a separate auth service described as `deputydev-auth`. Renaming comments here does not rename that service or its browser UI. Review configured `AUTH_SERVICE.BASE_URL` and `BROWSER_LOGIN_URL` only if its host/branding actually changes; keep encrypted-token contracts intact.

### Adjacent legacy identity: optional, not a DeputyDev/ddcli match

If “everything” also includes `meta-harness`:

- LiteLLM `metadata.source`, key aliases, and the HMAC domain separator `meta-harness/litellm-key/v1` in `app/clients/litellm.py` still use that identity. **Changing the HMAC string changes derived virtual keys**, which is a credential/policy transition—not cosmetic replacement.
- Database tables/migration bookkeeping use `META_HARNESS_` via `app/core/config.py`, SQL schema/migration files, and deployment migration tooling. Renaming that prefix requires coordinated schema/model/tooling changes and a database migration if data exists.

These do not need to change to get Axon branding and `axon pi`; keep them out of a blind rename unless intentionally included in scope.

## 11. Suggested implementation order and acceptance checks

1. [x] Target name selected: **Axon / axon**. Implement a clean-install cutover without aliases or automatic data migration; retain existing local/remote data untouched. Environment variables, telemetry naming, S3 paths, and the managed home are confirmed rename scope; S3 bucket names must remain unchanged.
2. [x] Changed central identity, package/bin/build names, and internal symbols; regenerated Bun/uv locks and validated pnpm metadata.
3. [x] Changed installer/updater/release/backend asset contract as one unit, including checksum regexes and config suffix validation.
4. [x] Renamed environment producers/consumers/filtering, core extension file/manifest/relay path, slash commands, and event channels.
5. [x] Changed telemetry instrumentation/backend identity protections/dashboard queries together.
6. [x] Changed frontend/backend branding/templates and repository S3 object paths/policy examples, preserving bucket names. **Actual private/deployed config and policies remain operator cutover work**, listed above.
7. [x] Updated tests, docs, examples; retained deprecated GitHub workflows with Axon names.
8. [x] Rebuilt both generated Pi resources, passed checks/tests, built the native binary, and smoke-tested CLI/Pi help/version in isolation.
9. [ ] Publish a fresh immutable release only after installer, auth, Pi, backup, telemetry, and update verification.

### Repository checks to run after implementation

```bash
# Regenerate resources after changing their sources.
bun run --cwd apps/cli telemetry:build
bun run --cwd apps/cli backups:build

# Normal repository checks/tests; requires each app's development dependencies.
bun run check
bun run test
bun run build:frontend

# Native Apple Silicon build and installer syntax.
bun run --cwd apps/cli build
sh -n apps/cli/install.sh
./apps/cli/dist/axon --version
./apps/cli/dist/axon --help
./apps/cli/dist/axon pi --help
```

Then test the **installed release**, not just source/dev execution:

- `axon auth login`, `axon auth status`, `axon paths`, `axon doctor pi`, `axon setup pi --sync-packages`, and `axon pi` work using the approved home.
- Pi still uses its pinned managed executable, passes user arguments in order, and preserves cwd/stdio/exit behavior; global Pi is untouched.
- Auth recovery inside an open chat still works with matching relay path and trusted markers.
- `AXON_DEBUG=1` debug output remains redacted; launcher controls do not leak to Pi.
- Renamed slash commands and backup restore work under the renamed home/S3 prefixes; cutover handling does not silently lose existing sessions.
- Release and backup configuration retain the exact existing S3 bucket names, while new object keys use the renamed paths/assets and path-based permissions cover them.
- Telemetry emits the new schema, backend identity rewriting stays authoritative, and deployed dashboard queries return data.
- Fresh installer download, checksums, signature, live/previous paths, `axon update --check`, a real update between two new-name releases, and uninstall all work.
- Re-scan for old names, excluding this audit report, intentional provenance, and any explicitly retained legacy contracts. Review matches instead of automatically replacing them.

Example residual scan (`git grep` covers tracked files only):

```bash
git grep -n -i -E 'ddcli|deputy[-_ ]?dev' -- . ':!docs/project-rename-to-loom.md'
```

**Original audit verification:** repository searches and source/config/template inspection only. **Implementation verification:** see the completed work log and local results above. Release publication, data migration, and external service/policy changes remain unperformed.

## Appendix: original pre-implementation tracked old-name matching-file inventory

This is the original audit search inventory, not a current residual scan or an instruction to hand-edit every file. The original `extensions/deputydev.ts` listed below is now `extensions/axon.ts`. Additional current files (model-cache and backup-recovery source/tests) were included by the implementation scan. Generated bundles and lockfiles must be regenerated; historical/retained files need an explicit scope decision. Indirect dependents with no old-name literal are discussed above and are not included in these lists.

### Repository / CI (8 files)

```text
.github/workflows/ci.yml
.github/workflows/release.yml
CLAUDE.md
README.md
SECURITY.md
bun.lock
docs/session-backup-and-restore.md
package.json
```

### Backend (25 files)

```text
apps/backend/README.md
apps/backend/app/__init__.py
apps/backend/app/authentication.py
apps/backend/app/clients/auth_service.py
apps/backend/app/clients/litellm.py
apps/backend/app/core/config.py
apps/backend/app/core/session_storage.py
apps/backend/app/main.py
apps/backend/app/proxies/litellm.py
apps/backend/app/proxies/otel.py
apps/backend/app/routers/browser_login.py
apps/backend/app/routers/model_recommendations.py
apps/backend/app/services/cli_releases.py
apps/backend/app/services/model_recommendation/service.py
apps/backend/app/telemetry.py
apps/backend/config_template.json
apps/backend/deployment/litellm/config.yaml
apps/backend/deployment/test_session_s3.py
apps/backend/pyproject.toml
apps/backend/tests/test_cli_releases.py
apps/backend/tests/test_litellm_identity.py
apps/backend/tests/test_otel_proxy.py
apps/backend/tests/test_product_telemetry.py
apps/backend/tests/test_session_backups.py
apps/backend/uv.lock
```

### CLI (102 files)

```text
apps/cli/.env.example
apps/cli/README.md
apps/cli/docs/launcher-plan.md
apps/cli/docs/pi-dynamic-workflows.md
apps/cli/docs/plans/cli-client-config.md
apps/cli/docs/plans/controlled-rollout-versioning-updates.md
apps/cli/docs/plans/pi-package-provisioning.md
apps/cli/docs/shipplan.md
apps/cli/install.sh
apps/cli/package.json
apps/cli/scripts/build-pi-telemetry.ts
apps/cli/scripts/build-release.ts
apps/cli/scripts/generate-release-metadata.ts
apps/cli/scripts/prepare-s3-release.ts
apps/cli/scripts/publish-s3-release.ts
apps/cli/src/build-info.ts
apps/cli/src/cli/auth/ensure-session.ts
apps/cli/src/cli/auth/preflight.ts
apps/cli/src/cli/auth/request-relay.ts
apps/cli/src/cli/auth/session-recovery.ts
apps/cli/src/cli/auth/session.ts
apps/cli/src/cli/auth/verification.ts
apps/cli/src/cli/commands/auth.ts
apps/cli/src/cli/commands/doctor.ts
apps/cli/src/cli/commands/paths.ts
apps/cli/src/cli/commands/sessions.ts
apps/cli/src/cli/commands/setup.ts
apps/cli/src/cli/commands/uninstall.ts
apps/cli/src/cli/dispatch.ts
apps/cli/src/cli/launcher-program.ts
apps/cli/src/harnesses/pi/adapter.ts
apps/cli/src/harnesses/pi/environment.ts
apps/cli/src/harnesses/pi/installation.ts
apps/cli/src/harnesses/pi/resources/extensions/deputydev.ts
apps/cli/src/harnesses/pi/resources/extensions/model-recommender.ts
apps/cli/src/harnesses/pi/resources/extensions/pi-org-telemetry.mjs
apps/cli/src/harnesses/pi/resources/extensions/session-backup.mjs
apps/cli/src/harnesses/pi/resources/extensions/web-search.ts
apps/cli/src/harnesses/pi/session-backup/index.ts
apps/cli/src/harnesses/pi/settings-defaults.ts
apps/cli/src/harnesses/pi/setup/index.ts
apps/cli/src/harnesses/pi/setup/packages/doctor.ts
apps/cli/src/harnesses/pi/setup/packages/invocation.ts
apps/cli/src/harnesses/pi/setup/packages/manifest.ts
apps/cli/src/harnesses/pi/setup/packages/state.ts
apps/cli/src/harnesses/pi/setup/packages/sync.ts
apps/cli/src/harnesses/pi/setup/resources.ts
apps/cli/src/harnesses/pi/telemetry/README.md
apps/cli/src/harnesses/pi/telemetry/docs/data-policy.md
apps/cli/src/harnesses/pi/telemetry/docs/deployment.md
apps/cli/src/harnesses/pi/telemetry/docs/limitations.md
apps/cli/src/harnesses/pi/telemetry/docs/product-telemetry.md
apps/cli/src/harnesses/pi/telemetry/docs/telemetry-schema.md
apps/cli/src/harnesses/pi/telemetry/grafana.json
apps/cli/src/harnesses/pi/telemetry/src/environment.ts
apps/cli/src/harnesses/pi/telemetry/src/identity.ts
apps/cli/src/harnesses/pi/telemetry/src/index.ts
apps/cli/src/harnesses/pi/telemetry/src/otel/managed-exporter.ts
apps/cli/src/harnesses/pi/telemetry/src/otel/product-instruments.ts
apps/cli/src/harnesses/pi/telemetry/src/otel/runtime.ts
apps/cli/src/harnesses/pi/telemetry/src/product.ts
apps/cli/src/harnesses/pi/telemetry/tests/environment.test.ts
apps/cli/src/harnesses/pi/telemetry/tests/grafana.test.ts
apps/cli/src/harnesses/pi/telemetry/tests/index.test.ts
apps/cli/src/harnesses/pi/telemetry/tests/instruments.test.ts
apps/cli/src/harnesses/pi/telemetry/tests/managed-exporter.test.ts
apps/cli/src/harnesses/pi/telemetry/tests/product.test.ts
apps/cli/src/harnesses/pi/version.ts
apps/cli/src/harnesses/registry.ts
apps/cli/src/index.ts
apps/cli/src/launcher/contracts.ts
apps/cli/src/launcher/debug-preview.ts
apps/cli/src/launcher/environment.ts
apps/cli/src/launcher/launch-harness.ts
apps/cli/src/launcher/spawn-harness.ts
apps/cli/src/product/endpoints.ts
apps/cli/src/product/identity.ts
apps/cli/src/product/manifest.ts
apps/cli/src/product/paths.ts
apps/cli/src/sessions/api.ts
apps/cli/src/sessions/backup.ts
apps/cli/src/sessions/restore.ts
apps/cli/src/telemetry/client.ts
apps/cli/src/telemetry/product-events.ts
apps/cli/src/updater/release.ts
apps/cli/src/updater/update.ts
apps/cli/tests/auth-preflight.test.ts
apps/cli/tests/auth-telemetry.test.ts
apps/cli/tests/client-config.test.ts
apps/cli/tests/installer/install.test.ts
apps/cli/tests/launcher.test.ts
apps/cli/tests/pi-client-config.test.ts
apps/cli/tests/pi-installation.test.ts
apps/cli/tests/pi-mcp-setup.test.ts
apps/cli/tests/pi-package-setup.test.ts
apps/cli/tests/pi-settings-defaults.test.ts
apps/cli/tests/pi-telemetry-bundle.test.ts
apps/cli/tests/pi-telemetry-extension-integration.test.ts
apps/cli/tests/product-telemetry-client.test.ts
apps/cli/tests/release-contract.test.ts
apps/cli/tests/session-backups.test.ts
apps/cli/tests/update.test.ts
```

### Frontend (5 files)

```text
apps/frontend/README.md
apps/frontend/config_template.json
apps/frontend/index.html
apps/frontend/package.json
apps/frontend/src/App.tsx
```
