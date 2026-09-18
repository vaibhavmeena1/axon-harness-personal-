# DeputyDev Console Backend

Tooling-only scaffold for the centralized management API for DeputyDev CLI installations. No application or test code has been added yet.

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
