"""Free new private-engine check: supervision -> clean stop -> intake/lookup.

Only a literal invalid test provider key is configured, with external sockets
forbidden in the actual admission API. No worker starts after configuration.
Evidence directories cannot be reused; preserve interrupted phases first.
"""
import json
import os
from pathlib import Path
import socket
import signal
import subprocess
import sys
import time

import httpx
import psycopg

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations/agenthub'))
from engine_runtime import setup, configuration, startup_lease
from engine_provider import configure
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, safe_env, write_private, read_private


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def ready(child, port):
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        assert child.poll() is None, 'Private API exited; inspect its preserved log'
        try:
            if httpx.get(f'http://127.0.0.1:{port}/health/live', timeout=1).status_code == 200:
                return
        except httpx.HTTPError:
            pass
        time.sleep(.1)
    raise RuntimeError('Private API readiness timed out; preserve this attempt')


def run(backend, pg_bin, valkey, node, evidence, *, resume=False):
    if resume:
        raise RuntimeError('历史核对证据保留；新版直接入口拒绝带原工作的启动，不能用此旧测试模式绕过。')
    if evidence.exists() and not resume:
        raise RuntimeError('Inspect interrupted evidence; never overwrite or repeat its setup')
    if not resume:
        evidence.mkdir(mode=0o700, parents=True)
    elif any((evidence / name).exists() for name in ['result.json', 'node-result.json', 'resume-observation.json']):
        raise RuntimeError('Read actual completed continuation before attempting another phase')
    engine = evidence / 'engine'
    if not resume:
        ports = [free_port() for _ in range(3)]
        assert len(set(ports)) == 3
        setup(engine, backend, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    saved, infra, data = configuration(engine)
    ports = [saved['apiPort'], saved['redisPort'], saved['databasePort']]
    children, logs, owned = [], [], None

    def spawn(name, argv):
        log = open(evidence / (name + '.log'), 'xb');os.chmod(log.name, 0o600);logs.append(log)
        child = subprocess.Popen(argv, cwd=ROOT, env={**safe_env(),'SYNPLEX_TEST_NO_MODELS':'1'}, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        children.append(child)
        return child

    def blocked_maintenance():
        try:
            with startup_lease(engine):
                raise AssertionError('A live API did not exclude maintenance')
        except RuntimeError:
            pass

    try:
        if not resume:
            supervisor = spawn('supervised', [sys.executable, '-B', str(ROOT / 'integrations/agenthub/engine_runtime.py'), 'run', '--root', str(engine)])
            ready(supervisor, ports[0]);blocked_maintenance()
            # HTTP readiness alone does not prove the sibling worker imported.
            deadline = time.monotonic() + 20
            while b'celery@' not in (engine / 'worker.log').read_bytes():
                assert supervisor.poll() is None
                if time.monotonic() > deadline:
                    raise RuntimeError('Private worker did not initialize')
                time.sleep(.1)
            supervisor.terminate();assert supervisor.wait(timeout=30) == 0
            write_private(evidence / 'supervised-result.json', {'normalShutdown':True,'modelCalls':0})
        else:
            assert b'"providerConfigured": false' in (evidence / 'supervised.log').read_bytes()
            assert b'celery@' in (engine / 'worker.log').read_bytes()
        for port in ports:
            with socket.socket() as sock:
                assert sock.connect_ex(('127.0.0.1', port)) != 0
        with startup_lease(engine):
            pass
        if not resume:
            key = evidence / 'invalid-test-key'
            key.write_text('fixture-only-not-a-valid-provider-key');os.chmod(key, 0o600)
            profile = evidence / 'test-profile.json'
            write_private(profile, {'provider':'deepseek','models':['deepseek-flash'],'maxTokens':512,'tokenFile':str(key)})
            configure(engine, profile)
        else:
            assert (engine / 'engine/provider-key').read_text() == 'fixture-only-not-a-valid-provider-key'
        _, infra, data = configuration(engine)
        owned = OwnedInfrastructure(infra);owned.start_database()
        if resume:
            # Inspect first. This phase is permitted ONLY for the one committed
            # intake with an already-published event and no worker execution.
            with psycopg.connect(**database_connection(data, data['database'])) as db:
                db.execute('SET TRANSACTION READ ONLY')
                rows = db.execute('SELECT execution_id FROM synplex_execution_submissions').fetchall()
                assert len(rows) == 1
                assert db.execute('SELECT status,run_attempt FROM executions').fetchall() == [('pending',0)]
                published = db.execute('SELECT count(*) FROM outbox_events WHERE published_at IS NOT NULL').fetchone()[0]
                assert published in {0,1}
                assert db.execute('SELECT count(*) FROM outbox_events').fetchone()[0] == 1
                assert db.execute('SELECT count(*) FROM tool_calls').fetchone()[0] == 0
                observed = {'acceptedTaskId':rows[0][0],'posts':1,'publishedEvents':published,'source':'read-only PostgreSQL after interrupted harness'}
            if not (evidence / 'accepted.json').exists():
                write_private(evidence / 'accepted.json', observed)
            else:
                assert read_private(evidence / 'accepted.json')['acceptedTaskId'] == observed['acceptedTaskId']
            write_private(evidence / 'resume-observation.json', observed)
        owned.start_queue(valkey, engine / 'engine')
        # The actual runner/lifespan executes unchanged; only external network
        # access in this private test process is prohibited by a Python audit hook.
        launch = """import sys
from pathlib import Path
def offline(event,args):
 if event=='socket.connect':
  address=args[1]
  if isinstance(address,tuple) and address[0] not in {'127.0.0.1','::1','localhost'}:raise RuntimeError('External socket forbidden')
 if event=='socket.getaddrinfo' and args[0] not in {'127.0.0.1','::1','localhost',None}:raise RuntimeError('External DNS forbidden')
sys.addaudithook(offline)
sys.path.insert(0,sys.argv.pop(1));import local_runner
if sys.argv[-1]=='fixture-inspect-only':
 sys.argv.pop()
 original_api=local_runner.api
 def inspect_api(data,directory):
  from app.engine import outbox
  async def no_dispatch(*args,**kwargs):return 0
  outbox.dispatch_outbox_batch=no_dispatch
  original_api(data,directory)
 local_runner.api=inspect_api
local_runner.main()
"""
        api = spawn('direct-api-resume' if resume else 'direct-api', [sys.executable, '-B', '-c', launch, str(ROOT / 'integrations/agenthub'), '--state', str(engine / 'engine'), '--backend', str(backend), 'api', *(['fixture-inspect-only'] if resume else [])])
        ready(api, ports[0]);blocked_maintenance()
        with psycopg.connect(**database_connection(data, data['database'])) as db:
            assert db.execute('SELECT count(*) FROM synplex_execution_submissions').fetchone()[0] == int(resume)
            assert db.execute('SELECT count(*) FROM executions').fetchone()[0] == int(resume)
        config = evidence / 'private-node-settings.json'
        settings = {'endpoint':f'http://127.0.0.1:{ports[0]}','workflowId':data['workflow_id'],'tokenFile':str(engine / 'engine/access-token')}
        if resume:
            assert read_private(config) == settings
        else:
            write_private(config, settings)
        child = spawn('node-lookup-resume' if resume else 'node-admission', [str(node), '--import', './scripts/testing/offline.mjs', str(ROOT / 'scripts/integration/submission-live-api-check.mjs'), str(evidence), str(config), *(['--resume-lookup'] if resume else [])])
        assert child.wait(timeout=45) == 0, 'Inspect original Node admission log before continuing'
        result = read_private(evidence / 'node-result.json')
        with psycopg.connect(**database_connection(data, data['database'])) as db:
            tasks = db.execute('SELECT id,status,run_attempt,input_tokens,output_tokens,plan,checkpoint_data,cost FROM executions').fetchall()
            assert len(tasks) == 1 and str(tasks[0][0]) == result['executionId']
            assert tasks[0][1:6] == ('pending', 0, 0, 0, None) and tasks[0][6] is None and tasks[0][7] is None
            rows = db.execute('SELECT operation_id,attempt_id,execution_id FROM synplex_execution_submissions').fetchall()
            assert rows == [(result['operationId'], result['attemptId'], result['executionId'])]
            assert db.execute('SELECT count(*) FROM outbox_events').fetchone()[0] == 1
            if resume:
                assert db.execute('SELECT count(*) FROM outbox_events WHERE published_at IS NOT NULL').fetchone()[0] == observed['publishedEvents']
            assert db.execute('SELECT count(*) FROM tool_calls').fetchone()[0] == 0
        api.terminate();stop_code = api.wait(timeout=15)
        write_private(evidence / 'api-stop.json', {'exitCode':stop_code,'requestedSignal':'SIGTERM'})
        # Uvicorn may re-raise the handled termination signal after cleanup.
        assert stop_code in {0, -signal.SIGTERM}
        owned.close();owned = None
        with startup_lease(engine):
            pass
        report = {'status':'passed','actualApiLifespanInitializedReceiptTable':True,
                  'supervisedApiAndWorkerHoldInheritedLease':True,'directApiExcludesMaintenance':True,
                  'ownedProcessesStoppedAndLeaseReleased':True,'nodeToRealEngineLostAcknowledgementRecovered':True,
                  'posts':1,'executions':1,'attempts':1,'outboxEvents':1,'taskRemainsPending':True,
                  'workerAfterProviderConfigured':False,'externalSocketsInAdmissionApi':'forbidden',
                  'modelCalls':0,'realProviderValidation':False,'recoveryActivation':False,'continuedWithoutResubmitting':resume,
                  'inspectionPhaseDispatcher': 'test-only no-op; pending outbox preserved' if resume else 'original'}
        write_private(evidence / 'result.json', report)
        return report
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate();child.wait(timeout=30)
        if owned:
            owned.close()
        for log in logs:
            log.close()


if __name__ == '__main__':
    print(json.dumps(run(*[Path(p).resolve() for p in sys.argv[1:6]],resume=sys.argv[6:] == ['--resume-lookup'])))
