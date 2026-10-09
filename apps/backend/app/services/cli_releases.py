"""Release selection and immutable upload rules over injected signing components."""

import base64

from app.clients.cloudfront import CloudFrontUrlSigner
from app.clients.s3 import S3Client
from app.core.config import CliReleaseAsset, CliReleaseSettings

ARCHIVE_NAME = "axon-darwin-arm64.gz"
BINARY_NAME = "axon-darwin-arm64"
IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"


def archive_for_version(settings: CliReleaseSettings, version: str) -> CliReleaseAsset | None:
    return settings.versions.get(version)


class CliReleaseService:
    def __init__(self, settings: CliReleaseSettings, s3: S3Client, cloudfront: CloudFrontUrlSigner) -> None:
        self.settings = settings
        self.s3 = s3
        self.cloudfront = cloudfront

    def presign_s3_put(self, asset: CliReleaseAsset) -> tuple[str, dict[str, str]]:
        """Sign an immutable, checksum-validated PUT. Caller must send every returned header."""
        checksum = base64.b64encode(bytes.fromhex(asset.archive_sha256)).decode("ascii")
        headers = {
            "Content-Type": "application/gzip",
            "Cache-Control": IMMUTABLE_CACHE_CONTROL,
            "If-None-Match": "*",
            "x-amz-checksum-sha256": checksum,
        }
        url = self.s3.presign_put(
            self.settings.s3.bucket,
            asset.s3_key,
            expires_in=self.settings.put_url_expiry_seconds,
            parameters={
                "ContentType": headers["Content-Type"],
                "CacheControl": headers["Cache-Control"],
                "IfNoneMatch": headers["If-None-Match"],
                "ChecksumSHA256": checksum,
            },
        )
        return url, headers

    def presign_s3_get(self, asset: CliReleaseAsset) -> str:
        """Direct S3 GET for internal use; public downloads should use CloudFront instead."""
        return self.s3.presign_get(
            self.settings.s3.bucket, asset.s3_key, expires_in=self.settings.get_url_expiry_seconds
        )

    def signed_cloudfront_get(self, asset: CliReleaseAsset) -> str:
        """CloudFront verifies the signature at the edge; OAC keeps the bucket private."""
        return self.cloudfront.sign_get(asset.s3_key, expires_in=self.settings.get_url_expiry_seconds)
