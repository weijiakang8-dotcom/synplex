#!/bin/sh
set -eu
umask 077
if [ ! -s /run/secrets/synplex_access ]; then
  echo 'Missing private access file; refusing public startup.' >&2
  exit 1
fi
: "${SYNPLEX_PUBLIC_ORIGIN:?Set the exact external HTTPS origin}"
mkdir -p /tmp/synplex-nginx
nginx -t -c /app/deploy/nginx.conf
node services/workspace/server.mjs &
app_pid=$!
proxy_pid=''
stop() {
  trap - TERM INT EXIT
  if [ -n "$proxy_pid" ]; then kill -TERM "$proxy_pid" 2>/dev/null || true; fi
  kill -TERM "$app_pid" 2>/dev/null || true
  if [ -n "$proxy_pid" ]; then wait "$proxy_pid" 2>/dev/null || true; fi
  wait "$app_pid" 2>/dev/null || true
}
trap stop TERM INT EXIT
nginx -c /app/deploy/nginx.conf -g 'daemon off;' &
proxy_pid=$!
while kill -0 "$app_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do sleep 1; done
exit 1
