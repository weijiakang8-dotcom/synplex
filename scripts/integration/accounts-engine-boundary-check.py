"""Read-only checks against two completed synthetic tenants, no task submitted."""
import json
from pathlib import Path
import sys
import uuid
import httpx
import psycopg

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'integrations/agenthub'))
from local_runner import database_connection
from private_infrastructure import read_private
from engine_reconcile import inspect_tasks

directory = Path(sys.argv[1])
data = read_private(directory / 'engine/engine/bootstrap.json')
report = read_private(directory / 'bindings.json')
with psycopg.connect(**database_connection(data, data['database'])) as db:
    db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY')
    rows = db.execute('SELECT tenant_id,organization_id,user_id,workflow_id FROM synplex_engine_tenants ORDER BY tenant_id').fetchall()
    assert len(rows) == 2 and len({row[1] for row in rows}) == 2
    assert db.execute('SELECT count(*) FROM executions').fetchone()[0] == 2
    inspected = inspect_tasks(db, data, report['bindings'], submission_receipts=True)
    assert all(row['state'] == 'original_task_verified' for row in inspected), inspected
    submissions = db.execute('SELECT operation_id,execution_id,attempt_id,packet_hash,payload_hash,organization_id FROM synplex_execution_submissions').fetchall()
with httpx.Client(base_url=f'http://127.0.0.1:{data["api_port"]}', timeout=10, trust_env=False) as client:
    for tenant, organization, user, workflow in rows:
        token = (directory / 'workspace/executors/agenthub/tenants' / tenant / 'access-token').read_text()
        headers = {'Authorization': 'Bearer '+token}
        assert client.get('/api/synplex/input-capabilities', headers=headers).status_code == 200
        assert client.post('/api/synplex/tenants/'+str(uuid.uuid4()), headers=headers).status_code == 404
        own = next(row for row in submissions if row[5] == organization)
        other = next(row for row in submissions if row[5] != organization)
        assert client.get('/api/executions/'+own[1], headers=headers).status_code == 200
        assert client.get('/api/executions/'+other[1], headers=headers).status_code in (403, 404)
        assert client.get('/api/synplex/executions/'+other[1]+'/usage', headers=headers).status_code == 404
        assert client.get('/api/synplex/submissions/'+other[0], headers=headers, params={
            'attempt_id': other[2], 'packet_hash': other[3], 'payload_hash': other[4]}).status_code == 404
        files = client.get('/api/artifacts', headers=headers, params={'execution_id': other[1]})
        assert files.status_code in (403, 404) or files.status_code == 200 and files.json() == []
print('实际PostgreSQL两组织、工作流与旧任务恢复身份核对通过；直接引擎跨租户请求被拒绝，模型调用0。')
