#!/bin/sh
# Offline, on the stopped production volume. /previous is read-only;
# /maintenance is a private, retained directory owned by the container user.
set -eu
umask 077
mode=${1:-}
case "$mode" in apply|rollback|is-previous) ;; *) exit 2 ;; esac
export PYTHONDONTWRITEBYTECODE=1
engine=/var/lib/synplex/engine
test -f "$engine/engine-startup.json"
if [ "$mode" = is-previous ]; then
  /opt/synplex-python/bin/python -B - <<'PY'
import json,sys
from pathlib import Path
sys.path.insert(0,'/previous/integrations/agenthub')
from source_identity import verify_runtime
verify_runtime(json.loads(Path('/var/lib/synplex/engine/engine-startup.json').read_text()),Path('/previous/integrations/agenthub'))
PY
elif [ "$mode" = apply ]; then
  test ! -e /maintenance/previous
  test ! -e /maintenance/candidate
  node --input-type=module <<'JS'
import {buildRelease} from '/app/scripts/runtime/release.mjs';
buildRelease('/maintenance/previous',{sourceRoot:'/previous',engineSource:'/previous/vendor/agenthub/backend'});
buildRelease('/maintenance/candidate',{sourceRoot:'/app',engineSource:'/app/vendor/agenthub/backend'});
JS
  /opt/synplex-python/bin/python -B /maintenance/previous/integrations/agenthub/engine_recovery.py \
    backup "$engine" /maintenance/engine-snapshot
  /opt/synplex-python/bin/python -B /app/scripts/runtime/patch-worker-output.py \
    --previous /maintenance/previous --candidate /maintenance/candidate \
    --engine "$engine" --snapshot /maintenance/engine-snapshot --node /usr/local/bin/node
else
  # Refuses if any execution, file, configuration or database write happened
  # after the snapshot. Never restore an old database over live new writes.
  /opt/synplex-python/bin/python -B /app/scripts/runtime/patch-worker-output.py \
    --previous /maintenance/previous --candidate /maintenance/candidate \
    --engine "$engine" --snapshot /maintenance/engine-snapshot --node /usr/local/bin/node --rollback
fi
