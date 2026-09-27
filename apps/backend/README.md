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
| `/ping` | FastAPI liveness route |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* the API routers. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every API route has been tried.

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
