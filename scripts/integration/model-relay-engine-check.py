"""Fresh private engine and actual full-stack document delivery; no paid calls."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'integrations/agenthub'))
from engine_runtime import setup, configuration
from model_relay import configure
from private_infrastructure import safe_env


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--directory', required=True, type=Path)
    p.add_argument('--postgres-bin', required=True, type=Path)
    p.add_argument('--valkey', required=True, type=Path)
    p.add_argument('--node', required=True)
    p.add_argument('--tenants', action='store_true')
    args = p.parse_args()
    directory = args.directory.absolute()
    if directory.exists():
        raise RuntimeError('Preserve existing evidence; this scenario needs a fresh directory')
    directory.mkdir(parents=True, mode=0o700)
    ports = [port() for _ in range(4)]
    assert len(set(ports)) == 4
    (directory / 'ports.json').write_text(json.dumps(ports))
    os.chmod(directory / 'ports.json', 0o600)
    backend = root / 'vendor/agenthub/backend'
    setup(directory / 'engine', backend, args.postgres_bin, args.valkey,
          api_port=ports[0], redis_port=ports[1], database_port=ports[2])
    configure(directory / 'engine', f'http://127.0.0.1:{ports[3]}/internal/model/v1')
    configuration(directory / 'engine')
    log = open(directory / 'engine-supervisor.log', 'xb')
    os.chmod(log.name, 0o600)
    child = subprocess.Popen([sys.executable, '-B', str(root / 'integrations/agenthub/engine_runtime.py'),
                              'run', '--root', str(directory / 'engine')],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=safe_env())
    try:
        deadline = time.monotonic() + 35
        while b'synplex.engine-ready/1' not in Path(log.name).read_bytes():
            if child.poll() is not None:
                raise RuntimeError('Private engine exited; inspect its own logs')
            if time.monotonic() > deadline:
                raise RuntimeError('Private engine readiness timed out')
            time.sleep(.1)
        result = subprocess.run([args.node, str(root / ('scripts/integration/accounts-engine-workspace.mjs' if args.tenants else 'scripts/integration/model-relay-engine-workspace.mjs')),
                                 str(directory), str(ports[3])], cwd=root, env=safe_env(),
                                capture_output=True, timeout=110)
        output = directory / 'workspace-check.log'
        output.write_bytes(result.stdout + result.stderr)
        os.chmod(output, 0o600)
        if result.returncode:
            raise RuntimeError('Full-stack fixture failed; inspect preserved private evidence')
        print(result.stdout.decode())
        if args.tenants:
            proof = subprocess.run([sys.executable, '-B', str(root / 'scripts/integration/accounts-engine-boundary-check.py'), str(directory)], cwd=root, env=safe_env(), capture_output=True, timeout=30)
            (directory / 'boundary-check.log').write_bytes(proof.stdout + proof.stderr)
            if proof.returncode:
                raise RuntimeError('Tenant engine boundary check failed; inspect private evidence')
            print(proof.stdout.decode())
    finally:
        if child.poll() is None:
            child.terminate()
            child.wait(timeout=25)
        log.close()


if __name__ == '__main__':
    main()
