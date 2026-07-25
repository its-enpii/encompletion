#!/bin/sh
# Health-check + auto-reload watchdog. Runs inside the nginx container
# via docker compose. Polls the upstream `backend` once a second; the
# first time the backend becomes reachable we signal nginx to reload
# so its resolver picks up the fresh upstream endpoint. After that, if
# the backend goes down again, we reload again (no-op until needed).
#
# We don't run as a separate cron job because container restarts can
# leave stale DNS in nginx's worker — the reload is what actually
# clears the cached resolver.

set -eu

UPSTREAM=${HEALTHCHECK_UPSTREAM:-http://backend:4000/api/health}
NGINX_PID=${NGINX_PID:-1}

last_state="down"
while true; do
  if wget -q --spider --timeout=2 -O /dev/null "$UPSTREAM" 2>/dev/null; then
    cur_state="up"
  else
    cur_state="down"
  fi
  if [ "$cur_state" != "$last_state" ]; then
    echo "[healthcheck] upstream transitioned $last_state -> $cur_state; reloading nginx"
    nginx -s reload 2>&1 || true
    last_state="$cur_state"
  fi
  sleep 1
done
