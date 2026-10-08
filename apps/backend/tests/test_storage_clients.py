"""Offline tests for reusable S3 transport and local CloudFront signing."""

import base64
import io
import json
from datetime import UTC, datetime
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

import pytest
from botocore.exceptions import ClientError
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from app.clients import s3 as s3_module
from app.clients.cloudfront import CloudFrontUrlSigner
from app.clients.s3 import S3Client
from app.core.s3 import S3ClientSettings, S3StorageSettings, parse_s3_storage
from app.core.session_storage import SessionStorageSettings
from app.services.sessions.storage import SessionObjectStore
from tests.test_cli_releases import release_settings


@pytest.mark.parametrize("explicit_credentials", [False, True])
def test_s3_construction_and_connection_settings(monkeypatch: pytest.MonkeyPatch, explicit_credentials: bool) -> None:
    sdk = Mock()
    session = Mock()
    session.client.return_value = sdk
    factory = Mock(return_value=session)
    monkeypatch.setattr(s3_module.boto3.session, "Session", factory)
    settings = S3ClientSettings("ap-south-1")
    if explicit_credentials:
        settings = parse_s3_storage(
            {
                "BUCKET": "private-sessions",
                "REGION": "ap-south-1",
                "ENDPOINT_URL": "https://objects.example.test",
                "CREDENTIALS": {
                    "ACCESS_KEY_ID": "secret-access-id",
                    "SECRET_ACCESS_KEY": "secret-key",
                    "SESSION_TOKEN": "secret-token",
                },
            },
            "S3",
            connect_timeout=5,
            read_timeout=10,
            max_retries=1,
        ).client
    with S3Client(settings):
        factory.assert_called_once_with()
        args, kwargs = session.client.call_args
        assert args == ("s3",)
        assert kwargs["region_name"] == settings.region
        assert kwargs["endpoint_url"] == settings.endpoint_url
        assert kwargs["aws_access_key_id"] == settings.access_key_id
        assert kwargs["aws_secret_access_key"] == settings.secret_access_key
        assert kwargs["aws_session_token"] == settings.session_token
        config = kwargs["config"]
        assert config.signature_version == "s3v4"
        assert config.connect_timeout == (5 if explicit_credentials else 60)
        assert config.read_timeout == (10 if explicit_credentials else 60)
        assert config.retries == ({"max_attempts": 1} if explicit_credentials else None)
        assert "secret" not in repr(settings)
    sdk.close.assert_called_once_with()


def test_presigning_keeps_caller_scope_and_does_not_add_domain_policy() -> None:
    sdk = Mock()
    sdk.generate_presigned_url.return_value = "https://objects.example.test/signed"
    with S3Client(S3ClientSettings("ap-south-1"), client=sdk) as s3:
        parameters = {"ContentType": "text/plain", "Bucket": "wrong-bucket", "Key": "wrong-key"}
        assert s3.presign_put("bucket", "prefix/key", expires_in=45, parameters=parameters).endswith("/signed")
        sdk.generate_presigned_url.assert_called_with(
            "put_object",
            Params={"Bucket": "bucket", "Key": "prefix/key", "ContentType": "text/plain"},
            ExpiresIn=45,
            HttpMethod="PUT",
        )
        assert parameters["Bucket"] == "wrong-bucket"  # Do not mutate caller parameters.
        s3.presign_get("bucket", "prefix/key", expires_in=90)
        sdk.generate_presigned_url.assert_called_with(
            "get_object", Params={"Bucket": "bucket", "Key": "prefix/key"}, ExpiresIn=90, HttpMethod="GET"
        )


@pytest.mark.parametrize("reject", [False, True])
def test_streaming_body_is_closed_on_success_and_consumer_failure(reject: bool) -> None:
    sdk = Mock()
    body = io.BytesIO(b"synthetic")
    sdk.get_object.return_value = {"Body": body, "ContentLength": 9}
    with S3Client(S3ClientSettings("ap-south-1"), client=sdk) as s3:

        def consume() -> None:
            with s3.read("bucket", "key") as response:
                assert response["Body"].read() == b"synthetic"
                if reject:
                    raise ValueError("Invalid payload")

        if reject:
            with pytest.raises(ValueError, match="Invalid payload"):
                consume()
        else:
            consume()
        assert body.closed
        sdk.get_object.assert_called_once_with(Bucket="bucket", Key="key")


def test_listing_is_lazy_paginated_and_delete_is_scoped() -> None:
    sdk = Mock()
    stamp = datetime.now(UTC)
    pages = [{}, {"Contents": [{"Key": "prefix/a", "LastModified": stamp}]}, {"Contents": []}]
    sdk.get_paginator.return_value.paginate.return_value = iter(pages)
    with S3Client(S3ClientSettings("ap-south-1"), client=sdk) as s3:
        objects = s3.objects("bucket", "prefix/")
        sdk.get_paginator.assert_not_called()
        assert list(objects) == [("prefix/a", stamp)]
        sdk.get_paginator.assert_called_once_with("list_objects_v2")
        sdk.get_paginator.return_value.paginate.assert_called_once_with(Bucket="bucket", Prefix="prefix/")
        s3.delete("bucket", "prefix/a")
        sdk.delete_object.assert_called_once_with(Bucket="bucket", Key="prefix/a")


def test_sdk_errors_propagate_without_becoming_silent_successes() -> None:
    error = ClientError({"Error": {"Code": "AccessDenied"}}, "DeleteObject")
    sdk = Mock()
    sdk.delete_object.side_effect = error
    with S3Client(S3ClientSettings("ap-south-1"), client=sdk) as s3:
        with pytest.raises(ClientError) as caught:
            s3.delete("bucket", "key")
        assert caught.value is error


def test_session_adapter_preserves_signed_snapshot_parameters() -> None:
    from tests.test_session_backups import declaration, payload

    settings = SessionStorageSettings(S3StorageSettings("private-sessions", S3ClientSettings("ap-south-1")))
    sdk = Mock()
    sdk.generate_presigned_url.return_value = "signed-upload"
    with S3Client(settings.s3.client, client=sdk) as s3:
        store = SessionObjectStore(settings, s3)
        snapshot = declaration(payload())
        upload = store.put_url("axon/sessions/test", snapshot)
        sdk.generate_presigned_url.assert_called_once_with(
            "put_object",
            Params={
                "Bucket": settings.s3.bucket,
                "Key": "axon/sessions/test",
                "IfNoneMatch": "*",
                "ContentLength": snapshot.stored_size_bytes,
                "ContentType": "application/octet-stream",
                "ChecksumSHA256": upload["headers"]["x-amz-checksum-sha256"],
            },
            ExpiresIn=settings.url_seconds,
            HttpMethod="PUT",
        )
        assert upload["expires_in"] == settings.url_seconds
        assert upload["headers"]["Content-Length"] == str(snapshot.stored_size_bytes)
        store.get_url("axon/sessions/test")
        assert sdk.generate_presigned_url.call_args.kwargs["HttpMethod"] == "GET"


def test_cloudfront_signature_expiry_encoding_and_reuse(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = release_settings()
    signer = CloudFrontUrlSigner(settings.distribution_url, settings.key_pair_id, settings.private_key)
    key = serialization.load_pem_private_key(settings.private_key.encode(), password=None)
    assert isinstance(key, rsa.RSAPrivateKey)
    # Reusing a signer must not reload/parse private keys on each download.
    loader = Mock(side_effect=AssertionError("Key must already be loaded"))
    monkeypatch.setattr(serialization, "load_pem_private_key", loader)
    before = int(datetime.now(UTC).timestamp())
    url = signer.sign_get("releases/archive +file.gz", expires_in=120)
    after = int(datetime.now(UTC).timestamp())
    parts = urlsplit(url)
    assert parts.path == "/releases/archive%20%2Bfile.gz"
    query = parse_qs(parts.query)
    expires = int(query["Expires"][0])
    assert before + 120 <= expires <= after + 120
    assert query["Key-Pair-Id"] == [settings.key_pair_id]
    policy = json.dumps(
        {"Statement": [{"Resource": url.split("?", 1)[0], "Condition": {"DateLessThan": {"AWS:EpochTime": expires}}}]},
        separators=(",", ":"),
    ).encode()
    signature = base64.b64decode(query["Signature"][0].replace("-", "+").replace("_", "=").replace("~", "/"))
    key.public_key().verify(signature, policy, padding.PKCS1v15(), hashes.SHA1())
    signer.sign_get("another-key", expires_in=60)
    loader.assert_not_called()


def test_cloudfront_rejects_non_rsa_keys() -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
    ).decode()
    with pytest.raises(ValueError, match="must be RSA"):
        CloudFrontUrlSigner("https://cdn.example.test", "TEST_KEY", pem)
