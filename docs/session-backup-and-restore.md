# Session backup and restore

This is the current implementation and operations reference for Axon session backups. It replaces the earlier proposal, implementation plan, and separate operations notes.

**Repository state:** the CLI commands, managed Pi extension, owner-bound local queue, backend API, Postgres migration, private-object transport, restore helper, and reconciliation command are implemented. Backups default to **off** and are enabled only by the administrator’s backend `config.json` boolean, `SESSION_BACKUPS.ENABLED=true`. There is no per-user opt-in or disable switch. Implementation and local tests do not establish that a deployed bucket, database, scheduler, or pilot is ready.

## 1. Contract and scope

| Concern | Current behavior |
| --- | --- |
| Supported production adapter | `harness=pi`, `session_format=pi-jsonl`, `session_format_version="3"` |
| Managed Pi runtime | **1.1.0**, pinned in [`apps/cli/pi-version.json`](../apps/cli/pi-version.json); restore loads that managed package, not global Pi |
| Backup artifact | Complete original JSONL bytes: header, all branches, messages, tool calls/results, compactions, model changes, thinking, embedded media, and opaque fields |
| Remote retention | One latest committed checkpoint per stream, not revision history |
| Size limits | Raw: **100 MiB / 104,857,600 bytes**; stored: **101 MiB / 105,906,176 bytes** |
| Encoding | API accepts `identity` or `gzip`; the Pi capture implementation stages gzip |
| Ownership | Verified auth-service `user_team_id`, never a client-supplied user, device, path, or email |
| Capture scope | Regular files inside `${AXON_HOME:-~/.axon}/pi/sessions`; no symlink following or global-Pi import |
| Restore | Explicit download and new local fork into an existing user-selected checkout; never overwrite an active session or pull automatically |

A successful local capture or S3 PUT is **not** a confirmed backup. The recovery point is the latest backend-committed lifecycle/manual checkpoint, not the last turn or token. Pending-only data is lost if the source machine is lost before a successful retry. A replacement keeps the previous checkpoint visible until validation and commit succeed; afterward, the old checkpoint is not available for historical restore.

The schema and transport are harness-neutral. The backend dispatches validators by `(harness, session_format, session_format_version)`. Only Pi is registered for production; a structurally different JSONL adapter exists in tests. Supporting another harness requires capture, validation, and restore adapters, not Pi-specific database columns or acceptance of arbitrary JSONL.

## 2. Administrator policy and user commands

Configure private storage, set `"ENABLED": true` inside `SESSION_BACKUPS` in the **backend `config.json`**, and restart the backend. `SESSION_BACKUPS.ENABLED` is the only backup policy switch. Only JSON booleans are accepted; omitted defaults to false and invalid values fail startup. Environment variables cannot override it. Managed clients discover the policy through authenticated `/api/v1/sessions/status` and capture automatically when enabled. A launcher environment variable cannot override it.

Users log in with `axon auth login`. They can inspect status, retry repaired queues, list, restore, and delete backups, but cannot enable, disable, or pause the administrator policy:

```sh
axon sessions                                # interactive guided menu
axon sessions status
axon sessions retry                           # clear reviewed/repaired queue errors

axon sessions list
axon sessions restore SESSION_UUID --cwd /existing/local/checkout
axon sessions restore SESSION_UUID --cwd /existing/local/checkout --yes
axon sessions delete SESSION_UUID             # interactive confirmation
axon sessions delete SESSION_UUID --yes
```

Bare `axon sessions` opens a guided menu in a terminal (with first-run browser login when needed). Browse/search sessions by title, local-time backup date, or ID, select a backup, and choose an existing checkout for restore. The checkout defaults to the current directory; relative paths and `~/` are supported and invalid/non-directory paths are rejected inline. Restore confirms the latest pinned download metadata through the same safe restore flow; deletion also requires explicit confirmation. Both default to **No**. Cancelling any prompt exits safely; **Back to menu** and **Done** allow navigation. Status and retry are available from the menu too. Explicit subcommands keep their existing scripting behavior, and bare `sessions` fails with usage guidance in non-TTY/CI runs.

Managed Pi exposes:

```text
/axon-backups retry | status
/axon-backup-now
```

- Backups include source code, pasted secrets, terminal output, prompts, tool arguments/results, thinking, and embedded images. There is **no transcript redaction or client-side encryption layer** in this implementation. Session names are also private metadata.
- The first enabled policy check automatically binds the local queue to the verified membership and compiled backend origin. A different account/origin does not inherit the old account’s queue. Local settings do not contain an enable/disable policy.
- Only the administrator can stop backups, by setting `SESSION_BACKUPS.ENABLED=false` in backend config and restarting. Existing local snapshots are retained; previously issued signed URLs cannot be instantly revoked. Missing/unavailable policy fails closed: no new capture or upload is attempted until the backend is reachable.
- `retry` clears queue error flags for compatible streams of the original verified account. Unrecoverable or busy streams remain untouched/paused and are reported rather than preventing healthy streams from retrying. It does **not** immediately upload: work resumes at a later lifecycle/manual boundary. A changed remote stream still requires a local fork.
- The Axon header shows a compact live `Backup:` indicator (checking, syncing, saved, pending, paused, off, or on). It updates as lifecycle/manual work finishes; “saved” means an acknowledged checkpoint, not continuous per-message backup. Backup hints and detailed queue status are not pinned in the footer.
- `status` checks backend policy and reports last acknowledged backup, pending stream count, and paused stream count. Incompatible, corrupt, unsafe, or busy queue entries are reported as local queue issues without hiding healthy streams. Policy discovery requires a reachable authenticated backend with ready private storage; queue counts and last confirmation are still local.
- `list` follows backend pagination and shows full committed IDs, names or first-user-message titles, local-time backup dates, and human-readable raw sizes. Harness/format internals are hidden. It does not download transcript objects or return the original cwd.
- `restore` prints a launch instruction; it does not launch Pi automatically. Listing/restoring/deleting owned backups requires the backend storage service to be enabled, but no separate local consent.
- Remote deletion hides the stream immediately. Cleanup is asynchronous, and previously issued URLs cannot be instantly revoked; their maximum configured lifetime is five minutes.

### Lifecycle behavior

| Trigger | What happens |
| --- | --- |
| `session_start` | Detached, best-effort capture of the selected persisted session and retry of existing queues for the same account/origin |
| `session_shutdown` | Capture the outgoing session, durably stage it, and await a bounded network attempt; older in-process transfers are aborted before shutdown work proceeds |
| `session_tree` | Write tiny selected-leaf sidecar metadata only; no full-file capture or upload |
| `/axon-backup-now` | Capture and attempt commit, reporting committed versus pending/paused state |
| Message, token, turn, or periodic timer | No capture/upload hook |

The extension reads path, native ID, and selected leaf synchronously from the live context, then serializes work using those plain values. Startup errors are non-fatal; ephemeral, absent, and header-only files are skipped. There is no launcher-exit backup worker, standalone `axon sessions sync`, historical scan/import, or transfer process that survives Pi exit.

Each boundary uses a shared **15-second network/cancellation signal**. Private copying, validation, compression, and filesystem work are not governed by a hard wall-clock timeout. In particular, shutdown staging can take longer for large files; bounded network work is not a guarantee of fast shutdown or successful transfer.

## 3. Local capture, queue, and account isolation

Local state is separate from live Pi sessions:

```text
${AXON_HOME:-~/.axon}/session-backups/
├─ settings.json                      # account binding: origin, owner, credential fingerprint
├─ device.json                        # random installation-scoped UUID
├─ <hash(origin + owner)>/
│  └─ <hash(source path + native ID)>/
│     ├─ state.json                   # local/remote identity, token, pending/next, status
│     ├─ selected-leaf.json           # tree-selection sidecar
│     └─ <request-file>.jsonl.gz       # immutable pending checkpoint bytes
└─ archives/restore-*/                # verified restore payload, original JSONL, provenance
```

Locks and temporary staging files also live here. Directories are `0700`, files `0600`. JSON queue pointers/account bindings are written with atomic rename and file/directory fsync. Source path hashes are local queue locators, not remote ownership.

Capture opens the managed file without following symlinks, copies the observed bytes privately, and checks inode/device, size, mtime, and ctime for changes. It retries a changing file up to three times. It requires complete newline-terminated, strict UTF-8 JSONL; incomplete tails are retried later rather than truncated. Malformed records, unsupported versions, invalid tree/leaf references, unsafe paths, and oversized captures do not become backups.

Validation preserves native bytes; it does not rebuild a transcript or export only the current branch. The raw and compressed files receive independent SHA-256 hashes and sizes. Capture includes the selected branch/root separately:

```json
{"leaf_known": true, "selected_leaf_id": "entry-id"}
```

A known root is `{"leaf_known": true, "selected_leaf_id": null}`; an unknown selection is `{"leaf_known": false, "selected_leaf_id": null}`. Known non-root leaves must belong to the captured tree.

Each stream retains at most one uncertain request (`pending`) and one coalesced newer checkpoint (`next`). Duplicate raw content/name/version/resume state is a no-op. A superseded `next` file is removed only after its replacement pointer is durable. A confirmed request is removed only after acknowledged state is durable; newer queued work can wait for the next boundary rather than forcing a second full upload.

An older **unsubmitted `next`** snapshot missing only `display_name` is repaired under its stream lock when status, retry, or lifecycle work reads it. Repair uses a private copy of the queued archive, verifies stored/raw hashes and sizes with bounded decompression, validates the Pi identity/tree/selected leaf, and extracts the native session name or first-user-message fallback. Only metadata is atomically updated; payload bytes, request IDs, tokens, and queue pointers are preserved. A declaration already in `pending`, or a `next` carrying an expected token, is never rewritten automatically because it may already have reached the server. Failed repair retains all original files and reports that stream as paused. Local-state errors are distinguished from backend authentication/storage errors in Pi notifications.

Network/storage failures retain pending state. Invalid/oversized/unsafe capture and API access, validation, or stale-token failures can pause the stream for explicit review. Lost commit responses are reconciled against remote state; an uncertain old checkpoint is not blindly submitted under a new UUID. A stale remote token does not silently replace another client's newer checkpoint.

The client uses the shared encrypted Axon credential store and compare-and-swap refresh handling. It verifies membership before sync, checks credentials before chaining API calls and before object PUT, and rechecks administrator policy and ownership immediately before object transfer. Tokens are not placed in queue jobs or transcripts and are never sent to S3. Managed launches supply trusted `PI_AXON_BACKUP_SERVICE_ORIGIN` and `PI_AXON_BACKUP_HOME` markers through the final environment filter; the extension does not rely on ambient `AXON_HOME` reaching Pi.

### Session names

`display_name` is required but nullable in snapshot declarations and is committed explicitly as `VARCHAR(256)` metadata. An explicit Pi name takes precedence: use the **last `session_info.name` in file order**, regardless of selected branch. When that name is missing, blank, or cleared, fall back to the **first non-empty user message text in file order**, joining text blocks and ignoring images, system/assistant/tool messages and context edits. This fallback stays stable as the append-only conversation grows; no model-generated title or separate first-message column is needed. Sessions without either source remain `null`.

The display copy replaces control characters, unpaired surrogates, and Unicode line separators with spaces, trims whitespace, and caps at 256 Unicode code points. Original JSONL bytes remain unchanged. The backend independently extracts and verifies the name before commit. Failed/pending renames never replace the previous committed name. Names participate in replay/no-op checks and must stay out of logs and telemetry. First-message excerpts are private listing metadata too.

`axon sessions list` shows full IDs, human-readable backup dates in the machine’s current timezone (named in the heading), compact sizes, and single-line titles truncated to fit the terminal. Narrow terminals use stacked entries so full IDs do not crowd out useful titles. Harness/format internals are not shown. Listing reads only DB metadata, never transcript objects. Existing unnamed backups acquire the fallback title on their next successful backup; there is no automatic remote backfill. Older unnamed backups remain restorable.

## 4. Backend API and commit protocol

The router is registered under `/api/v1/sessions`. All operations use the shared authenticated-user guard and verified membership ownership, with `Cache-Control: no-store`. Disabled/unavailable private storage returns `503`. POST metadata bodies are capped at **16 KiB**; validation errors are sanitized rather than reflecting submitted content.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/v1/sessions/status` | Verify owner and storage readiness; advertise formats and size limits |
| POST | `/api/v1/sessions` | Idempotently register immutable stream identity |
| GET | `/api/v1/sessions` | List only owned, nondeleted streams with committed objects |
| POST | `/api/v1/sessions/{id}/backup-upload` | Reserve a replacement and issue conditional PUT instructions, or return committed/no-op state |
| POST | `/api/v1/sessions/{id}/backup-finalize` | Validate the object and atomically commit the latest pointer |
| GET | `/api/v1/sessions/{id}/backup-download` | Return pinned latest metadata, opaque object ID, and short-lived GET URL |
| DELETE | `/api/v1/sessions/{id}` | Tombstone the stream and attempt object deletion |

List pages default to 50, maximum 100, ordered by `updated_at DESC, id DESC`. The `next` cursor contains `before` and `before_id`; supply both together, with a timezone-aware timestamp.

Registration declares `client_session_key`, `device_id`, `harness`, nullable `harness_session_id`, and `session_format`. Retrying the same owner/client key must match these immutable fields. The installation device UUID is provenance, not authentication. Restore/fork uses a new native ID and a new stream on the destination installation's device.

Upload declarations contain a stable `request_id`, `expected_token`, `capture_reason` (`session_start`, `session_shutdown`, or `manual`), and `snapshot`:

```text
snapshot = display_name, raw_sha256, stored_sha256,
           raw_size_bytes, stored_size_bytes, encoding,
           session_format_version, resume_metadata
```

Hashes are lowercase 64-hex SHA-256; identity encoding requires matching raw/stored hashes and sizes. Resume metadata is a bounded JSON object (4 KiB), validated by the adapter.

### Replacement sequence

1. Under a stream row lock, check tracked request replay before token/no-op checks. Reject changed declarations for an already tracked UUID. Validate supported adapter, resume metadata, sizes, and expected token.
2. If raw hash/size, display name, format version, and resume metadata already match the latest checkpoint, return `already_current` without PUT. Encoding differences alone do not require replacement.
3. Otherwise persist one pending reservation with a fresh server-generated key, expected token, expiry, and immutable snapshot declaration **before** issuing a PUT URL. Another active reservation conflicts; expired slots can be replaced.
4. The client uploads frozen bytes directly to S3 using signed checksum, length, content type, and `If-None-Match: *`. No Axon bearer token goes to storage. A conditional `412` on retry proceeds to finalization instead of overwrite.
5. Finalize reads the object and verifies stored/raw hashes and sizes, bounded decompression, JSONL structure, native identity, selected leaf, and display name. This happens within the API request, off the event loop and outside a DB lock—not in a durable validation-job service.
6. Reacquire the row lock and recheck deletion, request/key/declarations, expiry, and token. Atomically commit the pointer/metadata, record `last_committed_request_id`, rotate the opaque token, and clear pending fields.
7. Attempt deletion of the previous object after commit. Crashes/failed deletes leave reconciliation work, not a second user-visible revision.

Only the pending request and latest committed request are remembered. Same-request finalize races and a lost commit response return the committed result. Once a later checkpoint replaces it, older request IDs are no longer an idempotency ledger; clients must reconcile. Changed remote tokens return `409`, not last-write-wins or retained conflict branches.

The service permits two simultaneous validations per process. Registration/reservation/finalization share a bounded owner-keyed **30 requests/minute per-process** guard. Multiple backend workers need an authenticated owner-keyed edge/global limiter; there is no aggregate account storage quota in this implementation.

## 5. Database and migration safety

[`20261002140000_create_sessions.sql`](../apps/backend/db/migrations/20261002140000_create_sessions.sql) creates one quoted table, **`"META_HARNESS_sessions"`**, with a physical FK to existing **`public.user_teams(id BIGINT PRIMARY KEY)`**, using `ON DELETE RESTRICT`. The migration fails if that prerequisite is absent/incompatible. It does not create a second membership table or migrate legacy chat data.

The row holds:

- Owner, client stream key, harness/native identity, device, and format.
- An always-present opaque `update_token`.
- Latest object key, display name, raw/stored integrity fields, encoding, format version, resume JSON, latest request UUID, and backup timestamp.
- One grouped pending reservation: request/key/expected token/expiry plus snapshot JSON.
- Creation/update timestamps and deletion tombstone.

Constraints enforce unique `(owner_user_team_id, client_session_key)`, all-or-none current/pending groups, byte/hash/encoding limits, and bounded JSON. Owner/pagination, pending-expiry, and deletion indexes are prefixed. Pi leaf/version semantics belong in the adapter, not Pi-specific SQL columns. The Tortoise model maps membership as a scalar BIGINT; the SQL migrations own the physical legacy FK.

Apply reviewed migrations through the deployment runner, only against the intended configured database:

```sh
cd apps/backend
uv run --frozen python -m deployment.run_migrations
```

The Python runner uses the existing asyncpg dependency, a separate `META_HARNESS_schema_migrations` ledger, and a PostgreSQL advisory lock to serialize concurrent runners. Each migration and its ledger update commit atomically. It never dumps schemas or requires dbmate. To roll back the latest migration, run `python -m deployment.run_migrations down`. Migration `down` refuses while object/pending pointers remain: finish object/tombstone cleanup first.

To regenerate application-only DDL without inspecting a populated application database:

```sh
cd apps/backend
uv run --frozen python -m deployment.generate_session_schema \
  --admin-url postgresql://localhost/postgres
```

This creates/drops a uniquely named disposable database with a minimal membership fixture and prints schema SQL. Review before replacing `db/schema.sql`; the dump does not own the legacy membership table.

## 6. Private object storage configuration

[`config_template.json`](../apps/backend/config_template.json) has a separate storage section with an empty bucket and no embedded credentials. The section configures both storage and administrator policy; its `ENABLED` boolean is the only switch that enables the service:

```json
{
  "SESSION_BACKUPS": {
    "ENABLED": false,
    "REQUIRE_CREATE_ONLY_POLICY": true,
    "S3": {
      "BUCKET": "",
      "REGION": "ap-south-1",
      "ENDPOINT_URL": null,
      "CREDENTIALS": {},
      "CONNECT_TIMEOUT_SECONDS": 5,
      "READ_TIMEOUT_SECONDS": 10,
      "MAX_RETRIES": 1
    },
    "KEY_PREFIX": "axon/sessions/",
    "URL_SECONDS": 300,
    "RESERVATION_SECONDS": 900,
    "CLEANUP_GRACE_SECONDS": 3600
  }
}
```

Use a dedicated private **unversioned** bucket, not the CLI release-distribution policy. Provision it and replace the empty bucket in private runtime config before enabling. Prefer an IAM role or the SDK's standard credential chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`). Private JSON also accepts those credentials as `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, and `SESSION_TOKEN` under `S3.CREDENTIALS`, plus an optional HTTPS-origin `S3.ENDPOINT_URL`. Timeouts are bounded to 1–300 seconds; `MAX_RETRIES` is 0–10 additional attempts (`null` uses SDK/environment defaults). The session defaults remain 5/10 seconds and one retry. Releases use the same `S3` configuration shape but a separate client, credentials and bucket policy. Do not commit credentials or put them in diagnostic output. Restart the backend after configuration changes.

Safety checks run before API operations, cached for 60 seconds per service instance:

- All four bucket S3 Block Public Access flags must be enabled.
- Enabled **or suspended** versioning is rejected: ordinary DELETE must not retain historical object versions.
- No enabled current-object expiration rule may overlap the session namespace. A latest checkpoint must not disappear just because it is old.
- With `REQUIRE_CREATE_ONLY_POLICY=true`, the bucket policy must include namespace-specific deny statements for a missing `s3:if-none-match` and a value other than `*`. The checker expects the exact namespace resource and condition shapes below, not arbitrary equivalent policies.

Merge these denies into an operator-reviewed bucket policy, replacing bucket and prefix. They **do not grant** the backend any permission. The TLS deny is a recommended additional control; the runtime checker specifically verifies the two conditional-write denies.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SessionsRequireConditionalCreate",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/axon/sessions/*",
      "Condition": { "Null": { "s3:if-none-match": "true" } }
    },
    {
      "Sid": "SessionsRequireCreateOnlyValue",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::YOUR_PRIVATE_BUCKET/axon/sessions/*",
      "Condition": { "StringNotEquals": { "s3:if-none-match": "*" } }
    },
    {
      "Sid": "SessionsRequireTLS",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::YOUR_PRIVATE_BUCKET",
        "arn:aws:s3:::YOUR_PRIVATE_BUCKET/axon/sessions/*"
      ],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

The backend role needs namespace-scoped `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject`; prefix-scoped `s3:ListBucket`; and `s3:GetBucketPublicAccessBlock`, `s3:GetBucketVersioning`, and `s3:GetLifecycleConfiguration`. `s3:GetBucketPolicy` is required when strict policy verification is enabled.

Setting `REQUIRE_CREATE_ONLY_POLICY=false` skips only policy retrieval/conditional-deny verification. Privacy, versioning, and lifecycle checks remain mandatory; PUTs still require signed `If-None-Match: *`. This toggle does not change a bucket policy. Without the bucket-level denies, another writer can unconditionally replace objects, so the write-once guarantee is weaker. Keep strict verification for rollout.

Configuration bounds are URL **30–300 seconds**, reservation **at least the URL lifetime and at most 900 seconds**, and cleanup grace **at least reservation + 600 seconds**. Defaults are 300/900/3600. Clients require HTTPS object URLs and reject redirects. Signed PUT instructions bind checksum, content type, and content length; there is no overwrite fallback.

### Live storage smoke test

Run against the actual provisioned namespace, with credentials supplied only through the SDK environment/role:

```sh
cd apps/backend
AWS_BUCKET_NAME=YOUR_PRIVATE_BUCKET AWS_REGION=ap-south-1 \
  uv run --frozen python -m deployment.test_session_s3
```

Optional overrides: `AWS_ENDPOINT_URL` and `SESSION_KEY_PREFIX`. The test uses synthetic JSONL and unique object keys; it checks signed PUT/GET, integrity/format validation, conditional and unconditional overwrite rejection, anonymous-read denial, and cleanup. It never changes bucket policy/configuration. It **always** checks strict create-only policy, regardless of runtime toggle. A nonzero exit is a rollout blocker. S3-compatible storage must pass the same test; API compatibility/random keys alone do not prove immutability.

No live bucket test was performed for this documentation refresh. Do not treat old bucket experiments or checked-in configuration as evidence that a deployed namespace is safe.

## 7. Reconciliation, deletion, and operations

Schedule the existing maintenance command from an operator-owned scheduler, for example every ten minutes:

```sh
cd apps/backend
uv run --frozen python -m deployment.reconcile_sessions
```

This is **backend object maintenance**, not a client sync worker. The repository provides the command, not a deployed schedule. It:

1. Streams namespace object listings and considers only objects older than cleanup grace.
2. Rechecks current pointers and active nondeleted reservations before deleting unreferenced objects.
3. Clears expired reservations under a row lock.
4. Removes sufficiently old tombstones only when that stream's object namespace is empty.

Delete immediately hides a row and rejects new uploads/downloads/finalization. It attempts deletion of known current/pending objects but retains the tombstone past safety windows. A late PUT using an outstanding URL is caught by later reconciliation; failed deletes/crashes are retried on subsequent runs. Membership deletion remains restricted until session-row cleanup finishes. Do not replace reconciliation with blanket bucket expiration.

Keep access/SDK/HTTP logging free of bodies, session names, absolute paths, tokens, and signed URLs. Monitor sanitized status/error counts, validation load, temporary disk/memory use, and reconciliation success. Streaming transfer/decompression does not make JSON parsing constant-memory: a valid single record can approach the full 100 MiB raw limit. Review backend worker limits and real network/shutdown behavior before pilot deployment.

Local pending files and verified restore archives remain private; disabling or remote deletion does not purge them. There is no automatic local archive-retention/garbage-collection command.

## 8. Restore algorithm and limits

Restore dispatches by the advertised harness/format/version, rejecting unsupported combinations before local session mutation. It requires the managed pinned Pi package and an existing checkout; `axon setup pi --sync-packages` installs/prepares the runtime if needed.

1. Authenticate and get latest metadata plus a signed URL pinned to its object/integrity declaration. Show name, backup time, size, and unknown-leaf warning; require confirmation unless `--yes`.
2. Download privately outside live Pi storage with a 120-second request timeout and declared stored-byte limit. Verify stored hash/size, bounded decompression, raw hash/size, JSONL semantics, native identity, and resume metadata.
3. Retain `original.jsonl`, payload, and provenance under `session-backups/archives/restore-*`. Use a private working copy for Pi loading; a loader must not modify the verified original. A verified archive remains even if native fork fails.
4. Call pinned `SessionManager.forkFrom()` with the selected local cwd and temporary session directory. It creates a new native ID/header while retaining the complete entry tree.
5. For a known leaf, call `branch()` or `resetLeaf()` for root, then append a non-context `axon.restore` custom entry to anchor selection across reopening. Unknown-leaf backups retain Pi's normal last-entry selection and display a warning.
6. Verify preserved entries, new ID/cwd, and durable selection. Publish atomically with create-only hard-link semantics into managed session storage, without replacing a live file. Record local fork/source-object provenance.
7. Print `axon pi --session <new-file>` for use from the selected checkout. Future capture allocates a new client stream on the destination device; it never continues the source remote stream.

Backup preserves the exact original archive bytes. The native fork changes the header and can reserialize entries; restore verifies entry-tree preservation, not byte identity of the new live file.

Restore **does not** recover checkout contents, uncommitted edits, credentials, extensions/MCP configuration, external attachments, or files referenced in tool output. Historical paths, provider/model fields, signatures, and old tool calls remain history: they are not rewritten/replayed. Provider availability or acceptance of old opaque signatures is not guaranteed. Prepare the checkout and required tooling separately.

## 9. Verification and rollout gates

Focused checks from the repository root:

```sh
bun run check:cli
bun test --cwd apps/cli tests/session-backups.test.ts
SESSION_BACKUP_LOAD_TESTS=1 bun test --cwd apps/cli tests/session-backups.test.ts
(cd apps/backend && uv run --frozen pytest -q -rs \
  tests/test_session_backups.py tests/test_session_routes.py tests/test_session_database.py)
```

Broader checks: `bun run test:cli` and `make -C apps/backend check`.

Postgres integration tests use `SESSION_TEST_POSTGRES_URL` (default `postgresql://localhost/postgres`) only to create/drop unique disposable databases. They do not load the populated application DB configuration. They skip explicitly when the disposable server/admin is unavailable; no external migration executable is required.

During this refresh, `check:cli` passed, the CLI session suite passed **27 tests with load tests enabled**, and the focused backend suites passed **61 tests**, including disposable-Postgres integration. Coverage includes complete trees/media/signatures/names, leaf modes and restored continuation, malformed/tail/symlink rejection, exact size limits and decompression bombs, administrator-policy/account isolation, uncertain commits and conflicts, migration/FK/ledger constraints, expiry/deletion during validation, and failed-delete/late-PUT reconciliation. These are local results, not live S3 or production fault-environment certification.

Before enabling an administrator-managed pilot:

- Provision the private unversioned namespace and pass the strict live S3 smoke test.
- Verify the legacy membership prerequisite and apply the reviewed migration through the deployment runner.
- Install and monitor the operator reconciliation schedule and multi-worker edge rate limiter.
- Test real managed Pi quit/reload/session switch under slow/offline networks, interrupted transfer, and large sessions; evaluate shutdown delay and memory/disk limits.
- Exercise restore on pilot machines/checkouts and check privacy-sensitive logging/access/retention policies.
- Inform users of the complete-transcript backup policy, configure private storage, set `SESSION_BACKUPS.ENABLED=true` in backend `config.json`, and restart. No per-account opt-in is required.

No production migration, storage-policy change, scheduler deployment, or pilot was performed for this refresh.

## 10. Source map and intentionally absent features

| Source | Responsibility |
| --- | --- |
| [`apps/cli/src/cli/commands/sessions.ts`](../apps/cli/src/cli/commands/sessions.ts) | Guided interactive menu plus status/list/restore/delete/retry commands (no user policy toggles) |
| [`apps/cli/src/harnesses/pi/session-backup/index.ts`](../apps/cli/src/harnesses/pi/session-backup/index.ts) | Managed lifecycle hooks and slash commands |
| [`apps/cli/src/sessions/`](../apps/cli/src/sessions/) | API credentials, contracts, private capture/queue/files, native restore |
| [`apps/cli/scripts/build-session-backup.ts`](../apps/cli/scripts/build-session-backup.ts) | Generated embedded extension; rebuild with `bun run --cwd apps/cli backups:build`, never hand-edit the bundle |
| [`apps/backend/app/routers/sessions.py`](../apps/backend/app/routers/sessions.py) | Authenticated, bounded metadata routes and per-process rate guard |
| [`apps/backend/app/services/sessions/`](../apps/backend/app/services/sessions/) | Adapter validation, private storage, latest-only CAS protocol, reconciliation |
| [`apps/backend/app/core/session_storage.py`](../apps/backend/app/core/session_storage.py) | Backend config policy, storage configuration and safety-window validation |
| [`apps/backend/app/models/session_backup.py`](../apps/backend/app/models/session_backup.py) | Single latest-pointer/reservation model |
| [`apps/backend/deployment/`](../apps/backend/deployment/) | Migration runner, isolated schema generator, reconciliation CLI, live storage test |

Not implemented: production non-Pi adapters, revision/history browsing, retained divergent revisions, server-side restore ancestry, aggregate storage quotas, durable validation jobs, standalone/post-exit client upload workers, per-turn/periodic backups, historical bulk import, multipart/delta transfer, sharing/public links/previews/web backup management, automatic remote pull, or backup of repository/configuration/credential state.
