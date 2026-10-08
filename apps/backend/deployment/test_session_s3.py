"""Opt-in live S3 smoke test. Credentials only from AWS SDK environment/roles.

Uses synthetic JSONL and unique test objects. Never changes bucket policy.
Usage: AWS_BUCKET_NAME=... AWS_REGION=... uv run python -m deployment.test_session_s3
"""

import hashlib
import io
import json
import os
from uuid import uuid4

import httpx
from botocore.exceptions import BotoCoreError, ClientError

from app.clients.s3 import S3Client
from app.core.s3 import parse_s3_storage
from app.core.session_storage import SessionStorageSettings
from app.services.sessions.adapters import get_adapter
from app.services.sessions.contracts import Snapshot
from app.services.sessions.storage import SessionObjectStore


def main() -> int:
    settings = SessionStorageSettings(
        s3=parse_s3_storage(
            {
                "BUCKET": os.environ["AWS_BUCKET_NAME"],
                "REGION": os.environ.get("AWS_REGION", "ap-south-1"),
                "ENDPOINT_URL": os.environ.get("AWS_ENDPOINT_URL"),
            },
            "S3",
            connect_timeout=5,
            read_timeout=10,
            max_retries=1,
        ),
        key_prefix=os.environ.get("SESSION_KEY_PREFIX", "axon/sessions/"),
    )
    s3 = S3Client(settings.s3.client)
    store = SessionObjectStore(settings, s3)
    key = f"{settings.key_prefix}{uuid4()}/{uuid4()}"
    native = str(uuid4())
    raw = (
        json.dumps(
            {
                "type": "session",
                "version": 3,
                "id": native,
                "cwd": "/synthetic-test",
                "timestamp": "2026-01-01T00:00:00Z",
            }
        )
        + "\n"
        + json.dumps(
            {
                "type": "custom",
                "id": "test",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:00Z",
                "customType": "synthetic",
                "data": {"test": True},
            }
        )
        + "\n"
    ).encode()
    sha = hashlib.sha256(raw).hexdigest()
    snapshot = Snapshot(
        display_name=None,
        raw_sha256=sha,
        stored_sha256=sha,
        raw_size_bytes=len(raw),
        stored_size_bytes=len(raw),
        encoding="identity",
        session_format_version="3",
        resume_metadata={"leaf_known": True, "selected_leaf_id": "test"},
    )
    results = {}
    try:
        try:
            store.assert_private_create_only()
            results["private_create_only_policy"] = True
        except (ClientError, BotoCoreError, RuntimeError):
            results["private_create_only_policy"] = False
        upload = store.put_url(key, snapshot)
        with httpx.Client(follow_redirects=False, timeout=30, trust_env=False) as client:
            first = client.put(upload["url"], headers=upload["headers"], content=raw)
            results["signed_put"] = first.status_code == 200
            if first.status_code != 200:
                results["put_http_status"] = first.status_code
                raise RuntimeError("Synthetic PUT failed")
            results["conditional_overwrite_denied"] = (
                client.put(upload["url"], headers=upload["headers"], content=raw).status_code == 412
            )
            store.validate(key, snapshot, get_adapter("pi", "pi-jsonl", "3"), native)
            results["streaming_integrity_and_pi_validation"] = True
            download = client.get(store.get_url(key))
            results["signed_get"] = download.status_code == 200 and download.content == raw
            public = client.get(upload["url"].split("?", 1)[0])
            results["anonymous_get_denied"] = public.status_code in {401, 403}
        # Verify policy, not just a header signed into one URL. Only our disposable test key is touched.
        try:
            store.s3.client.put_object(Bucket=settings.s3.bucket, Key=key, Body=io.BytesIO(raw))
            results["unconditional_overwrite_denied"] = False
        except ClientError as error:
            results["unconditional_overwrite_denied"] = error.response["ResponseMetadata"]["HTTPStatusCode"] == 403
    except (ClientError, BotoCoreError) as error:
        results["sdk_error"] = type(error).__name__  # No exception text, URLs, keys or credentials.
    except httpx.HTTPError:
        results["network_error"] = "request_failed"
    except ValueError:
        results["validation_error"] = "validation_failed"
    except RuntimeError:
        results["test_error"] = "test_failed"
    finally:
        try:
            store.delete(key)
            results["test_object_cleanup"] = True
        except (ClientError, BotoCoreError):
            results["test_object_cleanup"] = False
        finally:
            s3.close()
    return report(results)


def report(results: dict) -> int:
    print(json.dumps(results, sort_keys=True))  # noqa: T201 - redacted CLI test report
    required = {
        "private_create_only_policy",
        "signed_put",
        "conditional_overwrite_denied",
        "streaming_integrity_and_pi_validation",
        "signed_get",
        "anonymous_get_denied",
        "unconditional_overwrite_denied",
        "test_object_cleanup",
    }
    return 0 if required.issubset(results) and all(value is True for value in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
