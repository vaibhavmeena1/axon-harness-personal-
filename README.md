# DeputyDev

Monorepo for DeputyDev: the `ddcli` launcher plus the centralized management backend and frontend.

## Layout

```text
apps/
  cli/        ddcli launcher. Bun, compiled darwin-arm64 binary. See apps/cli/README.md.
  frontend/   management console UI. pnpm, Vite, React, TypeScript, Tailwind, shadcn.
  backend/    centralized management API. Python 3.12, uv, FastAPI, Ruff, pytest.
packages/     shared code between apps (for example API contracts). Empty until needed.
```

Three package managers coexist on purpose. **Bun** owns the workspace at the root (`apps/cli`, `packages/*`) with one `bun.lock`, one `biome.json`, and one `tsconfig.base.json`. **pnpm** owns `apps/frontend` alone, with its own lockfile, ESLint, and Prettier, because that is the house setup for 1mg web apps. **uv** owns the standalone Python project in `apps/backend`, including its virtual environment and `uv.lock`.

`apps/frontend` and `apps/backend` are therefore excluded from the root Bun workspace and from Biome. Run their commands from their own directories.

## Development

Bun-managed apps, from the repository root:

```bash
bun install --frozen-lockfile   # once
bun run check                   # every Bun app's check script, then biome
bun run test                    # every Bun app's tests
bun run cli -- --version        # run ddcli from source
```

The frontend, from its own directory:

```bash
cd apps/frontend
cp config_template.json config.json   # once; the file is git-ignored
pnpm install
pnpm dev
```

The backend tooling scaffold, from its own directory:

```bash
cd apps/backend
cp config_template.json config.json   # once; the file is git-ignored
uv sync --frozen --all-groups
make check
```

To work inside one app, `cd` into it and use its own scripts, for example `cd apps/cli && bun test`.

## CI

[`bitbucket-pipelines.yml`](bitbucket-pipelines.yml) runs workspace, CLI, frontend, and backend checks. Its Linux container validates shell syntax but does not build a native macOS arm64 binary or run macOS installer/update integration tests. Publishing is a manual Apple Silicon operation; passing CI does not publish a release. The old `.github/workflows/` files are left untouched for deprecation and are not used by the current release path.

## Releases

CLI releases (`cli-<semver>` git tags, if used) are built and ad-hoc signed manually on Apple Silicon and uploaded to a private S3 bucket using a secret-protected backend presigned PUT. Backend `config.json` maps versions to immutable S3 keys and checksums and selects `LATEST_VERSION`. The public installer and `ddcli update` fetch through CloudFront signed URLs issued by the backend, not GitHub Releases. See [the CLI release procedure](apps/cli/README.md#releasing) and [backend settings](apps/backend/README.md#cli-releases-macos-arm64-only).

## Security

See [SECURITY.md](SECURITY.md).
