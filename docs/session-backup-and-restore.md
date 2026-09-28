# DeputyDev Pi session backup and recovery — design for discussion

**Status:** proposal, not implemented. **Primary use case:** recover work after losing a laptop; not collaborative, real-time editing. **Assumption:** DeputyDev already has user-level authentication that both the CLI and backend can use. The session endpoints, storage tables, CLI commands, and backup extension described below would still need to be built. In particular, the current backend has no session tables or session router.

## What must be preserved

A resumable Pi session is its **complete, original `.jsonl` file**, not a list of chat messages or a stream of hook events. It contains the header, all entry-tree branches, tool calls/results, compaction and context edits, extension messages, and model changes. Pi stores sessions below `${DEPUTYDEV_HOME:-~/.deputydev}/pi/sessions` when launched by `ddcli`, because the launcher sets `PI_CODING_AGENT_SESSION_DIR`. Use `ctx.sessionManager.getSessionFile()` / `getSessionDir()` when operating inside Pi; do not assume `~/.pi/agent/sessions`.

A session header records an **absolute `cwd`** (and sometimes an absolute `parentSession` path). Merely placing a backed-up file on another laptop does not make it belong to the new checkout. Also, Pi normally resumes at the **last entry in the file**, whereas an in-memory `/tree` selection can point at an earlier entry without appending anything. Capture the selected leaf ID separately from the JSONL bytes where possible.

Scope: back up DeputyDev-managed Pi sessions, not arbitrary files in the user's home or a repo. Restoring a session does **not** restore the checkout, uncommitted edits, Pi credentials, installed extensions/tools, MCP configuration, or external extension state; those require their own setup. A recovered history may mention old absolute paths in tool arguments or prompts. Never search-and-replace those message bodies: doing so would alter history and may corrupt context.

## Recommended product behavior

**Automatic push-only backups + explicit restore.** No automatic download into Pi's live session directory, no last-write-wins, and no silent import at Pi startup. Backups are tied to an authenticated user, but storage location and source project path are not used as the user's identity.

Proposed flow:

```text
Pi session file (append-only JSONL)
  -> DeputyDev-managed Pi extension notices changes
  -> validated, immutable local snapshot + retry state
  -> authenticated backend API
  -> revision metadata in Postgres + payload in [Postgres OR private object store]

New laptop: ddcli sessions list -> choose revision + local checkout
  -> download/verify JSONL -> fork into a NEW local Pi session
  -> ddcli pi --session <new-local-session-file>
```

Backups should be **opt-in or explicitly disclosed during onboarding**: the raw sessions may contain credentials, proprietary code, private prompts, and terminal output. Offer a per-user disable/pause control and `ddcli sessions status` (last successful backup, pending bytes/revisions, last error). Do not claim that an unacknowledged snapshot is backed up.

### When to back up

| Trigger | Behavior | Reason / limitation |
| --- | --- | --- |
| `session_start` | Start a bounded background catch-up scan of changed local `.jsonl` files; retry queued snapshots. **Do not pull remote files into Pi.** | Covers previous crashes/offline runs and files not visited in this process; Pi has already selected its active session at this point. Keep startup non-blocking. |
| `message_end`, `session_info_changed`, `session_tree`, `session_compact` | Mark the affected session dirty; debounce a snapshot/upload (initial proposal: 5–15 seconds). On `session_tree`, persist `newLeafId` even when JSONL bytes did not change. | Covers user input, settled messages, names, branch choices, and compaction. Do not upload one HTTP request per token. |
| `agent_settled` | Prioritize a snapshot immediately after automatic retries/queued work finish. | A good completed-work recovery point; `agent_end` alone can precede more work. |
| While Pi remains open | Reconcile dirty files and the retry queue every ~5–15 minutes; optionally checkpoint long-running turns every ~60–120 seconds using only complete JSONL lines. | A laptop can fail before an agent settles or a shutdown hook fires. Periodic work runs only while Pi/worker is alive. |
| `session_before_switch`, `session_before_fork`, `session_shutdown` | Take a final snapshot of the outgoing file and attempt a **bounded** flush; leave retry state on timeout/failure. | Include a handoff after switching, forking, or quitting without indefinitely blocking the TUI. `session_shutdown` also covers replacement/reload. |
| `ddcli sessions sync` / later launch | Explicit full reconciliation of eligible existing sessions and pending uploads, including historical sessions after first enabling backup. | Handles offline work and processes killed without hooks; do not depend solely on live extension events. |

The extension can be bundled through DeputyDev's existing embedded Pi-resource mechanism (the launcher already supplies managed extensions). Hooks only **schedule** work: they are not a complete transcript. Implementation alternatives:

| Sync engine | Liberties / advantages | Limitations |
| --- | --- | --- |
| **Pi extension does snapshot + upload** | Fastest to ship; captures exact active leaf and reacts to Pi's lifecycle. | Network and credentials share the Pi process; only runs while Pi is alive; keep handlers short and transfers non-blocking. |
| **Launcher/independent worker scans files** | Transfers survive Pi exit and can sweep all sessions; Pi need not hold network credentials. | Needs supervised lifecycle, ownership/locking, wake-up mechanism; cannot infer an unpersisted `/tree` leaf from the file alone. |
| **Hybrid: extension signals, worker uploads** | Captures leaf/event context while isolating transfers and retries; independent reconciliation. | IPC and two-process deployment complexity. Stronger operational fit if uploads become expensive. |

Start with the simplest viable option and keep the queue format transferable to a worker. Do not inject account bearer tokens into session text, Pi tool output, or a logged environment variable; use the existing secure CLI credential store or an authenticated local worker. All Pi extensions run in the user's process, so loading untrusted extensions is already a trust boundary.

Skip `--no-session`/in-memory sessions and header-only sessions with no persisted file. A startup scan must be limited to DeputyDev's own session root, ignore symlinks/non-regular files, have a work/size limit, and never delay opening Pi. A byte-for-byte hash of the **raw JSONL** plus the selected leaf ID identifies a changed checkpoint; size/mtime may cheaply screen candidates but are not authoritative. Keep per-file local upload state under `${DEPUTYDEV_HOME}` with owner-only permissions, including the last **server-acknowledged** revision, selected leaf, and an on-disk pending snapshot or a retryable reference. Never advance the checkpoint on a failed request. To bound local disk usage when offline, coalesce unacknowledged snapshots **per stream** to the latest complete full-file snapshot while retaining the last acknowledged revision/reference; do not discard a snapshot during an in-flight transfer until its replacement is durably staged. Use bounded concurrency, exponential backoff with jitter, and clear 401/403 re-login messaging. Network loss must not fail the Pi session.

Before upload, freeze a file snapshot rather than streaming a file Pi may still be appending to. Accept only a valid header and complete, parseable newline-terminated entries; if a concurrent append leaves an incomplete tail, retry or checkpoint the last complete prefix. Apply limits on bytes, lines, and decompressed size. Hash the exact uncompressed bytes; compression is a transport/storage choice. Backend should reject malformed/oversized input and untrusted client metadata, and must not rewrite the JSONL or treat arbitrary JSONL content as code. A validated snapshot may legitimately end mid-turn: restore must expose that fact, and Pi should resume from the last persisted state rather than pretend the run completed.

**Recovery point objective (proposal, not a guarantee):** after a successful online settled-turn upload, the complete turn is recoverable; during a long run, loss is bounded by the periodic checkpoint interval **if** that checkpoint reached the server. Offline/unacknowledged work cannot be recovered after disk loss. `SIGKILL`, power failure, full disk, and failed network calls cannot be repaired by shutdown hooks.

### Backend identity, revisions, and consistency

Use an opaque **backup stream ID** assigned to each local session file, scoped to the authenticated user. Record the Pi header ID, source installation/device ID, optional non-sensitive project label, Pi/session-format version, and provenance separately. Neither absolute `cwd` nor basename is a safe remote key; two users/devices can have the same paths or session IDs. After restore, the new Pi session gets a **new stream ID** linked to the source stream/revision; it does not continue overwriting the original machine's stream.

Each accepted checkpoint is a **new immutable revision** with `revision_id`, stream ID, `parent_revision_id`/expected head, SHA-256 of raw JSONL, byte length, selected leaf ID (nullable), whether that leaf value was actually captured, originating device, server timestamp, and storage locator. The `leaf_known` bit distinguishes a known root selection (`null`) from an unknown leaf (also `null`). Keep a pointer to the latest committed revision. If the **head** already has identical bytes and leaf state, return it without another upload; do not use a matching older revision to bypass a head conflict. Generate a stable idempotency key for retries. When two devices submit different descendants of the same head, use compare-and-swap on the head, **never mtime**: retain the losing payload as a divergent revision (not the head), return a conflict, and create a separate stream/fork for subsequent backups or let the user resolve it. No device may silently overwrite another revision. Server time is for ordering/display, not conflict authority.

Proposed API shape (illustrative; endpoint names and JSON contracts are not final):

```text
GET    /api/v1/sessions?cursor=...                    # own streams, paginated metadata only
POST   /api/v1/sessions                               # create a stream / declare provenance
GET    /api/v1/sessions/{streamId}/revisions           # own revisions and conflicts
POST   /api/v1/sessions/{streamId}/revisions           # direct-upload variant: body + hash, leaf, expected head, idempotency key
GET    /api/v1/sessions/{streamId}/revisions/{id}/data # download exact original JSONL (or short-lived signed GET)
DELETE /api/v1/sessions/{streamId}                     # explicit user deletion, policy-driven retention
```

For the bucket variant, replace the direct `POST` with `POST .../uploads` (reserve an upload and return a tightly scoped, short-lived signed PUT) and `POST .../uploads/{id}/commit` (verify object checksum/size, then commit revision and CAS head). An abandoned reservation must not appear as a restorable revision; expire it and garbage-collect orphaned objects. Sign **server-generated**, user-scoped, write-once keys only, bind PUT to the declared checksum/length where supported, and deny overwrites; use a dedicated private prefix/bucket. Do not reuse the public CLI-release bucket/policy or make uploaded objects publicly cacheable.

Every route derives owner/tenant from the validated auth context, not a supplied user ID. Enforce ownership on both stream and revision before returning metadata, bytes, or URLs; paginate lists, rate-limit, cap account quota/file sizes, disable caches (`Cache-Control: no-store`), and log IDs/status/byte counts **not bodies, filenames, absolute paths, signed URLs, or tokens**. The payload hash verifies integrity, not that a compromised server has not tampered with both bytes and metadata. Agree separately on encryption at rest, KMS access, backups, retention, and account-deletion behavior.

A possible **conceptual** Postgres schema (not a migration):

```text
session_streams(id UUID PK, owner_id <auth subject type>, pi_session_id TEXT,
                device_id TEXT, project_hint TEXT, source_stream_id UUID NULL,
                source_revision_id UUID NULL, head_revision_id UUID NULL,
                created_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ NULL)
session_revisions(id UUID PK, stream_id UUID FK, parent_revision_id UUID NULL,
                  idempotency_key TEXT, sha256 TEXT, raw_size BIGINT,
                  selected_leaf_id TEXT NULL, leaf_known BOOLEAN, storage_kind TEXT, payload BYTEA NULL,
                  object_key TEXT NULL, state TEXT, created_at TIMESTAMPTZ,
                  UNIQUE(stream_id, idempotency_key))
```

Use a row lock/transaction to compare and advance `head_revision_id`. Preserve conflict rows; represent pending object-store uploads separately or with an explicit `pending` state. Store only **one** of `payload` or `object_key` for a committed revision. Index by `(owner_id, created_at)` and `(stream_id, created_at)`, and keep provider details hidden from API consumers. Avoid plaintext previews by default; even a session name or repo identifier can be sensitive.

## Payload storage approaches

Both choices use **Postgres for ownership, searchable metadata, revision lineage, and concurrency control**. Both can serve the same restore API. Choose after measuring raw/compressed file sizes, number of sessions/user, revision frequency, expected retention, and available backup infrastructure.

| Choice | Liberties / advantages | Limitations / obligations | Fit |
| --- | --- | --- | --- |
| **A. JSONL bytes in Postgres (`bytea`, optionally compressed)** | One transactional write for body + metadata + head; one access-control/backup system; easy local development and atomic restore visibility; no object-store credentials or orphan cleanup. | Repeated full-file snapshots grow TOAST, WAL, replicas, logical dumps, restore times, and DB backup bills; DB serves large uploads/downloads; retention and vacuum/partitioning need care; enforce strict per-file/account quotas. | Small pilot / low data volume, fastest implementation. |
| **B. JSONL blob in private S3-compatible bucket; metadata in Postgres** | Cheap scalable blob storage, lifecycle/retention/versioning policies, object checksum/replication, direct signed uploads/downloads keep large bodies off API and DB; backend keeps authorization/indexes. | Two-phase upload/commit with no cross-system transaction; pending/orphan cleanup; bucket permissions, KMS/CORS, short-lived signed URLs, checksum verification, cleanup and DB/object backup coordination; more operational complexity and direct-client network requirements. | Larger or long-lived backups; aligns with the backend's existing S3 tooling but requires a **separate private session policy**. |
| **C. Hybrid (optional later): recent snapshots in Postgres, older revisions in object storage** | Fast metadata + hot restore, cheaper cold retention. | Migration between tiers, dual implementations, partial failures, harder restore/deletion and testing. | Only if real usage justifies it; not an MVP starting point. |

An **append-only delta/chunk** protocol is a separate transport optimization, not a different source of truth. It can reduce repeat transfer of growing files, but introduces replay/base-revision dependencies, extra corruption modes, and more difficult retention/restore. Start with whole-file immutable snapshots (gzip/zstd if useful), deduplicate by hash, then evaluate chunking after measuring usage. Do not use Pi's `--mode json` event stream or `/export path.jsonl` as the backup payload: the first is event telemetry, while the latter serializes only the active branch rather than the entire original tree.

**Decision suggestion:** pick A for a narrowly capped pilot if sessions are small and DB capacity is comfortable; choose B if session files or retention are expected to be large. Implement a storage adapter so the CLI protocol and restore UX do not depend on that choice. Decide size/quota and retention policy before launching either.

## Import / restore: three product choices

| Behavior | Benefit | Cost/risk | Recommendation |
| --- | --- | --- | --- |
| **Manual, selected revision**: `ddcli sessions list`, `ddcli sessions restore <stream-or-revision> --cwd <checkout>`; optional console list/download. | User chooses the correct checkout and point in time; original and conflicts remain intact; minimal surprise on new laptop. | One extra recovery step; needs a usable authenticated CLI and a checkout prepared locally. | **Default.** Offer `ddcli sessions sync` to catch up local backups; never silently pull. |
| **Opt-in bulk import**: preview remote sessions, map projects/checkouts, then import many as new local forks. | Convenient after replacing a whole device. | Many wrong project mappings, duplicates, large downloads, conflicts, storage cost. | Later, with preview, explicit confirmation, and dedupe. |
| **Automatic pull into Pi session directory on login/startup**. | Remote sessions appear immediately in `/resume`. | Old absolute cwd and parent links, loaded session not refreshed in memory, stale files, ID/path collisions, concurrent edits and unintended model/tool context. | **Do not use** for disaster recovery. |

Recommended single-session restore algorithm:

1. Authenticate and list the user's **metadata**; choose an immutable revision (latest by default, or a historical/conflict revision). Display source time/device/project hint and any incomplete-turn warning. Avoid exposing old absolute paths by default.
2. Require an existing **local checkout directory** (`cwd`) and confirm the project; never trust a path from the remote header as a local destination. No implicit filesystem edits to the checkout.
3. Download to an owner-only local import archive/staging directory outside the live Pi session directory. Verify length, SHA-256, header/entry validity, format compatibility, and that the selected leaf ID exists (if present). Retain the imported source file if Pi's `parentSession` lineage should remain resolvable.
4. Call Pi `SessionManager.forkFrom(downloadedFile, newCwd, localSessionDir)` (or the pinned version's equivalent) to create a **new** header/session ID with the new `cwd`, while copying the complete tree. Do not alter the downloaded revision or overwrite a local session. If a known selected leaf differs from the last file entry, call `branch(selectedLeafId)` on the **new** manager (or `resetLeaf()` for a known root/null selection) and append a small DeputyDev `custom` entry to anchor that choice durably. Simply calling `branch()` is not enough because a later Pi reopen resets the leaf to the last persisted entry. If no leaf was captured, let Pi use its normal last entry or ask the user to select a branch with `/tree`. Exercise this against the pinned Pi version.
5. Launch `ddcli pi --session <new-local-session-file>` from that checkout (or use Pi's session runtime to switch with fresh cwd-bound resources). Record source stream/revision provenance in DeputyDev's local sync state; its subsequent backups form a **new stream**, never a write to the old revision.

Pi also has `/import <path.jsonl>` and can open with a cwd override, but those operations do not by themselves create a new portable header and preserve the selected leaf in the way this flow needs. A CLI restore **before** launching Pi is the simplest reliable entry point; an in-Pi `/deputydev-restore` command can be added later using command-only session replacement APIs. Do not write into an already-open Pi file and expect its in-memory session to refresh. A plain `--fork` from a downloaded file is a useful fallback, but test how it handles the selected leaf and provenance.

### Sharing/exporting (independent, optional feature)

Backups are private, resumable data. **Sharing is a separate explicit action**, not a flag that makes a backup object public.

- **HTML**: generate Pi's self-contained `/export` viewer on demand from the chosen local/recovered revision, or offer a backend conversion service if required. Useful for reading branches and tool output in a browser; includes embedded JSON data and a JSONL download button, so treat it as disclosure of the *whole session*, not just visible text. An HTML viewer is not the default restore artifact.
- **JSONL**: let the owner download exact backed-up bytes for portable manual import; optionally offer a branch-only or redacted export clearly labeled **not a full backup**. Existing Pi `/export path.jsonl` is branch-only. If another person must resume a shared session, give them an explicit fork/import workflow, never access to the owner's mutable stream.
- **Links** (later): private named-user read grants or expiring revocable bearer shares, scoped to one immutable revision, with audit/expiry/download controls. Sharing with a public link requires explicit warnings and should be off by default. Serve any untrusted exported HTML as an attachment or on an isolated origin/sandbox, never unsandboxed on the authenticated console origin. Never expose the backup bucket directly as public or reuse Pi's built-in `/share` (which uses its own provider) as the DeputyDev backup mechanism.

## Rollout, checks, and open decisions

1. **Pilot:** choose Postgres or bucket, quotas and retention; add auth-scoped revision API, immutable storage, checksums, and a CLI manual `sync/list/restore` flow. Make the original JSONL the source of truth. Use a feature flag and explicit privacy notice.
2. **Automatic backups:** embed the managed Pi extension and persistent retry queue. Add unobtrusive status and explicit pause. Reconcile historical sessions in the background with consent; do not block Pi startup.
3. **Optional:** web listing/sharing, bulk restore, object-store tiering or deltas after usage is measured.

Acceptance tests: different OS username and checkout path; resume after restore and append a new turn; multiple branches/compactions/context edits and a non-last selected leaf; two devices editing copies of the same source; repeated/idempotent uploads; offline then reconnect; interrupted append/upload/commit; SIGKILL; 401/403 and revoked auth; corrupt/malformed/oversized JSONL; duplicate Pi IDs; wrong project mapping; bucket object missing while metadata exists; deleted account/expired revision; HTML and JSONL sharing restricted to the intended recipient. Check that auth tokens and transcript bodies never reach logs or telemetry. Validate all SDK/hook behavior against DeputyDev's **pinned** Pi version before implementing.

**Decisions to settle:** (1) opt-in/default and privacy disclosure, (2) Postgres-only pilot vs private object store, (3) snapshot/retention limits and restore RPO, (4) whether to provide a local authenticated worker from day one, (5) sharing policy and recipient model. None of these requires changing the core recommendation: immutable push backups plus explicit cross-machine fork-on-restore.

## Existing integration points

- CLI session paths: [`apps/cli/src/product/paths.ts`](../apps/cli/src/product/paths.ts), [`apps/cli/src/harnesses/pi/environment.ts`](../apps/cli/src/harnesses/pi/environment.ts).
- Managed Pi extension packaging: [`apps/cli/src/product/manifest.ts`](../apps/cli/src/product/manifest.ts), [`apps/cli/src/harnesses/pi/setup/resources.ts`](../apps/cli/src/harnesses/pi/setup/resources.ts).
- Backend application/database: [`apps/backend/app/main.py`](../apps/backend/app/main.py), [`apps/backend/app/listeners/database.py`](../apps/backend/app/listeners/database.py), [`apps/backend/db/migrations/`](../apps/backend/db/migrations/).
- Pi reference: `docs/session-format.md`, `docs/sessions.md`, `docs/extensions.md`, `docs/sdk.md` in the pinned `@earendil-works/pi-coding-agent` package, plus its `SessionManager.forkFrom()` and `AgentSessionRuntime` implementations.
