import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../..', import.meta.url));

test('actual CLI loads ingestion, completes authenticated HTTP import and retains its snapshot across restart', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'synplex-dsh-cli-')), children = [];
  t.after(async () => {
    await Promise.all(children.map(c => c.stop()));
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir())); assert.ok(basename(dataDir).startsWith('synplex-dsh-cli-'));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const scope = { projectId: 'dsh-cli-stage', versionId: null, branchId: null };
  async function boot() {
    const process = spawn(globalThis.process.execPath, ['services/workspace/server.mjs'], { cwd: root,
      env: { ...globalThis.process.env, SYNPLEX_WORKSPACE_DATA_DIR: dataDir, SYNPLEX_WORKSPACE_PORT: String(port), SYNPLEX_WORKSPACE_SCOPE: JSON.stringify(scope) },
      stdio: ['ignore','pipe','pipe'] });
    let closed = false, stdout = '';
    const exit = new Promise(r => process.once('close', code => { closed = true; r(code); }));
    const child = { stop: async () => { if (!closed) process.kill('SIGTERM'); return exit; } }; children.push(child);
    const started = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated CLI did not start')), 3000);
      process.once('error', error => { clearTimeout(timer); reject(error); });
      process.once('close', () => { clearTimeout(timer); if (!stdout.includes('\n')) reject(new Error('CLI closed before readiness')); });
      process.stdout.on('data', bytes => {
        stdout += bytes; if (!stdout.includes('\n')) return;
        clearTimeout(timer); try { resolve(JSON.parse(stdout.split('\n')[0])); } catch (error) { reject(error); }
      });
    });
    assert.equal(started.url, `http://127.0.0.1:${port}`);
    assert.deepEqual({ import: started.capabilities.import, context: started.capabilities.context,
      experience: started.capabilities.experience, execution: started.capabilities.execution },
      { import: true, context: true, experience: true, execution: false });
    return { ...child, ...started };
  }
  const first = await boot(), connection = JSON.parse(readFileSync(first.connectionFile, 'utf8'));
  const token = readFileSync(connection.agentTokenFile, 'utf8');
  assert.equal(statSync(connection.agentTokenFile).mode & 0o077, 0);
  const headers = { Authorization: `Bearer ${readFileSync(connection.uiTokenFile, 'utf8')}` }, protocolVersion = 'synplex.workspace/1.0.0';
  const post = async (route, body) => {
    const response = await fetch(`${first.url}/api/v1/${route}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.status === 200 || route === 'get_import_result' && response.status === 202); return response.json();
  };
  const form = new FormData();
  form.append('metadata', JSON.stringify({ protocolVersion, scope, requestId: randomUUID(), expectedStateRevision: 0,
    format: 'text/plain', sourceSystem: 'user-text', formatVersion: '1', sessionId: null, eventId: randomUUID(), occurredAt: null }));
  form.append('source', new Blob(['旧方案失败。决定保留原始证据🧪。'], { type: 'text/plain' }), 'explicit.txt');
  const admitted = await fetch(`${first.url}/api/v1/import_source`, { method: 'POST', headers, body: form });
  assert.ok([201, 202].includes(admitted.status)); const { operation } = await admitted.json();
  let result;
  for (let i = 0; i < 100; i++) {
    result = await post('get_import_result', { protocolVersion, scope, operationId: operation.id });
    if (result.result) break;
    assert.ok(['queued','running'].includes(result.operation.status)); await delay(5);
  }
  assert.equal(result.result.outcome, 'complete'); assert.equal(result.operation.status, 'succeeded');
  const state = await post('get_project_state', { protocolVersion, scope }); assert.equal(state.pending.length, 1);
  assert.equal(await first.stop(), 0); const second = await boot();
  assert.equal(readFileSync(connection.agentTokenFile, 'utf8'), token);
  const retained = await post('get_import_result', { protocolVersion, scope, operationId: operation.id });
  assert.deepEqual(retained, result); assert.deepEqual(await post('get_project_state', { protocolVersion, scope }), state);
  assert.equal(await second.stop(), 0);
});
