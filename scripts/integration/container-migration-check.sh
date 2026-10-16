#!/usr/bin/env bash
# Two fresh, disposable CI volumes. Never use a configured product volume.
set -Eeuo pipefail
baseline=${1:?verified predecessor source directory}
previous_image=${2:?predecessor image}
candidate_image=${3:-synplex-full:ci}
work=$(mktemp -d)
name=synplex-migration-ci-$RANDOM-$$
containers=()
volumes=()
cleanup(){
 local rc=$?
 if (( rc )); then
  for container in "${containers[@]}"; do docker logs "$container" 2>&1 || true; done
 fi
 for container in "${containers[@]}"; do docker rm -f "$container" >/dev/null 2>&1 || true; done
 for volume in "${volumes[@]}"; do docker volume rm "$volume" >/dev/null 2>&1 || true; done
 rm -f "$work/access"
 rmdir "$work"
}
trap cleanup EXIT
printf 'ci-user:%s\n' "$(openssl passwd -apr1 'test-only-container-password')" > "$work/access"
chmod 644 "$work/access"
ready(){
 local container=$1
 for ((i=0;i<120;i++)); do
  if docker exec "$container" node -e 'fetch("http://127.0.0.1:5200/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then return; fi
  test "$(docker inspect -f '{{.State.Running}}' "$container")" = true
  sleep 1
 done
 echo 'Migration candidate did not become ready' >&2
 return 1
}
start(){
 local container=$1 image=$2 volume=$3
 containers+=("$container")
 docker run -d --name "$container" --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 2g --pids-limit 256 --tmpfs /tmp:size=256m,mode=1777 \
  -e SYNPLEX_PUBLIC_ORIGIN=https://synplex.example -e SYNPLEX_BUILD_SHA=migration-ci \
  -v "$volume:/var/lib/synplex" -v "$work/access:/run/secrets/synplex_access:ro" "$image" >/dev/null
 ready "$container"
}
for scenario in rollback new-write; do
 volume=$name-$scenario-data
 maintenance=$name-$scenario-maintenance
 volumes+=("$volume" "$maintenance")
 docker volume create "$volume" >/dev/null
 docker volume create "$maintenance" >/dev/null
 docker run --rm --network none --user 0 --cap-drop ALL --cap-add CHOWN --entrypoint sh -v "$maintenance:/maintenance" "$candidate_image" -c 'chown 1000:1000 /maintenance'
 docker run --rm --network none --cap-drop ALL --entrypoint sh -v "$maintenance:/maintenance" "$candidate_image" -c 'chmod 700 /maintenance'
 old=$name-$scenario-old
 start "$old" "$previous_image" "$volume"
 docker stop -t 90 "$old" >/dev/null
 migrate(){
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true --entrypoint sh \
   -v "$volume:/var/lib/synplex" -v "$maintenance:/maintenance" -v "$baseline:/previous:ro" \
   "$candidate_image" /app/deploy/migrate-worker.sh "$1"
 }
 migrate is-previous
 migrate apply
 if migrate is-previous; then echo 'Original identity unexpectedly retained'; exit 1; fi
 if [[ $scenario == rollback ]]; then
  migrate rollback
  migrate is-previous
  docker start "$old" >/dev/null
  ready "$old"
  docker stop -t 90 "$old" >/dev/null
 else
  candidate=$name-$scenario-candidate
  start "$candidate" "$candidate_image" "$volume"
  docker exec -i "$candidate" /opt/synplex-python/bin/python -B - <<'PY'
import sys,json
from pathlib import Path
sys.path.insert(0,'/app/integrations/agenthub')
import psycopg
from local_runner import database_connection
data=json.loads(Path('/var/lib/synplex/engine/engine/bootstrap.json').read_text())
with psycopg.connect(**database_connection(data,data['database'])) as conn:
 with conn.cursor() as c:
  c.execute('CREATE TABLE synplex_migration_write_guard (value TEXT NOT NULL)')
  c.execute("INSERT INTO synplex_migration_write_guard VALUES ('retain-new-write')")
PY
  docker stop -t 90 "$candidate" >/dev/null
  if migrate rollback; then echo 'Downgrade overwrote new business state'; exit 1; fi
  docker start "$candidate" >/dev/null
  ready "$candidate"
  docker exec -i "$candidate" /opt/synplex-python/bin/python -B - <<'PY'
import sys,json
from pathlib import Path
sys.path.insert(0,'/app/integrations/agenthub')
import psycopg
from local_runner import database_connection
data=json.loads(Path('/var/lib/synplex/engine/engine/bootstrap.json').read_text())
with psycopg.connect(**database_connection(data,data['database'])) as conn:
 with conn.cursor() as c:
  c.execute('SELECT value FROM synplex_migration_write_guard')
  assert c.fetchall()==[('retain-new-write',)]
PY
  docker stop -t 90 "$candidate" >/dev/null
 fi
 echo "Migration scenario passed: $scenario; modelCalls=0"
done
