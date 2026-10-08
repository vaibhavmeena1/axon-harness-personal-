"""Synthetic, offline integrity/adapter/storage policy tests (never real history)."""

import gzip
import hashlib
import io
import json
from typing import BinaryIO
from unittest.mock import Mock
from uuid import uuid4

import pytest
from botocore.exceptions import ClientError
from pydantic import ValidationError

from app.clients.s3 import S3Client
from app.core.s3 import S3ClientSettings, S3StorageSettings, parse_s3_storage
from app.core.session_storage import SessionStorageSettings, parse_session_storage
from app.models.session_backup import SessionBackup
from app.services.sessions.adapters import ADAPTERS, Adapter, InvalidSessionError, get_adapter, records
from app.services.sessions.bucket_policy import SessionBucketPolicy
from app.services.sessions.contracts import MAX_RAW_BYTES, MAX_STORED_BYTES, Snapshot, normalize_display_name
from app.services.sessions.integrity import verify_chunks
from app.services.sessions.storage import SessionObjectStore

RESUME = {"leaf_known": True, "selected_leaf_id": "a"}


def payload(native: str = "opaque/native-id") -> bytes:
    entries = [
        {
            "type": "session",
            "version": 3,
            "id": native,
            "cwd": "/old/user/checkout",
            "timestamp": "2026-01-01T00:00:00Z",
        },
        {
            "type": "message",
            "id": "a",
            "parentId": None,
            "timestamp": "t",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "synthetic"},
                    {"type": "image", "data": "c3ludGhldGlj", "mimeType": "image/png"},
                ],
            },
        },
        {"type": "model_change", "id": "b", "parentId": "a", "timestamp": "t", "provider": "test", "modelId": "model"},
        {
            "type": "message",
            "id": "c",
            "parentId": "b",
            "timestamp": "t",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "synthetic", "thinkingSignature": "opaque"},
                    {"type": "text", "text": "done", "textSignature": "opaque"},
                ],
            },
        },
        {
            "type": "compaction",
            "id": "d",
            "parentId": "c",
            "timestamp": "t",
            "summary": "synthetic",
            "firstKeptEntryId": "c",
        },
        {
            "type": "custom",
            "id": "e",
            "parentId": "a",
            "timestamp": "t",
            "customType": "test",
            "data": {"opaque": [1, 2]},
        },
    ]
    return ("\n".join(json.dumps(item) for item in entries) + "\n").encode()


def declaration(raw: bytes, stored: bytes | None = None, *, display_name: str | None = "synthetic") -> Snapshot:
    stored = stored if stored is not None else raw
    return Snapshot(
        display_name=display_name,
        raw_sha256=hashlib.sha256(raw).hexdigest(),
        stored_sha256=hashlib.sha256(stored).hexdigest(),
        raw_size_bytes=len(raw),
        stored_size_bytes=len(stored),
        encoding="identity" if stored == raw else "gzip",
        session_format_version="3",
        resume_metadata=RESUME,
    )


def named_payload(names: list[str]) -> bytes:
    return payload() + b"".join(
        (
            json.dumps({"type": "session_info", "id": f"name-{i}", "parentId": "a", "timestamp": "t", "name": name})
            + "\n"
        ).encode()
        for i, name in enumerate(names)
    )


@pytest.mark.parametrize(
    ("names", "expected"),
    [
        ([], "synthetic"),
        (["Original", "Renamed"], "Renamed"),
        (["Original", ""], "synthetic"),
        ([" \t\n\u00a0\ufeff"], "synthetic"),
        (["  fix\nlogin\tflow\u2028now\x1b  "], "fix login flow now"),
        (["😀" * 257], "😀" * 256),
        (["x" * 255 + " \nignored"], "x" * 255),
        (["\ud800Title\udfff"], "Title"),
    ],
)
def test_latest_native_name_is_bounded_without_changing_archive(names: list[str], expected: str | None) -> None:
    raw = named_payload(names)
    assert get_adapter("pi", "pi-jsonl", "3").validate(io.BytesIO(raw), None, RESUME) == expected
    assert raw == named_payload(names)
    if names:
        assert (normalize_display_name(names[-1]) or "synthetic") == expected
    assert declaration(raw, display_name=expected).display_name == expected


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("  Fix\nlogin\tflow  ", "Fix login flow"),
        (
            [
                {"type": "text", "text": "Fix"},
                {"type": "image", "data": "synthetic"},
                {"type": "text", "text": "login flow"},
            ],
            "Fix login flow",
        ),
        ([{"type": "image", "data": "synthetic"}], None),
        ([None, {"type": "text", "text": 123}, {"type": "image", "text": "ignore"}], None),
        (" \t\n\ufeff", None),
        ("😀" * 257, "😀" * 256),
    ],
)
def test_first_user_message_fallback_is_bounded_and_stable(content: str | list, expected: str | None) -> None:
    entries = [
        {"type": "session", "version": 3, "id": "native", "timestamp": "t", "cwd": "/synthetic"},
        *[
            {
                "type": "message",
                "id": f"skip-{i}",
                "parentId": None,
                "timestamp": "t",
                "message": {"role": role, "content": [{"type": "text", "text": "Not the title"}]},
            }
            for i, role in enumerate(["system", "assistant", "toolResult"])
        ],
        {
            "type": "message",
            "id": "a",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": content},
        },
    ]
    raw = ("\n".join(json.dumps(entry) for entry in entries) + "\n").encode()
    adapter = get_adapter("pi", "pi-jsonl", "3")
    assert adapter.validate(io.BytesIO(raw), "native", RESUME) == expected
    later = [
        {
            "type": "context_edit",
            "id": "edit",
            "parentId": "a",
            "timestamp": "t",
            "targetId": "a",
            "replacement": {"content": "Changed context"},
        },
        {
            "type": "message",
            "id": "branch",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": "Later prompt"},
        },
    ]
    extended = raw + ("\n".join(json.dumps(entry) for entry in later) + "\n").encode()
    assert adapter.validate(io.BytesIO(extended), "native", RESUME) == (expected or "Later prompt")


def test_display_name_is_required_even_when_null() -> None:
    value = declaration(payload()).model_dump()
    del value["display_name"]
    with pytest.raises(ValidationError):
        Snapshot.model_validate(value)


@pytest.mark.parametrize("declared", [None, "Forged"])
def test_object_validation_rejects_name_not_matching_archive(declared: str | None) -> None:
    settings = SessionStorageSettings(S3StorageSettings("private-test", S3ClientSettings("ap-south-1")))
    client = Mock()
    store = SessionObjectStore(settings, S3Client(settings.s3.client, client=client))
    raw = named_payload(["Committed title"])
    body = io.BytesIO(raw)
    client.get_object.return_value = {"ContentLength": len(raw), "Body": body}
    with pytest.raises(InvalidSessionError, match="Display name does not match"):
        store.validate("synthetic", declaration(raw, display_name=declared), get_adapter("pi", "pi-jsonl", "3"), None)
    assert body.closed
    body = io.BytesIO(raw)
    client.get_object.return_value = {"ContentLength": len(raw), "Body": body}
    store.validate(
        "synthetic", declaration(raw, display_name="Committed title"), get_adapter("pi", "pi-jsonl", "3"), None
    )
    assert body.closed


@pytest.mark.parametrize(
    "resume", [RESUME, {"leaf_known": True, "selected_leaf_id": None}, {"leaf_known": False, "selected_leaf_id": None}]
)
def test_complete_tree_multimodal_opaque_preservation(resume: dict) -> None:
    raw = payload()
    original = raw[:]
    get_adapter("pi", "pi-jsonl", "3").validate(io.BytesIO(raw), "opaque/native-id", resume)
    assert raw == original
    assert SessionBackup._meta.db_table == "META_HARNESS_sessions"
    assert "pi_session_id" not in SessionBackup._meta.fields_map


@pytest.mark.parametrize(
    "raw",
    [
        payload()[:-1],
        payload() + b"{broken}\n",
        payload() + payload(),
        b"{}\n",
        payload().replace(b'"parentId": "b"', b'"parentId": "missing"'),
    ],
)
def test_corrupt_incomplete_duplicate_and_broken_tree(raw: bytes) -> None:
    with pytest.raises(InvalidSessionError):
        get_adapter("pi", "pi-jsonl", "3").validate(io.BytesIO(raw), None, RESUME)


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"leaf_known": False, "selected_leaf_id": "a"},
        {"leaf_known": 1, "selected_leaf_id": None},
        {"leaf_known": True, "selected_leaf_id": "missing"},
        {**RESUME, "cwd": "/private"},
    ],
)
def test_invalid_resume(metadata: dict) -> None:
    with pytest.raises(InvalidSessionError):
        get_adapter("pi", "pi-jsonl", "3").validate(io.BytesIO(payload()), None, metadata)


def test_unsupported_and_second_format_without_pi_structure(monkeypatch: pytest.MonkeyPatch) -> None:
    def validate(source: BinaryIO, native_id: str | None, metadata: dict) -> str | None:
        assert list(records(source)) == [{"thread": native_id, "turn": "test"}]
        assert metadata == {}
        return None

    key = ("test-harness", "other-jsonl", "version-alpha")
    monkeypatch.setitem(ADAPTERS, key, Adapter(validate, lambda metadata: metadata))
    get_adapter(*key).validate(io.BytesIO(b'{"thread":"opaque:123", "turn":"test"}\n'), "opaque:123", {})
    with pytest.raises(InvalidSessionError):
        get_adapter("other", "pi-jsonl", "3")
    with pytest.raises(InvalidSessionError):
        get_adapter("pi", "pi-jsonl", "version-alpha")


@pytest.mark.parametrize("compress", [False, True])
def test_stream_integrity(compress: bool) -> None:
    raw = payload()
    stored = gzip.compress(raw) if compress else raw
    out = io.BytesIO()
    verify_chunks(iter(stored[i : i + 11] for i in range(0, len(stored), 11)), declaration(raw, stored), out)
    assert out.getvalue() == raw


@pytest.mark.parametrize("kind", ["size", "hash", "truncated", "trailing", "bomb"])
def test_stream_validation_failures(kind: str) -> None:
    raw = payload()
    stored = gzip.compress(raw)
    snapshot = declaration(raw, stored)
    if kind == "size":
        snapshot = snapshot.model_copy(update={"stored_size_bytes": len(stored) - 1})
    if kind == "hash":
        snapshot = snapshot.model_copy(update={"raw_sha256": "0" * 64})
    if kind == "truncated":
        stored = stored[:-3]
    if kind == "trailing":
        stored += gzip.compress(b"extra")
    if kind == "bomb":
        stored = gzip.compress(b"a" * (1024 * 1024))
        snapshot = snapshot.model_copy(update={"stored_size_bytes": len(stored)})
    with pytest.raises(InvalidSessionError):
        verify_chunks(iter([stored]), snapshot, io.BytesIO())


def test_declaration_limits_and_identity() -> None:
    d = declaration(payload()).model_dump()
    for values in [
        {"raw_size_bytes": MAX_RAW_BYTES + 1},
        {"stored_size_bytes": MAX_STORED_BYTES + 1},
        {"raw_sha256": "A" * 64},
        {"stored_sha256": "0" * 64},
        {"raw_size_bytes": True},
        {"resume_metadata": {"data": "x" * 4096}},
        {"display_name": ""},
        {"display_name": "x" * 257},
        {"display_name": " title "},
        {"display_name": "bad\nname"},
        {"display_name": 123},
    ]:
        with pytest.raises(ValidationError):
            Snapshot.model_validate({**d, **values})


def test_config_is_separate_optional_and_secret_repr() -> None:
    assert parse_session_storage({}) is None
    assert parse_session_storage({"SESSION_BACKUPS": {"ENABLED": False}}) is None
    with pytest.raises(ValueError):
        parse_session_storage({"SESSION_BACKUPS": {"ENABLED": True, "S3": {"BUCKET": "bad"}}})
    settings = SessionStorageSettings(
        S3StorageSettings(
            "private-test", S3ClientSettings("ap-south-1", access_key_id="secret-id", secret_access_key="secret-value")
        )
    )
    assert "secret" not in repr(settings)


@pytest.mark.parametrize("require_policy", [True, False])
def test_presign_required_conditional_headers_and_checksum(require_policy: bool) -> None:
    settings = SessionStorageSettings(
        parse_s3_storage(
            {
                "BUCKET": "private-test",
                "REGION": "ap-south-1",
                "CREDENTIALS": {"ACCESS_KEY_ID": "test", "SECRET_ACCESS_KEY": "test"},
            },
            "S3",
        ),
        require_create_only_policy=require_policy,
    )
    with S3Client(settings.s3.client) as s3:
        store = SessionObjectStore(settings, s3)
        snapshot = declaration(payload())
        result = store.put_url(f"axon/sessions/{uuid4()}/{uuid4()}", snapshot)
        assert result["headers"]["If-None-Match"] == "*"
        assert "if-none-match" in result["url"]
        assert "x-amz-checksum-sha256" in result["url"]
        assert "content-length" in result["url"]


def test_policy_check_fails_closed() -> None:
    from types import SimpleNamespace

    settings = SessionStorageSettings(S3StorageSettings("private-test", S3ClientSettings("ap-south-1")))
    resource = f"arn:aws:s3:::{settings.s3.bucket}/{settings.key_prefix}*"
    statements = [
        {"Effect": "Deny", "Principal": "*", "Action": "s3:PutObject", "Resource": resource, "Condition": condition}
        for condition in [
            {"Null": {"s3:if-none-match": "true"}},
            {"StringNotEquals": {"s3:if-none-match": "*"}},
        ]
    ]
    client = SimpleNamespace(
        get_public_access_block=lambda **_: {
            "PublicAccessBlockConfiguration": dict.fromkeys(
                [
                    "BlockPublicAcls",
                    "IgnorePublicAcls",
                    "BlockPublicPolicy",
                    "RestrictPublicBuckets",
                ],
                True,
            )
        },
        get_bucket_policy=lambda **_: {"Policy": json.dumps({"Statement": statements})},
        get_bucket_versioning=lambda **_: {},
        get_bucket_lifecycle_configuration=lambda **_: {"Rules": []},
    )
    policy = SessionBucketPolicy(settings, client)
    policy.assert_private_create_only()
    statements.pop()
    with pytest.raises(RuntimeError):
        policy.assert_private_create_only()
    client.get_bucket_policy = Mock(
        side_effect=ClientError({"Error": {"Code": "NoSuchBucketPolicy"}}, "GetBucketPolicy")
    )
    with pytest.raises(ClientError):
        policy.assert_private_create_only()


@pytest.mark.parametrize("value", ["absent", True, False])
def test_config_create_only_policy_toggle(value: str | bool) -> None:
    config = {"ENABLED": True, "S3": {"BUCKET": "private-test", "REGION": "ap-south-1"}}
    if value != "absent":
        config["REQUIRE_CREATE_ONLY_POLICY"] = value
    settings = parse_session_storage({"SESSION_BACKUPS": config})
    assert settings is not None
    assert settings.require_create_only_policy is (value is not False)


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}])
def test_config_rejects_non_boolean_policy_toggle(value: object) -> None:
    with pytest.raises(ValueError, match="REQUIRE_CREATE_ONLY_POLICY must be a boolean"):
        parse_session_storage(
            {
                "SESSION_BACKUPS": {
                    "ENABLED": True,
                    "S3": {"BUCKET": "private-test", "REGION": "ap-south-1"},
                    "REQUIRE_CREATE_ONLY_POLICY": value,
                },
            }
        )


@pytest.mark.parametrize("failure", [None, "public", "Enabled", "Suspended", "expiry"])
def test_disabled_policy_check_preserves_other_storage_guards(failure: str | None) -> None:
    settings = SessionStorageSettings(
        S3StorageSettings("private-test", S3ClientSettings("ap-south-1")), require_create_only_policy=False
    )
    client = Mock()
    client.get_bucket_versioning.return_value = {"Status": failure} if failure in {"Enabled", "Suspended"} else {}
    client.get_bucket_lifecycle_configuration.return_value = {
        "Rules": [{"Status": "Enabled", "Prefix": "axon/", "Expiration": {"Days": 1}}] if failure == "expiry" else []
    }
    client.get_public_access_block.return_value = {
        "PublicAccessBlockConfiguration": dict.fromkeys(
            ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"],
            failure != "public",
        )
    }
    client.get_bucket_policy.side_effect = AssertionError("Policy must not be queried when disabled")
    policy = SessionBucketPolicy(settings, client)
    if failure is None:
        policy.assert_private_create_only()
    else:
        with pytest.raises(RuntimeError):
            policy.assert_private_create_only()
    client.get_bucket_policy.assert_not_called()
