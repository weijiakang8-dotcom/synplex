"""One offline queue admission scenario; no Redis, DB or model is started."""
import base64
import copy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'integrations/agenthub'))
import engine_runtime as runtime
import local_runner

eid, organization = str(uuid.uuid4()), str(uuid.uuid4())
message = {'headers': {'task': 'agenthub.evaluate_execution'}, 'content-type': 'application/json',
           'properties': {'body_encoding': 'base64', 'delivery_info': {'exchange': '', 'routing_key': 'synplex-evaluation-disabled'}},
           'body': base64.b64encode(json.dumps([[eid], {}, {'callbacks': None, 'chain': None}]).encode()).decode()}
raw = json.dumps(message).encode()
assert runtime.disabled_evaluation_id(raw) == eid
for mutation in ['wrong-task', 'wrong-route', 'callback', 'malformed']:
    changed = copy.deepcopy(message)
    if mutation == 'wrong-task':
        changed['headers']['task'] = 'agenthub.execute_workflow'
    elif mutation == 'wrong-route':
        changed['properties']['delivery_info']['routing_key'] = 'synplex-isolated'
    elif mutation == 'callback':
        changed['body'] = base64.b64encode(json.dumps([[eid], {}, {'callbacks': [{'task': 'unexpected'}]}]).encode()).decode()
    else:
        changed['body'] = 'invalid base64'
    try:
        runtime.disabled_evaluation_id(json.dumps(changed).encode())
    except RuntimeError:
        pass
    else:
        raise AssertionError('Invalid disabled message was accepted')

class Broker:
    def __init__(self):
        self.key, self.kind, self.messages = b'synplex-evaluation-disabled', b'list', [raw]
    def scan_iter(self): return [self.key]
    def type(self, key): return self.kind
    def llen(self, key): return len(self.messages)
    def lrange(self, key, start, end): return self.messages[start:end + 1]
    def hlen(self, key): return 1
    def zcard(self, key): return 1
    def close(self): pass

class Database:
    row = ('completed', None, organization)
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def execute(self, query, params=None):
        assert query.startswith(('SET TRANSACTION', 'SELECT status,')), query
        if params is not None: assert params == (eid,)
        return self
    def fetchone(self): return self.row

broker = Broker()
local_runner.database_connection = lambda *args: {}
sys.modules['redis'] = SimpleNamespace(Redis=lambda **kwargs: broker)
sys.modules['psycopg'] = SimpleNamespace(connect=lambda **kwargs: Database())
data = {'redis_port': 1, 'redis_password': 'synthetic-only', 'database': 'fixture', 'organization_id': organization}
runtime.ensure_queue_idle(data)
assert broker.messages == [raw]  # A completed evaluation remains byte-for-byte.
cases = [
    (b'synplex-isolated', b'list', Database.row),
    (b'unacked', b'hash', Database.row),
    (b'unacked_index', b'zset', Database.row),
    (b'synplex-evaluation-disabled', b'list', ('running', None, organization)),
    (b'synplex-evaluation-disabled', b'list', ('completed', 'lease', organization)),
    (b'synplex-evaluation-disabled', b'list', ('completed', None, str(uuid.uuid4()))),
    (b'synplex-evaluation-disabled', b'list', None),
]
for key, kind, row in cases:
    broker.key, broker.kind, Database.row = key, kind, row
    try:
        runtime.ensure_queue_idle(data)
    except RuntimeError:
        pass
    else:
        raise AssertionError('Unknown, active or foreign work accepted')
    assert broker.messages == [raw]
print('Only validated terminal in-scope evaluation messages remain inert; active, unacked, malformed and foreign work block startup; bytes preserved; modelCalls=0')
