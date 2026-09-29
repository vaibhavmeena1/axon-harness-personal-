"""Release URL signing. Only the configured immutable archive keys may be signed."""

import base64
from datetime import datetime, timedelta, timezone
from functools import cache
from urllib.parse import quote

import boto3
from botocore.client import BaseClient
from botocore.config import Config
from botocore.signers import CloudFrontSigner
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.core.config import CliReleaseAsset, CliReleaseSettings

ARCHIVE_NAME = "ddcli-darwin-arm64.gz"
BINARY_NAME = "ddcli-darwin-arm64"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


def archive_for_version(settings: CliReleaseSettings, version: str) -> CliReleaseAsset | None:
    return settings.versions.get(version)


def _s3_client(settings: CliReleaseSettings) -> BaseClient:
    # Use the AWS default credential chain (role in production, profile locally).
    return boto3.client("s3", region_name=settings.region, config=Config(signature_version="s3v4"))


def presign_s3_put(settings: CliReleaseSettings, asset: CliReleaseAsset) -> tuple[str, dict[str, str]]:
    """Sign an immutable, checksum-validated PUT. Caller must send every returned header."""
    checksum = base64.b64encode(bytes.fromhex(asset.archive_sha256)).decode("ascii")
    headers = {
        "Content-Type": "application/gzip",
        "Cache-Control": IMMUTABLE_CACHE_CONTROL,
        "If-None-Match": "*",
        "x-amz-checksum-sha256": checksum,
    }
    url = _s3_client(settings).generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.bucket,
            "Key": asset.s3_key,
            "ContentType": headers["Content-Type"],
            "CacheControl": headers["Cache-Control"],
            "IfNoneMatch": headers["If-None-Match"],
            "ChecksumSHA256": checksum,
        },
        ExpiresIn=settings.put_url_expiry_seconds,
        HttpMethod="PUT",
    )
    return url, headers


def presign_s3_get(settings: CliReleaseSettings, asset: CliReleaseAsset) -> str:
    """Direct S3 GET for internal use; public downloads should use CloudFront instead."""
    return _s3_client(settings).generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.bucket, "Key": asset.s3_key},
        ExpiresIn=settings.get_url_expiry_seconds,
        HttpMethod="GET",
    )


@cache
def _cloudfront_signer(key_pair_id: str, private_key_pem: str) -> CloudFrontSigner:
    key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError("CloudFront private key must be RSA")

    def sign(message: bytes) -> bytes:
        return key.sign(message, padding.PKCS1v15(), hashes.SHA1())

    return CloudFrontSigner(key_pair_id, sign)


def signed_cloudfront_get(settings: CliReleaseSettings, asset: CliReleaseAsset) -> str:
    """CloudFront verifies the signature at the edge; OAC keeps the bucket private."""
    url = f"{settings.distribution_url}/{quote(asset.s3_key, safe='/')}"
    expires = datetime.now(timezone.utc) + timedelta(seconds=settings.get_url_expiry_seconds)
    return _cloudfront_signer(settings.key_pair_id, settings.private_key).generate_presigned_url(
        url, date_less_than=expires
    )
