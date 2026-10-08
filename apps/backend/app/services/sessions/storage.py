"""Session-specific write-once uploads and payload validation over an injected S3 transport."""

import base64
import tempfile
from collections.abc import Iterator
from datetime import datetime

from app.clients.s3 import S3Client
from app.core.session_storage import SessionStorageSettings
from app.services.sessions.adapters import Adapter, InvalidSessionError
from app.services.sessions.bucket_policy import SessionBucketPolicy
from app.services.sessions.contracts import Snapshot
from app.services.sessions.integrity import CHUNK, verify_chunks


class SessionObjectStore:
    def __init__(self, settings: SessionStorageSettings, s3: S3Client) -> None:
        self.settings = settings
        self.s3 = s3
        self._policy = SessionBucketPolicy(settings, s3.client)

    def assert_private_create_only(self) -> None:
        self._policy.assert_private_create_only()

    def put_url(self, key: str, snapshot: Snapshot) -> dict:
        checksum = base64.b64encode(bytes.fromhex(snapshot.stored_sha256)).decode()
        url = self.s3.presign_put(
            self.settings.s3.bucket,
            key,
            expires_in=self.settings.url_seconds,
            parameters={
                "IfNoneMatch": "*",
                "ContentLength": snapshot.stored_size_bytes,
                "ContentType": "application/octet-stream",
                "ChecksumSHA256": checksum,
            },
        )
        return {
            "url": url,
            "headers": {
                "If-None-Match": "*",
                "Content-Type": "application/octet-stream",
                "Content-Length": str(snapshot.stored_size_bytes),
                "x-amz-checksum-sha256": checksum,
            },
            "expires_in": self.settings.url_seconds,
        }

    def get_url(self, key: str) -> str:
        return self.s3.presign_get(self.settings.s3.bucket, key, expires_in=self.settings.url_seconds)

    def validate(self, key: str, snapshot: Snapshot, adapter: Adapter, native_id: str | None) -> None:
        with self.s3.read(self.settings.s3.bucket, key) as response:
            if response["ContentLength"] != snapshot.stored_size_bytes:
                raise InvalidSessionError("Stored size mismatch")
            with tempfile.TemporaryFile() as raw:
                body = response["Body"]
                verify_chunks(iter(lambda: body.read(CHUNK), b""), snapshot, raw)
                display_name = adapter.validate(raw, native_id, snapshot.resume_metadata)
                if display_name != snapshot.display_name:
                    raise InvalidSessionError("Display name does not match session archive")

    def delete(self, key: str) -> None:
        self.s3.delete(self.settings.s3.bucket, key)

    def objects(self) -> Iterator[tuple[str, datetime]]:
        return self.s3.objects(self.settings.s3.bucket, self.settings.key_prefix)
