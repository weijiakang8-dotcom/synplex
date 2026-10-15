#!/usr/bin/env bash
set -euo pipefail
work=$(mktemp -d)
name=synplex-ci-$RANDOM
volume=$name-data
image=synplex:ci
memory=768m
pids=96
wait_seconds=45
if [ "${SYNPLEX_CONTAINER_FULL:-0}" = 1 ]; then
  image=synplex-full:ci
  memory=2g
  pids=256
  wait_seconds=120
fi
image=${SYNPLEX_CONTAINER_IMAGE:-$image}
docker volume create "$volume" >/dev/null
cleanup() { rc=$?; if [ "$rc" -ne 0 ]; then docker logs "$name" 2>&1 || true; if [ -n "${SYNPLEX_CONTAINER_EVIDENCE_DIR:-}" ]; then mkdir -p "$SYNPLEX_CONTAINER_EVIDENCE_DIR"; chmod 700 "$SYNPLEX_CONTAINER_EVIDENCE_DIR"; docker cp "$name:/var/lib/synplex/install.log" "$SYNPLEX_CONTAINER_EVIDENCE_DIR/install.log" 2>/dev/null || true; chmod 600 "$SYNPLEX_CONTAINER_EVIDENCE_DIR/"* 2>/dev/null || true; fi; fi; docker rm -f "$name" >/dev/null 2>&1 || true; docker volume rm "$volume" >/dev/null 2>&1 || true; rm -f "$work/access"; rmdir "$work"; }
trap cleanup EXIT
printf 'ci-user:%s\n' "$(openssl passwd -apr1 'test-only-container-password')" > "$work/access"
chmod 644 "$work/access"
docker run -d --name "$name" --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory "$memory" --pids-limit "$pids" --tmpfs /tmp:size=256m,mode=1777 -p 127.0.0.1:5260:8080 -e SYNPLEX_PUBLIC_ORIGIN=https://synplex.example -e SYNPLEX_BUILD_SHA=ci-container -v "$volume:/var/lib/synplex" -v "$work/access:/run/secrets/synplex_access:ro" "$image" >/dev/null
for i in $(seq 1 "$wait_seconds"); do
  if [ "$(curl --max-time 2 -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5260/app || true)" = 401 ]; then break; fi
  if ! docker inspect -f '{{.State.Running}}' "$name" | grep -qx true; then docker logs "$name"; exit 1; fi
  sleep 1
done
node scripts/integration/container-check.mjs "$name"
