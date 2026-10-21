#!/bin/sh
set -eu

# Deployment supplies dbmate on PATH and DATABASE_URL via its secret configuration.
# Run once per deployment before rolling out application workers.
: "${DATABASE_URL:?Set DATABASE_URL to the intended PostgreSQL database}"
BACKEND_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# The database is provisioned separately. Pass "up" to allow database creation.
if [ "$#" -eq 0 ]; then
    set -- migrate
fi

# Use dbmate's default schema_migrations ledger; never dump a deployed database.
exec dbmate --migrations-dir "$BACKEND_ROOT/db/migrations" --no-dump-schema "$@"
