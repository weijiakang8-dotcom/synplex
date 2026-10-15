"""Free real private PG/Valkey check. No provider, task execution or replay.

Use a new evidence directory. A failed phase is preserved for explicit inspection,
not automatically retried; source identity is never rewritten to reuse old data.
"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import uuid

import httpx
import psycopg
from redis import Redis

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations/agenthub'))
from engine_runtime import setup, configuration, ensure_database_idle, ensure_queue_idle
from local_runner import database_connection
from private_infrastructure import OwnedInfrastructure, safe_env, write_private


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def run(backend, pg_bin, valkey, evidence):
    evidence.mkdir(parents=True, mode=0o700)  # Refuse an existing attempt.
    engine = evidence / 'engine'
    ports = [port() for _ in range(3)]
    assert len(set(ports)) == 3
    setup(engine, backend, pg_bin, valkey, api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    _, infra, data = configuration(engine)
    logs, children, owned, queue = [], [], None, None

    def spawn(name, command):
        log = open(evidence / (name + '.log'), 'xb');os.chmod(log.name, 0o600);logs.append(log)
        child = subprocess.Popen(command, cwd=ROOT, env=safe_env(), stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        children.append(child)
        return child

    def ready(child):
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            assert child.poll() is None, 'API exited; inspect the preserved log'
            try:
                if httpx.get(f'http://127.0.0.1:{ports[0]}/health/live', timeout=1).status_code == 200:return
            except httpx.HTTPError:pass
            time.sleep(.1)
        raise RuntimeError('Private API readiness timed out')

    def stop(child):
        child.terminate()
        code = child.wait(timeout=30)
        assert code in {0, -signal.SIGTERM}, code

    runner = ROOT / 'integrations/agenthub/local_runner.py'
    command = lambda role: [sys.executable, '-B', str(runner), '--state', str(engine / 'engine'), '--backend', str(backend), role]
    refusals = []

    def refused(name, role):
        child = spawn(name, command(role))
        assert child.wait(timeout=20) == 1, 'Unsafe direct entry reached the service loop'
        refusals.append(name)

    try:
        # First exercise the normal paired startup after the shared preflight refactor.
        supervisor = spawn('supervised', [sys.executable, '-B', str(ROOT / 'integrations/agenthub/engine_runtime.py'), 'run', '--root', str(engine)])
        ready(supervisor)
        deadline = time.monotonic() + 20
        while b'celery@' not in (engine / 'worker.log').read_bytes():
            assert supervisor.poll() is None
            if time.monotonic() > deadline:raise RuntimeError('Supervised worker not initialized')
            time.sleep(.1)
        stop(supervisor)
        owned = OwnedInfrastructure(infra);owned.start_database();owned.start_queue(valkey, engine / 'engine')
        ensure_database_idle(data);ensure_queue_idle(data)
        api = spawn('direct-clean-api', command('api'));ready(api)
        refused('second-direct-worker', 'worker')  # Must not join another direct lease.
        assert httpx.get(f'http://127.0.0.1:{ports[0]}/health/live', timeout=1).status_code == 200
        stop(api)
        queue = Redis(host='127.0.0.1', port=ports[1], password=data['redis_password'])
        queue.hset('unacked', 'synthetic-undelivered', 'fixture-only-no-model-message')
        queue.zadd('unacked_index', {'synthetic-undelivered':time.time()})
        before = {key:queue.dump(key) for key in [b'unacked', b'unacked_index']}
        refused('unacked-api', 'api');refused('unacked-worker', 'worker')
        assert {key:queue.dump(key) for key in before} == before
        # A completed execution may still have a live lease: cancellation/HTTP
        # status alone is not permission to start another consumer.
        eid = uuid.uuid4()
        connection = database_connection(data, data['database'])
        with psycopg.connect(**connection) as db:
            db.execute("INSERT INTO executions(id,workflow_id,organization_id,user_id,user_input,status,context_messages,event_sequence,run_attempt,input_tokens,output_tokens,current_step_index,correlation_id,lease_owner) VALUES (%s,%s,%s,%s,'synthetic startup guard','failed','[]',0,0,0,0,0,%s,%s)",
                       (eid, data['workflow_id'], data['organization_id'], data['user_id'], str(uuid.uuid4()), str(uuid.uuid4())))
        try:ensure_database_idle(data)
        except RuntimeError as error:assert '原任务' in str(error)
        else:raise AssertionError('Terminal execution with lease was treated as idle')
        refused('leased-terminal-api', 'api');refused('leased-terminal-worker', 'worker')
        with psycopg.connect(**connection) as db:
            db.execute('SET TRANSACTION READ ONLY')
            observed = db.execute('SELECT id,status,lease_owner,run_attempt,input_tokens,output_tokens FROM executions').fetchall()
            assert len(observed) == 1 and observed[0][0] == eid and observed[0][1] == 'failed' and observed[0][2]
            assert observed[0][3:] == (0,0,0)
            assert db.execute('SELECT count(*) FROM outbox_events').fetchone()[0] == 0
            assert db.execute('SELECT count(*) FROM tool_calls').fetchone()[0] == 0
        assert {key:queue.dump(key) for key in before} == before
        queue.close();queue = None;owned.close();owned = None
        for number in ports:
            with socket.socket() as sock:assert sock.connect_ex(('127.0.0.1', number)) != 0
        result = {'status':'passed','supervisedApiAndWorkerInitialized':True,'cleanDirectApiInitialized':True,
                  'secondDirectServiceRefused':True,'unacknowledgedQueuePreserved':True,'terminalLeasePreserved':True,
                  'refusals':refusals,'allOwnedPortsClosed':True,'modelCalls':0,'taskExecutions':0,
                  'syntheticRows':1,'recoveryActivation':False,'limitation':'Refuses unsafe restart; does not reconcile or resume original work'}
        write_private(evidence / 'result.json', result)
        return result
    except Exception as error:
        write_private(evidence / 'failure.json', {'error':str(error),'refusals':refusals,'modelCalls':0})
        raise
    finally:
        for child in reversed(children):
            if child.poll() is None:child.terminate();child.wait(timeout=30)
        if queue:queue.close()
        if owned:owned.close()
        for log in logs:log.close()


if __name__ == '__main__':
    print(json.dumps(run(*[Path(value).resolve() for value in sys.argv[1:5]])))
