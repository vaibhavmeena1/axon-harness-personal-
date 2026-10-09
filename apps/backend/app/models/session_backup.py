"""One harness-neutral latest pointer and pending slot.

The legacy membership is mapped as a scalar BIGINT, with its physical FK owned
by the SQL migrations. Registering a Tortoise legacy membership model would accidentally
make schema generation own/create an unrelated table.
"""

from uuid import uuid4

from tortoise import fields

from app.models.base import BaseModel


class SessionBackup(BaseModel):
    id = fields.UUIDField(primary_key=True, default=uuid4)
    owner_user_team_id = fields.BigIntField()
    client_session_key = fields.UUIDField()
    harness = fields.CharField(max_length=128)
    harness_session_id = fields.CharField(max_length=256, null=True)
    device_id = fields.UUIDField()
    session_format = fields.CharField(max_length=128)
    update_token = fields.UUIDField(default=uuid4)
    object_key = fields.TextField(null=True)
    display_name = fields.CharField(max_length=256, null=True)
    raw_sha256 = fields.CharField(max_length=64, null=True)
    stored_sha256 = fields.CharField(max_length=64, null=True)
    raw_size_bytes = fields.BigIntField(null=True)
    stored_size_bytes = fields.BigIntField(null=True)
    encoding = fields.CharField(max_length=16, null=True)
    session_format_version = fields.CharField(max_length=128, null=True)
    resume_metadata = fields.JSONField(null=True)
    last_committed_request_id = fields.UUIDField(null=True)
    last_backup_at = fields.DatetimeField(null=True)
    pending_request_id = fields.UUIDField(null=True)
    pending_object_key = fields.TextField(null=True)
    pending_expected_token = fields.UUIDField(null=True)
    pending_expires_at = fields.DatetimeField(null=True)
    pending_snapshot = fields.JSONField(null=True)
    created_at = fields.DatetimeField(auto_now_add=True)
    updated_at = fields.DatetimeField(auto_now=True)
    deleted_at = fields.DatetimeField(null=True)

    class Meta:
        table = "sessions"
        unique_together = (("owner_user_team_id", "client_session_key"),)
