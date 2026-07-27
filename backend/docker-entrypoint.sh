#!/bin/sh
set -e
# Fix named-volume ownership then drop privileges.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data /app/storage/attachments /app/storage/models /app/storage/workdirs /app/skills
  chown -R app:app /app/data /app/storage /app/skills 2>/dev/null || true
  exec gosu app "$0" "$@"
fi
exec "$@"
