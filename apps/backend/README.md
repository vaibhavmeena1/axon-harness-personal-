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
| `/api/v1/auth/browser-login` | Existing public browser-login start POST and GET polling at `/{session_id}` |
| `/api/v1/cli/config` | Session-authenticated, non-secret CLI telemetry settings |
| `/api/v1/otel/v1/{traces,metrics,logs}` | Session-authenticated OTLP/HTTP proxy with authoritative identity |
| `/api/v1/cli/releases/*` | Public release discovery, hashes, and CloudFront downloads; private upload-signing POST |
| `/ping` | FastAPI liveness route |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* the API routers, including `/install.sh`. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every registered route has been tried.

`/install.sh` serves the repository's `apps/cli/install.sh` with only its default release base URL substituted from `CLI_INSTALL.RELEASES_URL` in `config.json`. The Docker image copies that same script alongside the backend. Set `RELEASES_URL` to `https://YOUR_ORIGIN/api/v1/cli/releases` (no trailing slash); it is public and must contain no credentials. The script resolves `/latest/VERSION` once, then fetches `/<version>/checksums.txt` and `/<version>/ddcli-darwin-arm64.gz`. Downloads redirect to short-lived **signed CloudFront** URLs; S3 presigned GET is available internally but bypasses the cache. Installer, release pointer, checksums, and redirect responses are not cached. Users can install with `curl -fsSL https://YOUR_ORIGIN/install.sh | sh` or download the script for inspection first.

### CLI client configuration

`GET /api/v1/cli/config` requires `Authorization: Bearer <DeputyDev encrypted session>` and uses the shared auth-service guard. It returns only schema-versioned telemetry settings, never backend config, auth data, or credentials in the JSON body. Auth errors and successful responses use `Cache-Control: no-store`; auth-service refresh tokens remain response headers. Browser-login start/poll stay on their existing `/api/v1/auth/browser-login` routes. No public bootstrap endpoint is added.

The template's `CLI_CLIENT_CONFIG.TELEMETRY: null` leaves existing environment-based telemetry unchanged. To manage it centrally, configure an approved collector, for example:

```json
"CLI_CLIENT_CONFIG": {
  "ALLOWED_TELEMETRY_ORIGINS": ["https://collector.example.com"],
  "TELEMETRY": {
    "ENABLED": true,
    "ENDPOINT": "/api/v1/otel",
    "PROTOCOL": "http/protobuf",
    "TRACE_SAMPLE_RATIO": 0.25,
    "METRIC_EXPORT_INTERVAL_MS": 10000
  },
  "PROXY": {
    "ENABLED": true,
    "UPSTREAM_URL": "https://collector.example.com",
    "HEADERS": {"Authorization": "Bearer YOUR_COLLECTOR_TOKEN"},
    "CONNECT_TIMEOUT_SECONDS": 2,
    "REQUEST_TIMEOUT_SECONDS": 5,
    "MAX_BODY_BYTES": 2097152,
    "MAX_DECODED_BODY_BYTES": 4194304,
    "MAX_CONCURRENT_REQUESTS": 20,
    "RATE_LIMIT_PER_MINUTE": 120
  }
}
```

This is deployment-wide CLI policy, separate from backend `OPEN_TELEMETRY`. Managed telemetry requires an enabled `PROXY` and `AUTH_SERVICE`. Its public endpoint is always `/api/v1/otel` on the CLI’s compiled service origin, and its protocol is always `http/protobuf`; remote config cannot select an external destination for a DeputyDev credential. Trace ratios are 0–1; metric intervals are 1,000–300,000 ms. Use `{ "ENABLED": false }` to disable CLI export, or null to restore environment fallback. `PROXY.ENABLED: false` also disables server ingestion. **Restart the backend** after changing settings.

Interactive online Pi fetches config best-effort with a 700 ms deadline and no disk cache. Managed policy clears inherited exporter headers/TLS identity overrides and per-signal destinations. The embedded extension reads the shared saved DeputyDev session for each batch, sends it only to the pinned backend proxy, and persists safe refresh headers with compare-and-swap so stale exports cannot overwrite a new login. No credentials or user profile are distributed in config JSON. Config/export failures never prevent Pi launch.

The proxy accepts only POSTs to `/api/v1/otel/v1/traces`, `/v1/metrics`, and `/v1/logs` (all under the same prefix). It validates the shared session/subscription guard before reading protobuf, obtains verified email/name via auth data or the auth service’s existing POST `/verify-auth-token`, and rewrites identity in resources, scopes, records, events, links, datapoints, and exemplars. Client `user.*`/`enduser.*` fields are removed; `user.id` is the auth user ID when available, otherwise verified email. `user.email`, optional `user.name`, `pi.identity.source=deputydev_auth`, and `deputydev.user_team_id` are server-authoritative. Missing verified identity fails closed. No Git email is read by the extension in managed mode.

`PROXY.UPSTREAM_URL` is a private collector base (optional path prefix), not a signal-specific URL. Its origin must be explicitly approved in `ALLOWED_TELEMETRY_ORIGINS`. HTTP is allowed for trusted private-network collectors; public CLI-to-backend traffic requires HTTPS except local development. `PROXY.HEADERS` stays server-side. Caller authorization/cookies/query parameters are never forwarded. Redirects are refused; OTLP response bodies/statuses/Retry-After are preserved. Gzip uploads are decoded with a bounded expansion limit; collector requests are sent as uncompressed protobuf. Wire/decoded payload, response, record-count, timeout, and concurrent-request limits are enforced. The per-user-team rate limit and concurrency limit are **per backend worker**; add ingress/global controls for multiple workers and unauthenticated abuse.

Environment fallback retains standard HTTP/protobuf or gRPC exporters and environment-supplied headers/API keys. It never automatically attaches a DeputyDev session, and its Git-email/installation-UUID attribution remains unchanged. Collector access and retention must cover verified employee identity and private repository names.

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
