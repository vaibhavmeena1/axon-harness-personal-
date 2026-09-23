# DeputyDev Console Backend

The centralized management API for DeputyDev CLI installations. It also serves the `apps/frontend` console as static files from the same origin.

## Prerequisites

- Python 3.12
- [uv](https://docs.astral.sh/uv/)
- SSH access to the private `tata1mg/vortex` Bitbucket repository

## Setup

```bash
cd apps/backend
cp config_template.json config.json # already created locally; repeat when resetting it
make install
```

`config.json` is local and git-ignored. Keep `config_template.json` updated whenever the configuration shape changes.

Before adding application code, read [`VORTEX_REFERENCE.md`](VORTEX_REFERENCE.md) for the audited locked Vortex API, reusable components, configuration behavior, and known caveats.

## Serving the console frontend

This service also serves `apps/frontend`. The console is a Vite build — an `index.html` plus content-hashed files under `assets/` — with nothing to run, so hosting it here keeps one origin, one deploy, and one version for the API and the UI, and removes CORS entirely.

Routing, in match order:

| Path | Served by |
| --- | --- |
| `/api/v1/*` | Vortex routers |
| `/docs`, `/openapi.json` | FastAPI |
| `/assets/*` | the console build, cached permanently (filenames are content-hashed) |
| everything else | the console build, falling back to `index.html` so client-side routes resolve |

The mount is registered in `app/main.py` *after* `create_app()`. Starlette matches routes in registration order, so the catch-all at `/` can only be reached once every API route has been tried.

A missing asset under `/assets/` and an unknown path under `/api/` both return a real 404 instead of `index.html`. That 404 is returned rather than raised, because Vortex's global `HTTPException` handler applies legacy status mapping and would rewrite it to 400 (see `VORTEX_REFERENCE.md`).

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
DOCKER_BUILDKIT=1 docker build --build-arg SERVICE_NAME=deputydev-console-backend --ssh default -t deputydev-console-backend .
```

Or `bun run build:backend-image` from the repository root.

`--ssh default` forwards your SSH agent for the private `vortex` Bitbucket dependency; the key never enters a layer. That repository is also **IP-allowlisted**, so the build must run from an allowlisted network. Otherwise `uv sync` fails with *"To access this repository, an admin must whitelist your IP."* — note that SSH authentication succeeds either way, so the allowlist failure only shows up in uv's output.

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
