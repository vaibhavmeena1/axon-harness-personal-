# Controlled rollout, versioning, and updates

## Why this matters

Axon ships more than one moving part: the `axon` application, the Pi version it runs, and the extensions and packages Pi uses. A change to any one of these can break the whole experience. The goal is to release **tested combinations** gradually, spot problems early, and keep a way to recover without silently changing someone else's Pi installation.

**Status:** Today, Axon has a manual release process and automatic CLI updates, but **no percentage-based rollout or automatic rollback**. The rollout approaches below are choices for future work, not features already available. This document focuses on the decision and user experience; the [shipping runbook](../shipplan.md) describes current operations.

## How updates work today

| Part | What happens now | What that means for a release |
| --- | --- | --- |
| **Axon CLI (`axon`)** | A maintainer publishes a new macOS Apple Silicon release and marks it as the latest version. Users can check for or install it explicitly. After an interactive Pi session, a silent background check may install it for the next run. | Marking a version as latest offers it to **every eligible managed installation** that checks for updates. There is no built-in 1% pilot group. Updates do not downgrade an installation. |
| **Pi application** | Each CLI release specifies one exact Pi version. Axon installs and runs its own copy when needed; it never takes over a Pi installed separately by the user. | Changing the Pi version requires shipping a new CLI release. A user who receives that CLI may need to download its Pi version on the next launch. Pi's own update command is disabled inside Axon so it cannot bypass this choice. |
| **Extensions and packages** | There are two distinct groups: Axon's own bundled resources and third-party Pi packages installed separately into Axon's Pi environment. | Own resources follow the CLI release; third-party packages follow the version rules described below. Neither changes the user's separate, globally installed Pi. |

### How our extensions and third-party packages are managed

**Axon's own extensions:** The core Axon extension, organization telemetry, and model recommender are shipped **inside the CLI release**. They are not fetched from a package registry or individually auto-updated. On a normal Pi launch, Axon places its bundled resources in a version-specific, verified location and tells Pi to load that exact set. Already-running sessions continue using their existing resources; a newer CLI brings a newer bundled set to future sessions. Changing these extensions therefore requires building, testing, and releasing a new CLI. The bundled telemetry extension is ready without a dependency download at launch and remains inactive unless telemetry export is configured.

**Third-party Pi packages:** These are required integrations maintained outside Axon and installed **separately**, using Axon's own Pi environment rather than the user's personal/global Pi. Today the required set includes an MCP adapter and a LiteLLM provider, both fixed to reviewed exact versions, plus an ask-user-question package whose version Pi or the user can manage. Axon checks locally that required packages are present, usable, and enabled in its Pi configuration. A missing or unsuitable package can be installed or repaired during an interactive online launch, or explicitly with `axon setup pi --sync-packages`. A scripted or offline launch will not download missing packages; if a required one cannot be used, it tells the user how to repair it instead of silently proceeding. Healthy launches do not check a package registry for newer versions.

The rule for each third-party package comes with the CLI release:

- **Exact:** only the reviewed version is normally accepted. Changing it requires a new CLI release. If migration fails, Axon may continue with a previously verified version that has not been revoked, with a warning; this is a fallback, not an open-ended auto-update.
- **Minimum:** a version below the declared floor needs repair, while a newer already-installed version is accepted rather than downgraded. Pi/the user owns optional upgrades.
- **Floating:** there is no Axon version pin. Pi/the user owns upgrades; Axon ensures the required package is present but does not chase the newest version in the background.

Axon preserves unrelated package settings and does not automatically remove a package a user has changed. When a newer CLI stops requiring a package, it attempts removal only when its own records identify the package and the corresponding setting has not been changed by the user. Third-party packages and their install steps can execute code with the user's permissions, which is why a rollout must test the whole CLI–Pi–package combination.

The current download checks protect against accidental corruption and verify that the downloaded binary reports the expected version. However, release URLs and checksums come from the same backend, and the macOS signature is ad-hoc. These are **not** independent publisher authentication. There is currently no signed release policy, per-user release selection, minimum-version enforcement, or `axon rollback` command. The previous binary is retained as a recovery artifact, but there is no one-command rollback experience.

### What happens when an update is available?

**Check manually:** Run `axon update --check`. On a supported release binary, it contacts the service to compare the published latest version with the running version and reports whether a newer one exists. It does not download or install anything. It is a fresh check, not a report of a cached background result.

**Install manually:** Run `axon update`. This works only from a safe, managed macOS Apple Silicon installation. It checks the same latest version; if that version is newer, it downloads the compressed release, checks both the downloaded archive and the unpacked binary, verifies the macOS code signature and reported version, then replaces the managed CLI while retaining the previous binary. The command waits and reports success, “up to date,” or an error. It will not downgrade to an older published version. `AXON_NO_UPDATE=1` disables background work, **not** this explicit command.

**Install in the background:** After a Pi process exits, the launcher may start a silent, separate update worker. This happens only for a compiled release with both terminal input and output, when `AXON_NO_UPDATE=1` is not set and the `CI` environment variable is empty or absent. It does not run on ordinary CLI commands such as `doctor` or `update --check`, and Pi startup does not wait for a binary-update request. The worker normally checks at most once every 24 hours after a successful check; after a failed attempt it can retry in one hour. If it finds a newer release, it performs the **same verification and installation**, not just a download for later approval. The completed Pi session keeps its exit status; the new CLI is used on the next invocation. Worker failures are silent. The worker does **not** currently honor Pi's offline flag, and even `CI=false` suppresses it because any nonempty `CI` value counts here.

The explicit install and background worker share a lock so they do not replace the binary at the same time. Neither installs a release that is equal to or older than the running version. If the service is unavailable, an ordinary Pi launch is not stopped by a binary-update check; a manual check/install instead reports an error. None of these paths select users by percentage: they all look at the same published latest version.

## Three approaches

### A. Release tested combinations together — recommended first

Treat a release as one tested combination of the CLI, its chosen Pi version, bundled extensions, and required packages. Try it internally or in a separate test environment; then manually make it the latest production release. Keep Pi version changes and exact package changes tied to a reviewed CLI release. Do not automatically update the user's separately installed Pi.

**Why start here:** This fits the existing updater and keeps the number of combinations small. It provides a clear manual approval point before everyone becomes eligible.

**Limit:** A test environment is not a real production percentage rollout. Once the production latest version moves, every managed client checking for updates can take it. Moving the pointer back stops new offers but does not undo updates already installed.

### B. Offer CLI releases to selected groups — recommended target

Publish and test a release first, then publish a separately authenticated **release policy** saying which installations may receive it. For example, offer it to a stable 1% group, watch results, then expand to 10%, 25%, and eventually everyone. Each CLI release still carries its own chosen Pi version and extension/package requirements; the server chooses an **eligible CLI release**, not an arbitrary Pi version or package to execute.

The policy would need to be signed independently of the download service so clients can reject forged or outdated instructions. An installation would remain in a predictable group for a given release without relying on a person's email, machine identity, or work content. A client would retain its last trusted policy for offline safety. Pausing a release would stop **new** offers, not repair installations that already upgraded. Older clients that know only about the global latest version would also need a migration plan before a percentage rollout could be called effective.

**Why consider it:** Real production canaries give time to observe problems before a global offer, while keeping Pi and extension combinations reviewable.

**Cost:** New signing and key management, client and backend changes, migration for existing installations, careful offline rules, monitoring, and tests for policy errors and interrupted updates. This is **not implemented today**.

### C. Let every component follow its own latest version — not recommended

The CLI, Pi, and each package would update independently whenever a new version appears.

**Why not:** Users could end up running combinations no one has tested, and an extension or package can execute code with the user's permissions. A Pi update could also surprise someone who expected Axon's managed copy to stay fixed. If an experimental opt-in channel is ever offered, it still needs compatibility checks and a recovery path; it should not become the default.

## What a safe rollout would look like

1. **Test the complete combination.** Test a clean installation, an upgrade from a prior release, an offline launch with already-installed dependencies, and the bundled extensions and packages on supported Apple Silicon macOS. A source-only Pi experiment does not establish that a shipped CLI combination works.
2. **Publish without offering it broadly.** Verify the exact release download, hashes, signature, and startup. Keep the existing stable version available while testing the new one. Today's production latest-version setting does not support a true existing-user canary: use a separate environment or explicit test installation until approach B exists.
3. **Expand deliberately, if approach B is built.** Start with an internal group, then 1% → 10% → 25% → 100%, with an observation window and human approval at each step. Decide in advance what counts as a failed release: for example, elevated launch or update failures. Sparse telemetry is not evidence that a release is safe, and missing telemetry must not block recovery.
4. **Pause and repair separately.** Before approach B, restore the last verified production latest version to stop offering a bad release to new updaters. With approach B, publish a newer trusted policy that stops further offers. Neither action reverts installations that already changed; those users need explicit recovery instructions or a new fixed release. Never overwrite an existing release artifact with different bytes.

## Guardrails for future implementation

- Keep the CLI as the authority for which exact Pi version and bundled resources it runs. Do not let a remote response silently swap in an unreviewed Pi version, package, command, or extension.
- Never change or delete a user's separately installed Pi. Preserve Axon's previous working versions long enough to support recovery, and make any future rollback explicit and understandable. Do not promise automatic rollback until it has been designed and tested.
- Keep normal launches fast and usable offline. An optional update check should not block a Pi session or alter its exit result. Decide and test separately what should happen if a future security policy requires a minimum version while the service is unreachable; diagnostic and recovery commands must remain available.
- Decide whether an **explicit** update should follow rollout eligibility or intentionally bypass it, and tell users which behavior to expect. Likewise, decide whether offline Pi sessions should suppress the CLI's background update check; today they do not necessarily do so.
- Protect release instructions independently from release downloads if approach B is adopted. Treat a signed policy as a decision about *which already-reviewed release* is eligible, not permission to execute arbitrary server-provided content.

**Recommended decision:** Use approach A as the immediate release discipline. Build approach B only when signed policy, observation, recovery, and a transition for existing clients are ready. Do not describe today's global latest-version setting or silent updater as a staged rollout.
