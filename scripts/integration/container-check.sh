#!/usr/bin/env bash
set -euo pipefail
work=$(mktemp -d)
name=synplex-ci-$RANDOM
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -f "$work/access"; rmdir "$work"; }
trap cleanup EXIT
printf 'ci-user:%s\n' "$(openssl passwd -apr1 'test-only-container-password')" > "$work/access"
chmod 644 "$work/access"
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 768m --pids-limit 96 --tmpfs /tmp:size=128m,mode=1777 -p 127.0.0.1:5260:8080 -e SYNPLEX_PUBLIC_ORIGIN=https://synplex.example -e SYNPLEX_BUILD_SHA=ci-container -v "$work/access:/run/secrets/synplex_access:ro" synplex:ci >/dev/null
for i in $(seq 1 45); do
  if [ "$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5260/ || true)" = 401 ]; then break; fi
  if ! docker inspect -f '{{.State.Running}}' "$name" | grep -qx true; then docker logs "$name"; exit 1; fi
  sleep 1
done
node scripts/integration/container-check.mjs "$name"
