#!/bin/sh
set -e

# Platforms like Render run one container with no separate migration step, so
# migrations run here before the server starts. Safe on a single instance;
# with multiple replicas, run migrations as a separate job instead and set
# RUN_MIGRATIONS=false.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  echo "Applying database migrations..."
  alembic upgrade head
fi

exec uvicorn app.main:app \
  --host 0.0.0.0 \
  --port "${PORT:-8000}" \
  --proxy-headers \
  --forwarded-allow-ips '*'
