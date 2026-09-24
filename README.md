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

## Releases

GitHub Releases are repository-wide, so every component namespaces its tags:

| Component | Tag format      | Workflow                             |
| --------- | --------------- | ------------------------------------ |
| CLI       | `cli-<semver>`  | `.github/workflows/release.yml`      |
| Backend   | to be decided   | none yet                             |
| Frontend  | to be decided   | none yet                             |

The CLI release workflow ignores any tag that does not start with `cli-`. The installer resolves the newest release marked **latest** and expects it to carry the CLI assets, so only CLI releases may be marked latest. Details are in [apps/cli/README.md](apps/cli/README.md#releasing).

## Security

See [SECURITY.md](SECURITY.md).
