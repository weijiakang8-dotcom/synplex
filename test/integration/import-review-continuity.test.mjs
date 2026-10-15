import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import { WorkspaceConnector } from '../../adapters/codex/connector.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import { PROTOCOL_VERSION, validateEvidence } from '../../packages/contracts/validate.mjs';

// Real DSH parser + HTTP + SQLite + Codex connector. No synthetic context or executor.
test('imported failure remains attributable across human rejection, host reads and replay', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'synplex-integration-'));
  const repository = new WorkspaceRepository({ dataDir: join(dir, 'data') });
  const scope = { projectId: 'continuity-fixture', versionId: 'v2', branchId: null };
  const capabilities = ['read_memory', 'write_memory', 'prepare_task', 'record_result'];
  const ui = repository.createCredential({ ownerId: 'owner', actorId: 'human', scope,
    capabilities: [...capabilities, 'review_memory'], kind: 'ui' });
  const host = repository.createCredential({ ownerId: 'owner', actorId: 'codex', scope, capabilities, kind: 'agent' });
  const app = createWorkspaceServer({ repository, modules: { ingestion } });
  const endpoint = await app.listen();
  t.after(async () => { await app.close(); repository.close(); rmSync(dir, { recursive: true, force: true }); });
  const tokenFile = join(dir, 'host-token'); writeFileSync(tokenFile, host.token, { mode: 0o600 });
  const connector = new WorkspaceConnector({ endpoint, tokenFile, scope });
  const readState = () => connector.call('get_project_state', { protocolVersion: PROTOCOL_VERSION });
  const post = (name, body, token = ui.token) => fetch(`${endpoint}/api/v1/${name}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const metadata = { protocolVersion: PROTOCOL_VERSION, scope, requestId: randomUUID(), expectedStateRevision: 0,
    sourceSystem: 'user-markdown', format: 'text/markdown', formatVersion: '1', sessionId: null, eventId: randomUUID(), occurredAt: null };
  const original = '# 旧方案\n模型说成功，但实际测试失败。🧪\r\n';
  const upload = () => { const form = new FormData(); form.set('metadata', JSON.stringify(metadata));
    form.set('source', new Blob([original]), 'history.md');
    return fetch(`${endpoint}/api/v1/import_source`, { method: 'POST', headers: { Authorization: `Bearer ${ui.token}` }, body: form }); };
  const admitted = await upload(); assert.ok([201, 202].includes(admitted.status));
  const { operation } = await admitted.json(); await app.service.idle();
  const auth = repository.authenticate(ui.token), repo = await repository.forScope(auth, scope);
  const snapshot = await repo.getImportResult(operation.id); assert.equal(snapshot.result.outcome, 'complete');
  assert.equal(Buffer.from((await repo.getBlob(snapshot.result.source.id)).bytes).toString(), original);
  const state = await readState(), claim = state.pending.find(c => c.type === 'failure'); assert.ok(claim);
  assert.equal(state.facts.length, 0); assert.equal(state.failures.length, 0);
  const hits = await connector.call('find_evidence', { protocolVersion: PROTOCOL_VERSION, query: '失败', includeHistory: true, limit: 10 });
  assert.ok(hits.items.length > 0);
  for (const hit of hits.items) validateEvidence(hit.span, snapshot.result.parsed.blocks.find(b => b.id === hit.span.blockId));
  const review = { protocolVersion: PROTOCOL_VERSION, scope, requestId: randomUUID(), expectedStateRevision: state.stateRevision,
    claimId: claim.id, reviewStatus: 'rejected' };
  assert.equal((await post('authorize_review', review, host.token)).status, 403);
  const grantResponse = await post('authorize_review', review); assert.equal(grantResponse.status, 200);
  const { authorizationId } = await grantResponse.json();
  assert.equal((await post('review_claim', { ...review, authorizationId })).status, 200);
  const after = await readState(); assert.equal(after.pending.some(c => c.id === claim.id), false);
  const replay = await upload(); assert.equal(replay.status, 200); assert.equal((await replay.json()).operation.id, operation.id);
  await app.service.idle(); assert.deepEqual(await readState(), after);
  const history = await connector.call('find_evidence', { protocolVersion: PROTOCOL_VERSION, query: '失败', includeHistory: true, limit: 10 });
  assert.ok(history.items.some(hit => hit.claim?.id === claim.id)); // Rejection does not erase the source/history.
  await assert.rejects(connector.call('prepare_task', { protocolVersion: PROTOCOL_VERSION, scope, requestId: randomUUID(),
    expectedStateRevision: after.stateRevision, goal: '按最新进展继续项目', constraints: ['保留失败记录'], acceptanceCriteria: ['提供原文出处'],
    mode: 'host_assist', executor: 'current_host', selectedOccurrenceIds: [], maxInputTokens: 2000 }),
    error => error.code === 'capability_unavailable' && Boolean(error.nextAction));
  assert.equal(repository.list(auth, scope, 'run').length, 0);
  assert.deepEqual(await readState(), after);
});
