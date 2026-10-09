"""Local CloudFront URL signing; this does not call the CloudFront AWS API."""

from datetime import UTC, datetime, timedelta
from urllib.parse import quote

from botocore.signers import CloudFrontSigner
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


class CloudFrontUrlSigner:
    """Parse the private key once and reuse its signer for this application's lifetime."""

    def __init__(self, distribution_url: str, key_pair_id: str, private_key_pem: str) -> None:
        self._distribution_url = distribution_url.rstrip("/")
        key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        if not isinstance(key, rsa.RSAPrivateKey):
            raise ValueError("CloudFront private key must be RSA")

        def sign(message: bytes) -> bytes:
            return key.sign(message, padding.PKCS1v15(), hashes.SHA1())

        self._signer = CloudFrontSigner(key_pair_id, sign)

    def sign_get(self, key: str, *, expires_in: int) -> str:
        """The caller selects an authorized object key and expiry."""
        url = f"{self._distribution_url}/{quote(key, safe='/')}"
        expires = datetime.now(UTC) + timedelta(seconds=expires_in)
        return self._signer.generate_presigned_url(url, date_less_than=expires)
