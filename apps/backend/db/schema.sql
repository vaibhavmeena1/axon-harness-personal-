-- Generated in isolation; requires existing public.user_teams(id BIGINT PRIMARY KEY).
--
-- PostgreSQL database dump
--


-- Dumped from database version 18.4 (Postgres.app)
-- Dumped by pg_dump version 18.6 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: META_HARNESS_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."META_HARNESS_sessions" (
    id uuid NOT NULL,
    owner_user_team_id bigint NOT NULL,
    client_session_key uuid NOT NULL,
    harness character varying(128) NOT NULL,
    harness_session_id character varying(256),
    device_id uuid NOT NULL,
    session_format character varying(128) NOT NULL,
    update_token uuid NOT NULL,
    object_key text,
    display_name character varying(256),
    raw_sha256 character varying(64),
    stored_sha256 character varying(64),
    raw_size_bytes bigint,
    stored_size_bytes bigint,
    encoding character varying(16),
    session_format_version character varying(128),
    resume_metadata jsonb,
    last_committed_request_id uuid,
    last_backup_at timestamp with time zone,
    pending_request_id uuid,
    pending_object_key text,
    pending_expected_token uuid,
    pending_expires_at timestamp with time zone,
    pending_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT "META_HARNESS_sessions_current_complete" CHECK ((num_nonnulls(object_key, raw_sha256, stored_sha256, raw_size_bytes, stored_size_bytes, encoding, session_format_version, resume_metadata, last_committed_request_id, last_backup_at) = ANY (ARRAY[0, 10]))),
    CONSTRAINT "META_HARNESS_sessions_current_valid" CHECK (((object_key IS NULL) OR (((length(object_key) >= 1) AND (length(object_key) <= 512)) AND ((raw_sha256)::text ~ '^[a-f0-9]{64}$'::text) AND ((stored_sha256)::text ~ '^[a-f0-9]{64}$'::text) AND ((raw_size_bytes >= 1) AND (raw_size_bytes <= 104857600)) AND ((stored_size_bytes >= 1) AND (stored_size_bytes <= 105906176)) AND ((encoding)::text = ANY ((ARRAY['identity'::character varying, 'gzip'::character varying])::text[])) AND (length((session_format_version)::text) > 0) AND (jsonb_typeof(resume_metadata) = 'object'::text) AND (octet_length((resume_metadata)::text) <= 4096) AND (((encoding)::text <> 'identity'::text) OR ((raw_size_bytes = stored_size_bytes) AND ((raw_sha256)::text = (stored_sha256)::text)))))),
    CONSTRAINT "META_HARNESS_sessions_display_name" CHECK (((display_name IS NULL) OR ((object_key IS NOT NULL) AND ((length((display_name)::text) >= 1) AND (length((display_name)::text) <= 256)) AND (length(btrim((display_name)::text)) > 0)))),
    CONSTRAINT "META_HARNESS_sessions_identity" CHECK (((length((harness)::text) > 0) AND (length((session_format)::text) > 0) AND ((harness_session_id IS NULL) OR (length((harness_session_id)::text) > 0)))),
    CONSTRAINT "META_HARNESS_sessions_pending_complete" CHECK ((num_nonnulls(pending_request_id, pending_object_key, pending_expected_token, pending_expires_at, pending_snapshot) = ANY (ARRAY[0, 5]))),
    CONSTRAINT "META_HARNESS_sessions_pending_valid" CHECK (((pending_request_id IS NULL) OR (((length(pending_object_key) >= 1) AND (length(pending_object_key) <= 512)) AND (jsonb_typeof(pending_snapshot) = 'object'::text) AND (octet_length((pending_snapshot)::text) <= 8192) AND (pending_snapshot ?& ARRAY['display_name'::text, 'raw_sha256'::text, 'stored_sha256'::text, 'raw_size_bytes'::text, 'stored_size_bytes'::text, 'encoding'::text, 'session_format_version'::text, 'resume_metadata'::text]) AND ((pending_snapshot - ARRAY['display_name'::text, 'raw_sha256'::text, 'stored_sha256'::text, 'raw_size_bytes'::text, 'stored_size_bytes'::text, 'encoding'::text, 'session_format_version'::text, 'resume_metadata'::text]) = '{}'::jsonb) AND (jsonb_typeof((pending_snapshot -> 'display_name'::text)) = ANY (ARRAY['string'::text, 'null'::text])) AND (((pending_snapshot -> 'display_name'::text) = 'null'::jsonb) OR (((length((pending_snapshot ->> 'display_name'::text)) >= 1) AND (length((pending_snapshot ->> 'display_name'::text)) <= 256)) AND (length(btrim((pending_snapshot ->> 'display_name'::text))) > 0))) AND (jsonb_typeof((pending_snapshot -> 'raw_sha256'::text)) = 'string'::text) AND (jsonb_typeof((pending_snapshot -> 'stored_sha256'::text)) = 'string'::text) AND ((pending_snapshot ->> 'raw_sha256'::text) ~ '^[a-f0-9]{64}$'::text) AND ((pending_snapshot ->> 'stored_sha256'::text) ~ '^[a-f0-9]{64}$'::text) AND (jsonb_typeof((pending_snapshot -> 'raw_size_bytes'::text)) = 'number'::text) AND (jsonb_typeof((pending_snapshot -> 'stored_size_bytes'::text)) = 'number'::text) AND ((pending_snapshot ->> 'raw_size_bytes'::text) ~ '^[0-9]+$'::text) AND ((pending_snapshot ->> 'stored_size_bytes'::text) ~ '^[0-9]+$'::text) AND ((((pending_snapshot ->> 'raw_size_bytes'::text))::numeric >= (1)::numeric) AND (((pending_snapshot ->> 'raw_size_bytes'::text))::numeric <= (104857600)::numeric)) AND ((((pending_snapshot ->> 'stored_size_bytes'::text))::numeric >= (1)::numeric) AND (((pending_snapshot ->> 'stored_size_bytes'::text))::numeric <= (105906176)::numeric)) AND (jsonb_typeof((pending_snapshot -> 'encoding'::text)) = 'string'::text) AND ((pending_snapshot ->> 'encoding'::text) = ANY (ARRAY['identity'::text, 'gzip'::text])) AND (jsonb_typeof((pending_snapshot -> 'session_format_version'::text)) = 'string'::text) AND ((length((pending_snapshot ->> 'session_format_version'::text)) >= 1) AND (length((pending_snapshot ->> 'session_format_version'::text)) <= 128)) AND (jsonb_typeof((pending_snapshot -> 'resume_metadata'::text)) = 'object'::text) AND (octet_length(((pending_snapshot -> 'resume_metadata'::text))::text) <= 4096) AND (((pending_snapshot ->> 'encoding'::text) <> 'identity'::text) OR (((pending_snapshot ->> 'raw_size_bytes'::text) = (pending_snapshot ->> 'stored_size_bytes'::text)) AND ((pending_snapshot ->> 'raw_sha256'::text) = (pending_snapshot ->> 'stored_sha256'::text)))))))
);


--
-- Name: META_HARNESS_sessions META_HARNESS_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."META_HARNESS_sessions"
    ADD CONSTRAINT "META_HARNESS_sessions_pkey" PRIMARY KEY (id);


--
-- Name: META_HARNESS_sessions META_HARNESS_sessions_stream_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."META_HARNESS_sessions"
    ADD CONSTRAINT "META_HARNESS_sessions_stream_unique" UNIQUE (owner_user_team_id, client_session_key);


--
-- Name: META_HARNESS_sessions_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "META_HARNESS_sessions_deleted" ON public."META_HARNESS_sessions" USING btree (deleted_at) WHERE (deleted_at IS NOT NULL);


--
-- Name: META_HARNESS_sessions_owner_updated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "META_HARNESS_sessions_owner_updated" ON public."META_HARNESS_sessions" USING btree (owner_user_team_id, updated_at DESC, id DESC) WHERE (deleted_at IS NULL);


--
-- Name: META_HARNESS_sessions_pending_expiry; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "META_HARNESS_sessions_pending_expiry" ON public."META_HARNESS_sessions" USING btree (pending_expires_at) WHERE (pending_request_id IS NOT NULL);


--
-- Name: META_HARNESS_sessions META_HARNESS_sessions_owner_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."META_HARNESS_sessions"
    ADD CONSTRAINT "META_HARNESS_sessions_owner_fk" FOREIGN KEY (owner_user_team_id) REFERENCES public.user_teams(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
