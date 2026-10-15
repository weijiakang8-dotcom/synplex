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
# Do not accept proxy traffic until the workspace really responds.
node --input-type=module <<'READY'
let ready=false;
for(let i=0;i<100;i++){
 try{const r=await fetch('http://127.0.0.1:5200/health',{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}}catch{}
 await new Promise(resolve=>setTimeout(resolve,100));
}
if(!ready){console.error('Workspace did not become ready; proxy was not exposed.');process.exit(1);}
READY
nginx -c /app/deploy/nginx.conf -g 'daemon off;' &
proxy_pid=$!
while kill -0 "$app_pid" 2>/dev/null && kill -0 "$proxy_pid" 2>/dev/null; do sleep 1; done
exit 1
