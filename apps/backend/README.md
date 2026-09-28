# DeputyDev Console Backend

The centralized management API for DeputyDev CLI installations. It also serves the `apps/frontend` console as static files from the same origin.

## Prerequisites

- Python 3.12
- [uv](https://docs.astral.sh/uv/)

## Setup

```bash
cd apps/backend
cp config_template.json config.json # already created locally; repeat when resetting it
make install
```

`config.json` is local and git-ignored. Keep `config_template.json` updated whenever the configuration shape changes.

The backend loads `config.json` from this directory and validates it before serving requests. The Vortex audit in [`VORTEX_REFERENCE.md`](VORTEX_REFERENCE.md) describes the former stack and is not current implementation guidance.

## Serving the console frontend

This service also serves `apps/frontend`. The console is a Vite build — an `index.html` plus content-hashed files under `assets/` — with nothing to run, so hosting it here keeps one origin, one deploy, and one version for the API and the UI, and removes CORS entirely.

Routing, in match order:

| Path | Served by |
| --- | --- |
| `/api/v1/*` | FastAPI routers |
| `/install.sh` | Public, unauthenticated CLI installer |
| `/api/v1/cli/releases/*` | Public release discovery, hashes, and CloudFront downloads; private upload-signing POST |
| `/ping` | FastAPI liveness route |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* the API routers, including `/install.sh`. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every registered route has been tried.

`/install.sh` serves the repository's `apps/cli/install.sh` with only its default release base URL substituted from `CLI_INSTALL.RELEASES_URL` in `config.json`. The Docker image copies that same script alongside the backend. Set `RELEASES_URL` to `https://YOUR_ORIGIN/api/v1/cli/releases` (no trailing slash); it is public and must contain no credentials. The script resolves `/latest/VERSION` once, then fetches `/<version>/checksums.txt` and `/<version>/ddcli-darwin-arm64.gz`. Downloads redirect to short-lived **signed CloudFront** URLs; S3 presigned GET is available internally but bypasses the cache. Installer, release pointer, checksums, and redirect responses are not cached. Users can install with `curl -fsSL https://YOUR_ORIGIN/install.sh | sh` or download the script for inspection first.

### CLI releases (macOS arm64 only)

Copy the `CLI_RELEASES` section from `config_template.json` into the ignored `config.json`. The checked-in example is **disabled**, with placeholder bucket, signing credentials, and hashes. Set a private S3 `BUCKET`, `REGION`, an immutable `KEY_PREFIX`, a random `UPLOAD_AUTH_KEY` of at least 32 characters, CloudFront `DISTRIBUTION_URL`, trusted `KEY_PAIR_ID` and RSA `PRIVATE_KEY` (PEM with newlines represented as JSON `\\n`). Supply each version's `s3_key`, compressed `archive_sha256`, and decompressed `binary_sha256` under `VERSIONS`, with `LATEST_VERSION` referencing an already published version (leave it empty while staging the very first release; public `latest` returns 503 until promotion). Set `ENABLED` to `true` only after real values are provided. The server validates enabled settings at startup. Settings are cached: **restart the backend** after staging a version or promoting `LATEST_VERSION`.

The private bucket should permit origin reads only through CloudFront Origin Access Control, and allow backend role `s3:PutObject` for the dedicated `cli/releases/` prefix (plus `s3:GetObject` only if internal direct GET signing is required). Enable bucket versioning / protect published keys against deletion. Allow the CloudFront trusted key group to verify signed URLs. Use short-lived AWS role credentials (default AWS credential chain); do **not** put AWS access keys, the upload secret, or the CloudFront private key into `install.sh`, checked-in config, frontend assets, or CLI builds. Anyone who can reach the public endpoint can obtain a short-lived download URL; the upload signer is secret-protected.

`POST /api/v1/cli/releases/uploads/presign` requires `Authorization: Bearer <UPLOAD_AUTH_KEY>` and JSON `{ "version": "0.2.0" }`. It signs **only** the preconfigured version's S3 key, returning `url`, `headers`, and `expires_in`. Send every returned header on PUT; the signed SHA-256 checksum makes S3 validate the bytes and `If-None-Match: *` refuses overwrites. Never log or share the URL. `GET /api/v1/cli/releases/latest/VERSION` and `GET /api/v1/cli/releases/<version>/checksums.txt` are public; the exact-version archive endpoint returns an uncached 302 to CloudFront. Upload and verify the new release **before** moving `LATEST_VERSION`. See [the manual publishing procedure](../cli/README.md#releasing).

Checksums obtained from the same backend detect corruption and mismatch, not compromise of that backend. Stronger independent artifact authentication would require a separately signed update manifest.

A missing asset under `/assets/` and an unknown path under `/api/` both return a plain-text 404 instead of `index.html`. FastAPI handles other HTTP exceptions with its normal status codes and response bodies; Vortex's legacy error envelope and status remapping are no longer installed. Vortex's request-context middleware, structured logging, Sentry, and OpenTelemetry integrations are also no longer installed automatically.

`FRONTEND_DIR` in `config.json` points at the build (default `static/`, relative to this directory). When it is absent the service starts normally and serves the API only — which is the usual local setup, where `vite dev` serves the console on port 8010 and proxies `/api` here.

To serve the console locally from this service instead:

```bash
bun run build:frontend                 # from the repository root
cp -R ../frontend/dist ./static
```

`static/` is git-ignored; the Docker build populates it.

## Docker

The image builds the frontend and embeds it, so **the build context is the repository root**, not this directory:

```bash
DOCKER_BUILDKIT=1 docker build --build-arg SERVICE_NAME=deputydev-console-backend -t deputydev-console-backend .
```

Or `bun run build:backend-image` from the repository root.

The Python dependencies resolve from PyPI; no Bitbucket SSH forwarding is required.

The build assumes it can reach npm, PyPI, and GitHub over untampered TLS. On a developer machine behind a TLS-intercepting proxy it will fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `invalid peer certificate: UnknownIssuer`; build from a network without interception.

### Stage layout

The frontend stage runs on `$BUILDPLATFORM` (natively), because its output is architecture-independent; pinning it to `linux/amd64` would run the whole Node toolchain under QEMU on an Apple Silicon machine. The Python stages stay on `linux/amd64` to match the deployment target, so they *are* emulated locally and are correspondingly slower. Node exists only in the frontend stage; the runtime image gets the built bundle and no JavaScript toolchain.

## Commands

```bash
make install       # create/update .venv from uv.lock
make lock          # update uv.lock
make lint          # run Ruff linting
make format        # apply Ruff lint and formatting fixes
make format-check  # verify Ruff formatting
make test          # run pytest once tests exist
make check         # format-check, lint, and test
make pre-commit    # run every pre-commit hook
```
