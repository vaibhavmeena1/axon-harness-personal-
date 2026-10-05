"""Write-once S3 transport and bounded streaming integrity validation."""

import base64
import hashlib
import json
import tempfile
import zlib
from collections.abc import Iterator
from datetime import datetime
from typing import Any, BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.session_storage import SessionStorageSettings
from app.services.sessions.adapters import Adapter, InvalidSessionError
from app.services.sessions.contracts import Snapshot

CHUNK = 64 * 1024


class SessionObjectStore:
    def __init__(self, settings: SessionStorageSettings) -> None:
        self.settings = settings
        self.client = boto3.client(
            "s3",
            region_name=settings.region,
            endpoint_url=settings.endpoint_url,
            aws_access_key_id=settings.access_key_id,
            aws_secret_access_key=settings.secret_access_key,
            aws_session_token=settings.session_token,
            config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=10, retries={"max_attempts": 1}),
        )

    def assert_private_create_only(self) -> None:
        """Require private, unversioned storage; optionally verify create-only policy.

        Policy verification defaults on. Disabling it skips only GetBucketPolicy
        and its deny-statement checks, not privacy, retention or conditional PUTs.
        """
        bucket, prefix = self.settings.bucket, self.settings.key_prefix
        if self.client.get_bucket_versioning(Bucket=bucket).get("Status") in {"Enabled", "Suspended"}:
            raise RuntimeError("Phase-one session storage requires an unversioned bucket")
        self.assert_no_current_expiry()
        block = self.client.get_public_access_block(Bucket=bucket)["PublicAccessBlockConfiguration"]
        if not all(
            block.get(name) is True
            for name in (
                "BlockPublicAcls",
                "IgnorePublicAcls",
                "BlockPublicPolicy",
                "RestrictPublicBuckets",
            )
        ):
            raise RuntimeError("Session bucket must block public access")
        if not self.settings.require_create_only_policy:
            return
        policy = json.loads(self.client.get_bucket_policy(Bucket=bucket)["Policy"])
        resource = f"arn:aws:s3:::{bucket}/{prefix}*"
        conditions = []
        for statement in policy.get("Statement", []):
            actions = statement.get("Action")
            resources = statement.get("Resource")
            if (
                statement.get("Effect") == "Deny"
                and statement.get("Principal") == "*"
                and "s3:PutObject" in ([actions] if isinstance(actions, str) else actions or [])
                and resource in ([resources] if isinstance(resources, str) else resources or [])
            ):
                conditions.append(statement.get("Condition", {}))
        null_denied = {"Null": {"s3:if-none-match": "true"}} in conditions
        other_denied = {"StringNotEquals": {"s3:if-none-match": "*"}} in conditions
        if not null_denied or not other_denied:
            raise RuntimeError("Session namespace needs the dedicated create-only PUT policy")

    def assert_no_current_expiry(self) -> None:
        try:
            rules = self.client.get_bucket_lifecycle_configuration(Bucket=self.settings.bucket).get("Rules", [])
        except ClientError as error:
            if error.response["Error"]["Code"] != "NoSuchLifecycleConfiguration":
                raise
            rules = []
        for rule in rules:
            prefix = rule.get(
                "Prefix", rule.get("Filter", {}).get("Prefix", rule.get("Filter", {}).get("And", {}).get("Prefix", ""))
            )
            overlaps = self.settings.key_prefix.startswith(prefix) or prefix.startswith(self.settings.key_prefix)
            if rule.get("Status") == "Enabled" and "Expiration" in rule and overlaps:
                raise RuntimeError("Current session objects must not expire by bucket age")

    def put_url(self, key: str, snapshot: Snapshot) -> dict:
        checksum = base64.b64encode(bytes.fromhex(snapshot.stored_sha256)).decode()
        params = {
            "Bucket": self.settings.bucket,
            "Key": key,
            "IfNoneMatch": "*",
            "ContentLength": snapshot.stored_size_bytes,
            "ContentType": "application/octet-stream",
            "ChecksumSHA256": checksum,
        }
        url = self.client.generate_presigned_url("put_object", Params=params, ExpiresIn=self.settings.url_seconds)
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
        return self.client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self.settings.bucket, "Key": key},
            ExpiresIn=self.settings.url_seconds,
        )

    def validate(self, key: str, snapshot: Snapshot, adapter: Adapter, native_id: str | None) -> None:
        response = self.client.get_object(Bucket=self.settings.bucket, Key=key)
        body = response["Body"]
        try:
            if response["ContentLength"] != snapshot.stored_size_bytes:
                raise InvalidSessionError("Stored size mismatch")
            with tempfile.TemporaryFile() as raw:
                verify_chunks(iter(lambda: body.read(CHUNK), b""), snapshot, raw)
                display_name = adapter.validate(raw, native_id, snapshot.resume_metadata)
                if display_name != snapshot.display_name:
                    raise InvalidSessionError("Display name does not match session archive")
        finally:
            body.close()

    def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.settings.bucket, Key=key)

    def objects(self) -> Iterator[tuple[str, datetime]]:
        pages = self.client.get_paginator("list_objects_v2").paginate(
            Bucket=self.settings.bucket,
            Prefix=self.settings.key_prefix,
        )
        for page in pages:
            for item in page.get("Contents", []):
                yield item["Key"], item["LastModified"]


def _inflate(decoder: Any, chunk: bytes, remaining: int) -> Iterator[bytes]:
    while chunk:
        data = decoder.decompress(chunk, min(CHUNK, remaining + 1))
        remaining -= len(data)
        if remaining < 0:
            raise InvalidSessionError("Raw payload exceeds declared size")
        yield data
        if decoder.unused_data:
            raise InvalidSessionError("Trailing or concatenated gzip data")
        chunk = decoder.unconsumed_tail


def verify_chunks(chunks: Iterator[bytes], snapshot: Snapshot, raw: BinaryIO) -> None:
    """Limit decompressed output before allocating it; reject extra gzip members."""
    stored_hash, raw_hash = hashlib.sha256(), hashlib.sha256()
    stored_size = raw_size = 0
    decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if snapshot.encoding == "gzip" else None

    def write(data: bytes) -> None:
        nonlocal raw_size
        raw_size += len(data)
        if raw_size > snapshot.raw_size_bytes:
            raise InvalidSessionError("Raw payload exceeds declared size")
        raw_hash.update(data)
        raw.write(data)

    try:
        for chunk in chunks:
            stored_size += len(chunk)
            if stored_size > snapshot.stored_size_bytes:
                raise InvalidSessionError("Stored payload exceeds declared size")
            stored_hash.update(chunk)
            if decoder is None:
                write(chunk)
            else:
                for data in _inflate(decoder, chunk, snapshot.raw_size_bytes - raw_size):
                    write(data)
        if decoder is not None and not decoder.eof:
            raise InvalidSessionError("Incomplete gzip stream")
    except zlib.error:
        raise InvalidSessionError("Invalid gzip stream") from None
    if (
        stored_size != snapshot.stored_size_bytes
        or raw_size != snapshot.raw_size_bytes
        or stored_hash.hexdigest() != snapshot.stored_sha256
        or raw_hash.hexdigest() != snapshot.raw_sha256
    ):
        raise InvalidSessionError("Session integrity mismatch")
