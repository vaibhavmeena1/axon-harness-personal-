"""Session-only private, unversioned, create-only bucket requirements."""

import json

from botocore.client import BaseClient
from botocore.exceptions import ClientError

from app.core.session_storage import SessionStorageSettings


class SessionBucketPolicy:
    def __init__(self, settings: SessionStorageSettings, client: BaseClient) -> None:
        self.settings = settings
        self.client = client

    def assert_private_create_only(self) -> None:
        """Require private, unversioned storage; optionally verify create-only policy.

        Policy verification defaults on. Disabling it skips only GetBucketPolicy
        and its deny-statement checks, not privacy, retention or conditional PUTs.
        """
        bucket, prefix = self.settings.s3.bucket, self.settings.key_prefix
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
            rules = self.client.get_bucket_lifecycle_configuration(Bucket=self.settings.s3.bucket).get("Rules", [])
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
