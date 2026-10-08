# Security Policy

## Supported versions

Security fixes are provided for the latest published stable `0.1.x` release. Users should install the newest stable release before reporting a problem that may already be fixed.

## Reporting a vulnerability

Please report vulnerabilities privately through the repository's **Security** tab using a GitHub private vulnerability report. Do not open a public issue for a suspected vulnerability or publish exploit details before a fix is available.

Include, when possible:

- the output of `axon --version`
- macOS and architecture details
- the affected command or installation step
- reproduction steps and impact
- relevant logs with credentials, tokens, home paths, and service URLs redacted

You should receive an acknowledgement after the report is reviewed. Disclosure timing will be coordinated with the reporter based on severity and release readiness.

## Distribution security

Release archives include compressed and decompressed SHA-256 hashes and GitHub artifact provenance. The installer verifies both hashes, the executable's code signature, and the exact release version before atomic activation.

The current MVP is ad-hoc signed and is **not** Apple Developer ID signed or notarized. The project does not recommend disabling Gatekeeper globally. See the README for the narrow quarantine recovery procedure that may be used only after artifact verification.
