"""Reusable S3 transport, independent of release and session-storage policy."""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime
from typing import Any

import boto3
from botocore.client import BaseClient
from botocore.config import Config

from app.core.s3 import S3ClientSettings


class S3Client:
    """Own one SDK connection pool; callers own its lifetime and supply bucket/key scope.

    SDK errors propagate to the domain/API boundary. Never log signed URLs or
    credentials here. An injected SDK client is also owned and closed by this wrapper.
    """

    def __init__(self, settings: S3ClientSettings, *, client: BaseClient | None = None) -> None:
        self.client = client
        if self.client is None:
            config = Config(
                signature_version="s3v4",
                connect_timeout=settings.connect_timeout,
                read_timeout=settings.read_timeout,
                retries={"max_attempts": settings.max_retries} if settings.max_retries is not None else None,
            )
            # A dedicated Session avoids the shared default session during threaded startup.
            # None credentials retain the AWS default credential chain / role refresh.
            self.client = boto3.session.Session().client(
                "s3",
                region_name=settings.region,
                endpoint_url=settings.endpoint_url,
                aws_access_key_id=settings.access_key_id,
                aws_secret_access_key=settings.secret_access_key,
                aws_session_token=settings.session_token,
                config=config,
            )

    def presign_put(self, bucket: str, key: str, *, expires_in: int, parameters: Mapping[str, Any]) -> str:
        return self.client.generate_presigned_url(
            "put_object",
            Params={**parameters, "Bucket": bucket, "Key": key},
            ExpiresIn=expires_in,
            HttpMethod="PUT",
        )

    def presign_get(self, bucket: str, key: str, *, expires_in: int) -> str:
        return self.client.generate_presigned_url(
            "get_object", Params={"Bucket": bucket, "Key": key}, ExpiresIn=expires_in, HttpMethod="GET"
        )

    @contextmanager
    def read(self, bucket: str, key: str) -> Iterator[dict[str, Any]]:
        """Close the streaming body even if the consumer rejects the object."""
        response = self.client.get_object(Bucket=bucket, Key=key)
        try:
            yield response
        finally:
            response["Body"].close()

    def delete(self, bucket: str, key: str) -> None:
        self.client.delete_object(Bucket=bucket, Key=key)

    def objects(self, bucket: str, prefix: str) -> Iterator[tuple[str, datetime]]:
        pages = self.client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix)
        for page in pages:
            for item in page.get("Contents", []):
                yield item["Key"], item["LastModified"]

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "S3Client":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
