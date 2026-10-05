-- migrate:up
DO $$
BEGIN
    IF to_regclass('public.user_teams') IS NULL OR NOT EXISTS (
        SELECT 1 FROM pg_attribute a
        JOIN pg_constraint c ON c.conrelid = a.attrelid AND c.contype = 'p' AND c.conkey = ARRAY[a.attnum]
        WHERE a.attrelid = to_regclass('public.user_teams') AND a.attname = 'id' AND a.atttypid = 'bigint'::regtype
    ) THEN
        RAISE EXCEPTION 'Session backups require existing public.user_teams(id BIGINT PRIMARY KEY)';
    END IF;
END $$;

CREATE TABLE "META_HARNESS_sessions" (
    id UUID CONSTRAINT "META_HARNESS_sessions_pkey" PRIMARY KEY,
    owner_user_team_id BIGINT NOT NULL,
    client_session_key UUID NOT NULL,
    harness VARCHAR(128) NOT NULL,
    harness_session_id VARCHAR(256),
    device_id UUID NOT NULL,
    session_format VARCHAR(128) NOT NULL,
    update_token UUID NOT NULL,
    object_key TEXT,
    display_name VARCHAR(256),
    raw_sha256 VARCHAR(64),
    stored_sha256 VARCHAR(64),
    raw_size_bytes BIGINT,
    stored_size_bytes BIGINT,
    encoding VARCHAR(16),
    session_format_version VARCHAR(128),
    resume_metadata JSONB,
    last_committed_request_id UUID,
    last_backup_at TIMESTAMPTZ,
    pending_request_id UUID,
    pending_object_key TEXT,
    pending_expected_token UUID,
    pending_expires_at TIMESTAMPTZ,
    pending_snapshot JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    CONSTRAINT "META_HARNESS_sessions_owner_fk" FOREIGN KEY (owner_user_team_id)
        REFERENCES public.user_teams(id) ON DELETE RESTRICT,
    CONSTRAINT "META_HARNESS_sessions_stream_unique" UNIQUE (owner_user_team_id, client_session_key),
    CONSTRAINT "META_HARNESS_sessions_identity" CHECK (
        length(harness) > 0 AND length(session_format) > 0 AND
        (harness_session_id IS NULL OR length(harness_session_id) > 0)
    ),
    CONSTRAINT "META_HARNESS_sessions_display_name" CHECK (
        display_name IS NULL OR (object_key IS NOT NULL AND length(display_name) BETWEEN 1 AND 256
            AND length(btrim(display_name)) > 0)
    ),
    CONSTRAINT "META_HARNESS_sessions_current_complete" CHECK (
        num_nonnulls(object_key, raw_sha256, stored_sha256, raw_size_bytes, stored_size_bytes,
            encoding, session_format_version, resume_metadata, last_committed_request_id, last_backup_at) IN (0, 10)
    ),
    CONSTRAINT "META_HARNESS_sessions_current_valid" CHECK (object_key IS NULL OR (
        length(object_key) BETWEEN 1 AND 512 AND raw_sha256 ~ '^[a-f0-9]{64}$' AND stored_sha256 ~ '^[a-f0-9]{64}$'
        AND raw_size_bytes BETWEEN 1 AND 104857600 AND stored_size_bytes BETWEEN 1 AND 105906176
        AND encoding IN ('identity', 'gzip') AND length(session_format_version) > 0
        AND jsonb_typeof(resume_metadata) = 'object' AND octet_length(resume_metadata::text) <= 4096
        AND (encoding <> 'identity' OR (raw_size_bytes = stored_size_bytes AND raw_sha256 = stored_sha256))
    )),
    CONSTRAINT "META_HARNESS_sessions_pending_complete" CHECK (
        num_nonnulls(pending_request_id, pending_object_key, pending_expected_token, pending_expires_at, pending_snapshot) IN (0, 5)
    ),
    CONSTRAINT "META_HARNESS_sessions_pending_valid" CHECK (pending_request_id IS NULL OR (
        length(pending_object_key) BETWEEN 1 AND 512 AND jsonb_typeof(pending_snapshot) = 'object'
        AND octet_length(pending_snapshot::text) <= 8192
        AND pending_snapshot ?& ARRAY['display_name','raw_sha256','stored_sha256','raw_size_bytes','stored_size_bytes','encoding','session_format_version','resume_metadata']
        AND pending_snapshot - ARRAY['display_name','raw_sha256','stored_sha256','raw_size_bytes','stored_size_bytes','encoding','session_format_version','resume_metadata'] = '{}'::jsonb
        AND jsonb_typeof(pending_snapshot->'display_name') IN ('string','null')
        AND (pending_snapshot->'display_name' = 'null'::jsonb OR (
            length(pending_snapshot->>'display_name') BETWEEN 1 AND 256
            AND length(btrim(pending_snapshot->>'display_name')) > 0
        ))
        AND jsonb_typeof(pending_snapshot->'raw_sha256') = 'string'
        AND jsonb_typeof(pending_snapshot->'stored_sha256') = 'string'
        AND pending_snapshot->>'raw_sha256' ~ '^[a-f0-9]{64}$'
        AND pending_snapshot->>'stored_sha256' ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(pending_snapshot->'raw_size_bytes') = 'number'
        AND jsonb_typeof(pending_snapshot->'stored_size_bytes') = 'number'
        AND pending_snapshot->>'raw_size_bytes' ~ '^[0-9]+$'
        AND pending_snapshot->>'stored_size_bytes' ~ '^[0-9]+$'
        AND (pending_snapshot->>'raw_size_bytes')::numeric BETWEEN 1 AND 104857600
        AND (pending_snapshot->>'stored_size_bytes')::numeric BETWEEN 1 AND 105906176
        AND jsonb_typeof(pending_snapshot->'encoding') = 'string'
        AND pending_snapshot->>'encoding' IN ('identity','gzip')
        AND jsonb_typeof(pending_snapshot->'session_format_version') = 'string'
        AND length(pending_snapshot->>'session_format_version') BETWEEN 1 AND 128
        AND jsonb_typeof(pending_snapshot->'resume_metadata') = 'object'
        AND octet_length((pending_snapshot->'resume_metadata')::text) <= 4096
        AND (pending_snapshot->>'encoding' <> 'identity' OR (
            pending_snapshot->>'raw_size_bytes' = pending_snapshot->>'stored_size_bytes'
            AND pending_snapshot->>'raw_sha256' = pending_snapshot->>'stored_sha256'
        ))
    ))
);
CREATE INDEX "META_HARNESS_sessions_owner_updated" ON "META_HARNESS_sessions" (owner_user_team_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX "META_HARNESS_sessions_pending_expiry" ON "META_HARNESS_sessions" (pending_expires_at) WHERE pending_request_id IS NOT NULL;
CREATE INDEX "META_HARNESS_sessions_deleted" ON "META_HARNESS_sessions" (deleted_at) WHERE deleted_at IS NOT NULL;

-- migrate:down
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM "META_HARNESS_sessions" WHERE object_key IS NOT NULL OR pending_object_key IS NOT NULL) THEN
        RAISE EXCEPTION 'Clean up session objects and pending reservations before rolling back';
    END IF;
END $$;
DROP TABLE "META_HARNESS_sessions";
