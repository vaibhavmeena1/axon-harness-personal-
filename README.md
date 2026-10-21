# Axon

Axon is a managed launcher for the Pi coding agent, backed by a centralized API and web console. It handles sign-in, an isolated Pi runtime, organization configuration, and CLI updates so developers can start a session with `axon pi`.

**Current support:** Pi is the only supported harness. Distributed CLI binaries and the installer support macOS on Apple Silicon (`darwin-arm64`) and Intel (`darwin-x64`).

## Use the CLI

New to Axon? Start with the [end-user guide](docs/user-guide.md) for installation, login, models and thinking levels, YOLO mode, updates, and session import/restore.

Follow the [CLI installation guide](apps/cli/README.md#installation) for your deployment, then run:

```bash
axon pi                    # start a coding session; first use prompts for sign-in
axon doctor                # check the local setup
axon update --check        # check for a newer CLI release
```

Axon keeps its managed state under `~/.axon`, separate from a standalone Pi installation. See the [CLI guide](apps/cli/README.md#usage) for authentication, configuration, updates, and troubleshooting.

## Repository

| App | Purpose | Tooling |
| --- | --- | --- |
| [`apps/cli`](apps/cli/README.md) | Native `axon` launcher and managed Pi resources | Bun, TypeScript, Biome |
| [`apps/backend`](apps/backend/README.md) | Management API, authentication integration, model proxy, and CLI distribution | Python 3.12, uv, FastAPI, Ruff, pytest |
| [`apps/frontend`](apps/frontend/README.md) | Management console | pnpm, Vite, React, TypeScript, Tailwind |

The root **Bun** workspace covers `apps/cli` and future shared packages under `packages/*`. The frontend uses **pnpm** independently; the backend uses **uv**. Their dependencies and lockfiles are separate, and root Biome checks exclude both apps.

In production, the backend serves the built frontend from the same origin; the console is not a separate service.

## Local development

### Prerequisites

- **Bun 1.4.1** for the root workspace and CLI.
- **Node.js 22.19 or newer and npm** to run the managed Pi runtime.
- **pnpm 11.5.0** for the frontend.
- **Python 3.12, uv, and make** for the backend.
- A reachable **PostgreSQL** database to start the backend.

You only need the tooling for the apps you are working on. The aggregate root checks require all three toolchains.

### Set up a fresh checkout

From the repository root:

```bash
bun install --frozen-lockfile
cp apps/cli/.env.example apps/cli/.env
cp apps/backend/config_template.json apps/backend/config.json
cp apps/frontend/config_template.json apps/frontend/config.json

(cd apps/frontend && pnpm install --frozen-lockfile)
make -C apps/backend install
```

These local configuration files are git-ignored. Do not overwrite existing configuration or commit credentials. Before starting the backend, set its database connection in `apps/backend/config.json`; configure the auth service and LiteLLM connections for sign-in and model access. See the [backend guide](apps/backend/README.md) for details.

The CLI's `.env` points at `http://localhost:3000` by default. Compiled release binaries use their build-time service origin rather than loading this file.

### Run locally

Start the backend and frontend in separate terminals, each from the repository root.

**Backend** — API at `http://localhost:3000`, API docs at `/docs`:

```bash
cd apps/backend
uv run --frozen uvicorn app.main:app --reload --host 127.0.0.1 --port 3000
```

**Frontend** — console at `http://localhost:8010`, with `/api` proxied to the backend:

```bash
cd apps/frontend
pnpm dev
```

**CLI** — run from the repository root:

```bash
bun run cli -- --version
bun run cli -- pi
```

A full coding session needs the configured auth service and model upstream; starting the local API and console alone does not provide them.

### Check your changes

Run these commands from the repository root after installing the relevant app dependencies:

| Command | Scope |
| --- | --- |
| `bun run check` | CLI checks, frontend lint/typecheck, backend lint/format checks and tests, then root Biome checks |
| `bun run typecheck` | CLI and frontend TypeScript checks |
| `bun run test` | CLI and backend tests |
| `bun run check:cli` / `bun run test:cli` | CLI only |
| `bun run check:frontend` | Frontend lint and typecheck |
| `bun run check:backend` / `bun run test:backend` | Backend only |

CLI installer integration tests require macOS. For app-specific builds and other commands, use the guides linked above.

## CI and releases

[GitHub Actions CI](.github/workflows/ci.yml) runs four independent jobs on pull requests, pushes to `main`, and manual runs:

| Job | Checks |
| --- | --- |
| Workspace | Root Biome formatting and lint (excludes backend/frontend) |
| CLI | Generated bundle checks, TypeScript checks, tests including installer integration, shell syntax, native development builds and binary smoke tests on Apple Silicon (`macos-26`) and Intel (`macos-26-intel`) runners |
| Backend | Python 3.12, frozen uv dependencies, Ruff formatting/lint, and existing pytest tests through `make check` |
| Frontend | Node.js 24, frozen pnpm dependencies, ESLint, Prettier, and TypeScript/Vite production build using `config_template.json` |

Core CI does not provision databases or other services, publish artifacts, or deploy. Existing backend PostgreSQL/migration tests skip when their prerequisites are unavailable; pytest reports those skips. See the [core CI plan](docs/github-actions-core-ci.md) for scope and migration follow-up.

CLI publishing remains manual on Apple Silicon macOS; it cross-compiles the Intel binary and verifies it under Rosetta. Artifacts are stored in private S3 and downloaded through backend-issued CloudFront signed URLs, not GitHub Releases. Core CI does not publish; the retained [GitHub Release workflow](.github/workflows/release.yml) is separate and is not part of this manual S3 release path.

- [CLI release procedure](apps/cli/README.md#releasing)
- [Backend release configuration](apps/backend/README.md#cli-releases-macos-arm64-and-x64)

To build the backend image with the frontend included, run `bun run build:backend-image` from the repository root. See the [Docker guide](apps/backend/README.md#docker) for deployment details.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting and the [CLI installation guide](apps/cli/README.md#installation) for distribution and macOS trust limitations. Current CLI releases are ad-hoc signed, not Apple Developer ID signed or notarized.
