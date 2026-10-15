import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import { toolDefinitions } from '../../services/workspace/service.mjs';
import { PROTOCOL_VERSION } from '../../packages/contracts/validate.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as experience from '../../packages/experience/index.mjs';
import { createBridge, readConnection } from '../../adapters/dsh/bridge.mjs';
import { startStdio } from '../../adapters/dsh/mcp.mjs';

const scope = { projectId: 'dsh-transport-fixture', versionId: 'v1', branchId: null };
async function setup(t, modules = { ingestion, experience }) {
  const dir = mkdtempSync(join(tmpdir(), 'synplex-dsh-test-'));
  const repository = new WorkspaceRepository({ dataDir: join(dir, 'data') });
  const capabilities = ['read_memory', 'write_memory', 'prepare_task', 'record_result'];
  const host = repository.createCredential({ ownerId: 'owner', actorId: 'dsh-fixture', scope, capabilities, kind: 'agent' });
  const ui = repository.createCredential({ ownerId: 'owner', actorId: 'human-fixture', scope, capabilities: [...capabilities, 'review_memory'], kind: 'ui' });
  const app = createWorkspaceServer({ repository, modules }), endpoint = await app.listen();
  const tokenFile = join(dir, 'host-token'); writeFileSync(tokenFile, host.token, { mode: 0o600 });
  const config = { endpoint, tokenFile, scope }, connectionFile = join(dir, 'connection.json');
  writeFileSync(connectionFile, JSON.stringify(config), { mode: 0o600 });
  t.after(async () => { await app.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, repository, host, ui, app, config, connectionFile };
}
function processClient(t, connectionFile, forbiddenToken) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../adapters/dsh/mcp.mjs', import.meta.url)), connectionFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let seq = 0, stdout = '', stderr = ''; const waiting = new Map();
  child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line), call = waiting.get(value.id);
    if (call) { clearTimeout(call.timer); waiting.delete(value.id); call.resolve(value); }
  });
  const exited = new Promise(resolve => child.once('exit', code => {
    for (const call of waiting.values()) { clearTimeout(call.timer); call.reject(new Error('Bridge exited')); }
    waiting.clear(); resolve(code);
  }));
  t.after(async () => { child.stdin.end(); assert.equal(await exited, 0); assert.equal(stderr, ''); assert.equal(stdout.includes(forbiddenToken), false); });
  return { rpc(method, params = {}) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new Error('Bridge RPC timeout')); }, 4000);
      waiting.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  } };
}

test('DSH stdio bridge lists shared six scoped tools and reads real HTTP SQLite', async t => {
  const fixture = await setup(t), client = processClient(t, fixture.connectionFile, fixture.host.token);
  assert.equal((await client.rpc('tools/list')).error.code, -32002);
  assert.equal((await client.rpc('initialize', { protocolVersion: 'unknown' })).result.protocolVersion, '2025-06-18');
  const tools = (await client.rpc('tools/list')).result.tools;
  assert.deepEqual(tools, createBridge(fixture.config).tools);
  assert.equal(tools.length, 6);
  for (const [i, tool] of tools.entries()) {
    assert.deepEqual(tool.inputSchema.properties.scope.const, scope);
    const unbound = structuredClone(tool); delete unbound.inputSchema.properties.scope.const;
    assert.deepEqual(unbound, toolDefinitions()[i]);
  }
  const state = await client.rpc('tools/call', { name: 'get_project_state', arguments: { protocolVersion: PROTOCOL_VERSION } });
  assert.deepEqual(state.result.structuredContent.scope, scope);
  assert.equal(JSON.parse(state.result.content[0].text).stateRevision, 0);
  const denied = await client.rpc('tools/call', { name: 'get_project_state', arguments: { protocolVersion: PROTOCOL_VERSION, scope: { ...scope, versionId: null } } });
  assert.equal(JSON.parse(denied.result.content[0].text).code, 'scope_denied');
  const unsupported = await client.rpc('tools/call', { name: 'execute', arguments: {} });
  assert.equal(JSON.parse(unsupported.result.content[0].text).code, 'validation_failed');
  const unavailable = await client.rpc('tools/call', { name: 'prepare_task', arguments: { protocolVersion: PROTOCOL_VERSION, scope,
    requestId: 'prep-1', expectedStateRevision: 0, goal: 'Continue', constraints: [], acceptanceCriteria: ['source evidence'], mode: 'host_assist', executor: 'current_host', selectedOccurrenceIds: [], maxInputTokens: 2000 } });
  assert.equal(JSON.parse(unavailable.result.content[0].text).code, 'capability_unavailable');
  assert.equal(fixture.repository.list(fixture.repository.authenticate(fixture.host.token), scope, 'run').length, 0);
});

test('DSH bridge enforces protected token files, strict config and current-host preparation', async t => {
  const f = await setup(t), bridge = createBridge(readConnection(f.connectionFile));
  assert.throws(() => createBridge({ ...f.config, token: f.host.token }), e => e.code === 'validation_failed');
  assert.throws(() => createBridge({ ...f.config, endpoint: 'https://example.com' }), e => e.code === 'scope_denied');
  assert.throws(() => readConnection('relative.json'), e => e.code === 'capability_unavailable');
  await assert.rejects(bridge.call('prepare_task', { mode: 'delegated', executor: 'new_agent' }), e => e.code === 'validation_failed');
  chmodSync(f.config.tokenFile, 0o644);
  await assert.rejects(bridge.call('get_project_state', { protocolVersion: PROTOCOL_VERSION }), e => e.code === 'scope_denied');
  chmodSync(f.config.tokenFile, 0o600);
  const link = join(f.dir, 'symlink'); symlinkSync(f.config.tokenFile, link);
  await assert.rejects(createBridge({ ...f.config, tokenFile: link }).call('get_project_state', { protocolVersion: PROTOCOL_VERSION }), e => e.code === 'scope_denied');
});

test('DSH bridge preserves imported evidence and pending lessons over real HTTP SQLite', async t => {
  const f = await setup(t), bridge = createBridge(f.config);
  const metadata = { protocolVersion: PROTOCOL_VERSION, scope, requestId: 'import-1', expectedStateRevision: 0,
    sourceSystem: 'user-markdown', format: 'text/markdown', formatVersion: '1', sessionId: null, eventId: 'history-1', occurredAt: null };
  const form = new FormData(); form.set('metadata', JSON.stringify(metadata)); form.set('source', new Blob(['# History\nRepeated execution failed; retain the original receipt.\n']), 'history.md');
  const upload = await fetch(`${f.config.endpoint}/api/v1/import_source`, { method: 'POST', headers: { Authorization: `Bearer ${f.ui.token}` }, body: form });
  assert.ok([201, 202].includes(upload.status)); const { operation } = await upload.json(); await f.app.service.idle();
  const op = await bridge.call('get_operation', { protocolVersion: PROTOCOL_VERSION, operationId: operation.id }); assert.equal(op.status, 'succeeded');
  const hits = await bridge.call('find_evidence', { protocolVersion: PROTOCOL_VERSION, query: 'execution', limit: 10, includeHistory: true }); assert.ok(hits.items.length);
  const state = await bridge.call('get_project_state', { protocolVersion: PROTOCOL_VERSION });
  const request = { protocolVersion: PROTOCOL_VERSION, requestId: 'lesson-1', expectedStateRevision: state.stateRevision,
    candidate: { type: 'lesson', title: 'Keep receipts', body: 'Look up the original receipt after uncertainty.', evidenceKind: 'assistant_statement',
      evidence: [hits.items[0].span], occurredAt: null, supersedes: [], condition: 'When execution status is unknown' } };
  const result = await bridge.call('propose_lesson', request);
  assert.equal(result.claim.reviewStatus, 'pending'); assert.deepEqual(await bridge.call('propose_lesson', request), result);
  assert.equal((await bridge.call('get_operation', { protocolVersion: PROTOCOL_VERSION, operationId: result.operation.id })).id, result.operation.id);
  const after = await bridge.call('get_project_state', { protocolVersion: PROTOCOL_VERSION }); assert.ok(after.pending.some(c => c.id === result.claim.id));
  assert.equal(after.lessons.some(c => c.id === result.claim.id), false);
});

test('stdio framing bounds pre-newline input and recovers without leaking configuration', () => {
  const input = new PassThrough(), output = new PassThrough(); let text = ''; output.on('data', b => text += b);
  const stop = startStdio({ input, output, connectionFile: '/nonexistent/connection.json' });
  input.write(Buffer.alloc(2 * 1024 * 1024 + 4097, 32)); input.write('\n');
  input.write('{bad}\n'); input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n'); stop();
  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages[0].error.code, -32600); assert.equal(messages[1].error.code, -32700);
  assert.equal(messages[2].result.protocolVersion, '2024-11-05'); assert.equal(messages[3].error.code, -32603);
  assert.equal(text.includes('/nonexistent'), false);
});
