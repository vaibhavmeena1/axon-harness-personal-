#!/bin/sh
set -eu

# Run this command once per deployment before rolling out application workers.
exec python -m deployment.run_migrations
