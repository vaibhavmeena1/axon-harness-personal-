#!/bin/sh
set -eu

# Load process settings through the same typed config.json path as the application.
CONFIG_OUTPUT=$(python - <<'EOF'
from deployment.uvicorn_conf import ACCESS_LOG, HOST, PORT, WORKERS

print(HOST, PORT, WORKERS, "true" if ACCESS_LOG else "false")
EOF
)
# Use positional parameters instead of a bash-only here-string.
# shellcheck disable=SC2086
set -- $CONFIG_OUTPUT
HOST=$1
PORT=$2
WORKERS=$3
ACCESS_LOG=$4

set -- uvicorn app.main:app \
    --loop uvloop \
    --http httptools \
    --host "$HOST" \
    --port "$PORT" \
    --workers "$WORKERS"

if [ "$ACCESS_LOG" = "true" ]; then
    set -- "$@" --access-log
else
    set -- "$@" --no-access-log
fi

exec "$@"