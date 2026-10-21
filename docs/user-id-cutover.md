# Cut over Axon to auth user IDs

Axon now uses deputydev-auth's verified `user_id`, not `user_team_id`, for ownership,
rate limiting, telemetry, and LiteLLM key attribution. This is an intentional breaking
change. No auth database tables are required in the Axon database.

## Before deployment

1. Confirm the deployed auth service's `GET /v2/get-auth-data` returns a positive
   integer `auth_data.user_id` and verified email. The reference auth service already
   does; no auth changes, token reissue, or membership-ID mapping are required.
2. When `LITELLM.IDENTITY_SYNC_ENABLED` is true, set `LITELLM.TEAM_ID` to an existing,
   active **LiteLLM** team. Missing/empty IDs fail startup. Replace the template's
   placeholder with the real ID. Auth-service teams/roles are never used for provisioning.
3. Review user/team policies in LiteLLM. New user-scoped virtual keys do not inherit
   budgets, restrictions, grants, expiry, or spend counters from old keys. Existing
   user/team policy remains in force. Configure key-specific policy separately if needed.
4. Coordinate the backend and CLI rollout. Old clients expect `owner_user_team_id`;
   the session status API now returns `owner_user_id` and intentionally has no fallback.

## Existing LiteLLM users and keys

**Do not rename native LiteLLM user IDs or recreate users.** On each user's next
request, Axon resolves the existing user by exact verified email, adds scalar string
`axon_user_id` metadata with a metadata-only update, and creates the new derived key
if missing. The new key is verified before use and reused across backend restarts.

The derivation has a new namespace, so an old membership ID numerically equal to the
new user ID still cannot cause an old key to be reused. Existing native IDs, user roles,
budgets, spend/history, team memberships, unrelated metadata, and old keys are retained.
Historical membership metadata is not used as identity and is not rewritten or deleted.
A native email record already bound to a different `axon_user_id` fails closed for review.

The four existing users need no manual ID mapping or metadata edits as long as their
emails match the verified auth emails uniquely. Ambiguous email records fail closed.
Old keys remain valid according to their existing policy; revoke them explicitly after
review if they should no longer be usable. Axon does not revoke them automatically.

## Session schema on a fresh database

This deployment assumes a fresh database. The creation migration and `db/schema.sql`
contain `owner_user_id BIGINT NOT NULL`, with no auth-service foreign key. No reset,
backfill, or manual migration-history changes are needed.

1. Supply the real dbmate binary on the migration container's `PATH` and securely inject
   `DATABASE_URL` matching the backend's configured database. dbmate does not read
   `config.json`. Do not override its default `schema_migrations` table.
2. Provision the database, then run once before application workers start:

   ```sh
   cd apps/backend
   ./deployment/run_migrations.sh
   ./deployment/run_migrations.sh status
   ```

   The wrapper runs dbmate `migrate` with schema dumping disabled. Pass `up` instead of
   the default command only if dbmate should create the database. The first migration
   creates `"META_HARNESS_sessions"` and records its version in `schema_migrations`.
   Subsequent runs skip that version. Do not load `db/schema.sql` before running it.
3. Deploy updated clients/backend, verify `/api/v1/sessions/status` returns the verified
   `owner_user_id`, and enable backups when storage is ready.

There is no session-data migration for an existing membership-owned schema. Editing
an applied migration does not update existing tables, and membership IDs are not user
IDs. Such a database requires a separately reviewed data-preserving upgrade or approved
storage cleanup/reset plan. Do not rename the old column or manipulate migration
history to bypass that review. A rollback refuses while object/pending pointers remain.

New CLI queues use `${AXON_HOME:-~/.axon}/session-backups/users/`. Old membership-bound
settings/queues directly under `session-backups/` are not imported or deleted, even if
IDs happen to match. New captures register fresh remote streams. Live Pi sessions,
credentials, and verified restore archives are unaffected; review old queue files
separately before deleting them.

## Verification

- A valid `user_id` works without any auth membership/team fields.
- Missing, non-integer, boolean, nonpositive, or out-of-BIGINT-range user IDs fail closed;
  membership IDs and client-supplied fields never fill the gap.
- Changing auth membership/team fields does not change the native user, key, or cache.
- Existing native users and old keys remain intact while new keys are generated.
- Telemetry emits `user.id` and `axon.user_id`; legacy client `axon.user_team_id` attributes
  are removed rather than forwarded.
