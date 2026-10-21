# GitHub Actions: core CI plan

Status: core workflow implemented and validated locally; Bitbucket pipeline configuration
removed. The first GitHub run and repository-settings migration remain to be verified
after push. Release behavior is unchanged.

## Scope

Use GitHub Actions for exactly four parallel CI jobs:

| Job | Runner | Responsibility |
| --- | --- | --- |
| Workspace | `ubuntu-latest` | Existing `bunx biome ci .` |
| CLI | `macos-26` (Apple Silicon) | Existing checks, tests, native development build, and binary smoke test |
| Backend | `ubuntu-latest` | Python 3.12, frozen uv dependencies, and `make check` |
| Frontend | `ubuntu-latest` | Node/pnpm, frozen dependencies, lint, formatting, and production build |

Keep one core workflow at `.github/workflows/ci.yml`. Jobs should have no dependencies
on one another, so each app's result is visible independently.

Do not add mock data, seed data, new fixtures, mock servers, or CI-specific application
behavior. Run existing checks and tests as they are; existing test fixtures remain unchanged.

### Not included

- Container builds, image publishing, or deployment.
- PostgreSQL services, dbmate installation, or new integration-test infrastructure.
- New frontend tests, end-to-end tests, or live auth/model/S3 connections.
- Release automation, signing changes, provenance changes, or artifact publishing.
- Dependency caching, path-based job filtering, matrices, coverage gates, additional
  workflow-validation jobs, or other optimization work.

The first milestone is a straightforward, working core pipeline, not a broader CI/CD redesign.

## Starting state (before implementation)

- `.github/workflows/ci.yml` already contains the workspace and native macOS CLI jobs.
- `biome.json` excludes `apps/backend` and `apps/frontend`; the workspace job does not
  validate those apps, despite its current step name saying "across every app."
- `apps/backend/Makefile` already provides frozen dependency installation and a
  `check` target for Ruff formatting, Ruff lint, and pytest.
- `apps/frontend/package.json` already provides lint, formatting, and build scripts.
  The frontend is deliberately outside the Bun workspace and uses pnpm.
- `bitbucket-pipelines.yml` duplicates workspace checks and part of the CLI checks.
  It does not provide backend/frontend checks or native macOS build coverage.
- Current documentation describes manual CLI publishing from Apple Silicon macOS
  to private S3, with downloads through the backend and CloudFront. That release
  process is separate from this CI migration.

## Workflow behavior

Preserve the existing core workflow's triggers and controls:

- Pull requests.
- Pushes to `main`.
- Manual runs through `workflow_dispatch`.
- Read-only repository permission: `contents: read`.
- Cancel superseded CI runs for the same ref.
- Explicit job timeouts and normal failure propagation; no `continue-on-error`.

Run all four jobs on every workflow invocation. Do not add path filters or a fifth
aggregate job in this milestone. Use stable job IDs: `workspace`, `cli`, `backend`,
and `frontend`.

No deployment secrets, SSH keys, cloud credentials, or production environments should
be required for core CI. Do not auto-fix source files or regenerate lockfiles/bundles
inside CI to make checks pass.

## Job definitions

### 1. Workspace

Retain the existing Ubuntu job and Bun setup:

1. Check out the repository.
2. Set up Bun `1.4.1`, matching the root `packageManager`.
3. Install from the repository root with `bun install --frozen-lockfile`.
4. Run `bunx biome ci .` from the repository root.

Keep its existing 10-minute timeout. Rename the check step so it accurately describes
Biome's configured workspace scope, rather than claiming to check every app.

### 2. CLI

Retain the existing native Apple Silicon job and 15-minute timeout:

1. Check out the repository and set up Bun `1.4.1`.
2. Verify `uname` reports `Darwin-arm64`.
3. Install workspace dependencies from the repository root with the frozen lockfile.
4. From `apps/cli`, run:

   ```sh
   bun run check
   bun test
   sh -n install.sh
   bun run build
   ```

5. Smoke-test the compiled development binary:

   ```sh
   test "$(./dist/axon --version)" = "0.1.0-dev"
   ./dist/axon harnesses --help
   test "$(lipo -archs ./dist/axon)" = "arm64"
   ```

Do not replace the native runner with Linux or reduce testing to the subset used by
Bitbucket. Use `harnesses --help` for a credential-free smoke test: bare `harnesses`
requires an Axon login. This job validates a development binary only; it does not
publish a release.

### 3. Backend

Add an Ubuntu job with a 15-minute timeout:

1. Check out the repository.
2. Set up Python `3.12`, matching `apps/backend/pyproject.toml`.
3. Set up uv with an explicit version; initially use `0.11.7`, matching the current
   Dockerfile's uv version.
4. From `apps/backend`, run:

   ```sh
   make install
   make check
   ```

`make install` runs `uv sync --frozen --all-groups`. `make check` runs Ruff's formatting
check, Ruff lint, and the existing pytest suite with frozen dependency resolution.
Do not invoke a separate `make test`, because `make check` already includes it.

Do not start the backend, generate application configuration, provision a database,
or inject application credentials for this job. Existing tests manage their own
configuration and fixtures.

**Coverage boundary:** disposable-PostgreSQL tests currently skip when their database
or tooling prerequisites are absent. Preserve that behavior for this core milestone
and keep pytest's skip reasons visible. A passing core backend job does not establish
that database/migration integration tests executed. Do not remove tests or introduce
fake infrastructure to conceal that boundary.

### 4. Frontend

Add an Ubuntu job with a 15-minute timeout:

1. Check out the repository.
2. Set up Node.js `24`, matching the frontend build stage in the Dockerfile.
3. Set up pnpm using `apps/frontend/package.json` as the version source; its current
   `packageManager` is `pnpm@11.5.0`.
4. From `apps/frontend`, run:

   ```sh
   pnpm install --frozen-lockfile
   cp config_template.json config.json
   pnpm lint
   pnpm format:check
   pnpm build
   ```

The copied config is the existing, checked-in build configuration template, not new
mock data or a production configuration. Never commit the generated `config.json`.

`pnpm build` already runs `tsc -b` before Vite, so a separate `pnpm typecheck` step
would duplicate the TypeScript build check. Do not start a backend, dev server, or
browser for this job. Do not upload or deploy `dist/` in this milestone.

## Reference workflows

Reviewed the local sibling repository at
`/Users/vaibhavmeena/Desktop/1mg/deputydev-binary/.github/workflows/`:

- `code_quality.yaml`: separate code-quality checks and read-only repository access.
- `build-macos-arm64.yml`: native macOS binary builds kept separate from quality checks.
- `build-binaries.yml`: manual binary build/publishing workflow, outside this plan's scope.

Use those as structural references only. Do not copy their private-repository SSH
setup, deploy keys, Windows matrix, upload endpoints, or release credentials. This
repository's Bun CLI, uv backend, and pnpm frontend use their existing commands.

## Implementation order

### Phase 1: establish the core pipeline

- [x] Preserve the workspace and CLI jobs in `.github/workflows/ci.yml`.
- [x] Correct the workspace step's misleading scope description.
- [x] Add the backend and frontend jobs described above.
- [x] Validate workflow syntax and run the existing app checks locally, including
      the native Apple Silicon build and smoke test.
- [ ] Confirm all four jobs appear and run independently on a GitHub pull request.
- [x] Resolve genuine check failures without bypassing checks or weakening app rules:
      use credential-free `harnesses --help` for the smoke test and remove the obsolete
      no-op `apps/backend/dbmate.py`, as required by the existing migration test and docs.

### Phase 2: remove Bitbucket Pipelines

The core workflow has been validated locally. Repository-file changes are complete;
remote CI execution and settings still need verification after push.

- [x] Remove the root `bitbucket-pipelines.yml`.
- [x] Update `README.md`'s CI section to describe the four GitHub Actions jobs and
      their boundaries instead of linking to Bitbucket Pipelines.
- [x] Update the CI references in `apps/cli/README.md` and `apps/cli/docs/shipplan.md`
      without changing the manual S3 release procedure.
- [ ] Update repository branch-protection settings to require the four GitHub CI
      checks and remove obsolete Bitbucket requirements, if configured. This is a
      repository-settings operation, not a YAML change.
- [ ] Disable any remaining Bitbucket pipeline execution in repository settings,
      if configured, so there is one CI source of truth.

Leave `.github/workflows/release.yml` unchanged in this milestone. It is a separate
retained GitHub Release workflow, not the documented manual S3 publishing path;
reconciling or replacing it is outside the core pipeline work. Do not add any new
release triggers to the core CI workflow.

## Local validation

Validation ran on Apple Silicon macOS in an isolated snapshot of the working tree,
without ignored application configuration or inherited Axon/Pi/OTel session variables.
Existing dependency installations were reused; frozen installs did not change lockfiles.
The frontend build used the checked-in configuration template.

- Workspace frozen install and Biome checks: passed.
- CLI generated bundle/type checks and shell syntax: passed.
- CLI tests: 770 passed, one existing large-archive test skipped, zero failures.
- CLI native development build, version, command help, and arm64 smoke checks: passed.
- Backend frozen install with uv `0.11.7`, Ruff checks, and pytest: passed
  (821 tests; one dependency deprecation warning). Disposable local PostgreSQL/dbmate
  prerequisites were available during this run; the GitHub job does not provision them.
- Frontend frozen install, lint, formatting, and template-based production build: passed;
  lint, formatting, and build also verified with Node.js `24.22.0` and pnpm `11.5.0`.
- Core workflow schema and explicit-timeout validation: passed using `check-jsonschema`
  built-in GitHub workflow schemas, without adding a CI validation job.

These are local results, not evidence of a completed GitHub Actions run.

## Acceptance criteria

- GitHub Actions exposes exactly the four core CI jobs defined here.
- Pull requests, `main` pushes, and manual core runs execute the same checks.
- Dependency installs use committed lockfiles without modifying them.
- The CLI is built and smoke-tested on native Apple Silicon macOS.
- Backend formatting, lint, and existing tests run through `make check`; any existing
  integration-test skips remain visible and are not presented as executed coverage.
- Frontend lint, formatting, and TypeScript/Vite production build all run.
- Core checks need no production secrets or newly provisioned service infrastructure.
- After migration, Bitbucket configuration and obsolete CI documentation are removed
  or updated, and existing manual S3 release instructions remain intact.
