"""Create the same pinned environment witness as the local installer, at build."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

lock = Path('/app/vendor/agenthub/backend/requirements.lock').read_bytes()
for line in lock.decode().splitlines():
    if line and not line.startswith(('#', ' ')):
        name, version = line.strip().split('==')
        if importlib.metadata.version(name) != version:
            raise RuntimeError('Installed Python dependency differs from lock')
file = Path(sys.prefix) / 'synplex-environment.json'
with os.fdopen(os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
    json.dump({'format': 'synplex.engine-environment/1', 'status': 'complete',
               'lockSha256': hashlib.sha256(lock).hexdigest(), 'modelCalls': 0}, out)
