import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { ExecutionCoordinator } from '../../services/workspace/execution.mjs';
import { PROTOCOL_VERSION, payloadHash } from '../../packages/contracts/validate.mjs';
import { setup, scope, errorIs } from '../ingestion/helpers.mjs';

// Deterministic in-memory execution fixture only; no model, command or host execution.
// Recovery operates on an already authorized intent, rather than transferring its grant.
test('same-owner queued recovery preserves original intent, consumed grant, packet and unique attempt', async t => {
  const h = await setup(t), capabilities = ['read_memory','write_memory','prepare_task','record_result','execute'];
  const credential = actorId => h.repository.createCredential({ ownerId: 'test-owner', actorId, scope, capabilities, kind: 'ui' });
  const a = h.repository.authenticate(credential('actor-a').token), b = h.repository.authenticate(credential('actor-b').token);
  const state = h.repository.state(a, scope), request = { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), scope,
    expectedStateRevision: state.stateRevision, goal: '隔离检查授权边界', constraints: ['不调用宿主或模型'],
    acceptanceCriteria: ['保留已授权意图及唯一尝试'], mode: 'platform_owned', executor: 'synplex', selectedOccurrenceIds: [], maxInputTokens: 2000 };
  const packet = { id: randomUUID(), protocolVersion: PROTOCOL_VERSION, scope, stateRevision: state.stateRevision,
    permissionRevision: state.permissionRevision, goal: request.goal, constraints: request.constraints, acceptanceCriteria: request.acceptanceCriteria,
    facts: [], failures: [], lessons: [], candidates: [], conflicts: [], unknowns: [], evidence: [], selectedOccurrenceIds: [], coverage: 'complete',
    budget: { maxInputTokens: 2000, reservedTokens: 100, estimatedTokens: 300, estimatorVersion: 'synthetic-review/1' }, createdAt: new Date().toISOString() };
  packet.contentHash = payloadHash(packet);
  const prepared = h.repository.registerPrepared(a, request, packet).value;
  const grantRequest = { protocolVersion: PROTOCOL_VERSION, scope, requestId: randomUUID(), expectedStateRevision: state.stateRevision, runId: prepared.run.id };
  const { authorizationId } = h.repository.issueExecutionAuthorization(a, grantRequest), startInput = { ...grantRequest, authorizationId };
  assert.throws(() => h.repository.admitExecution(b, startInput), errorIs('scope_denied'));
  const admitted = h.repository.admitExecution(a, startInput), seen = [];
  const audit = new DatabaseSync(join(h.dataDir, 'workspace.sqlite'), { readOnly: true });
  const grant = () => audit.prepare('SELECT actor_id, used, input_hash FROM authorizations WHERE id=?').get(authorizationId);
  const consumed = grant(); assert.equal(consumed.actor_id, 'actor-a'); assert.equal(consumed.used, 1);
  const coordinator = new ExecutionCoordinator({ repository: h.repository, adapters: { synplex: { mode: 'platform_owned', execute: async ({ operationId, attemptId, idempotencyKey, packet }) => {
    seen.push({ operationId, attemptId, idempotencyKey, packet });
    return { status: 'succeeded', result: { eventId: randomUUID(), attemptId, provider: 'synthetic-local-review', summary: '纯夹具回执',
      artifacts: [], checks: [], usage: { observationScope: 'host_unavailable', provider: null, model: null, inputTokens: null,
        outputTokens: null, cachedInputTokens: null, costUsd: null, pricingRevision: null, provenance: 'unknown' }, supersedesResultId: null, occurredAt: null } };
  } } } });
  try {
    await assert.rejects(coordinator.start(b, { ...startInput, authorizationId: 'different' }), errorIs('conflict'));
    assert.equal(seen.length, 0);
    const replay = await coordinator.start(b, startInput); assert.equal(replay.operation.id, admitted.operationId);
    await coordinator.idle(); assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { operationId: admitted.operationId, attemptId: admitted.value.attempt.id, idempotencyKey: admitted.operationId, packet });
    assert.deepEqual(grant(), consumed); assert.equal(h.repository.list(a, scope, 'attempt').length, 1);
    const finished = h.repository.executionState(a, scope, admitted.operationId);
    assert.equal(finished.operation.status, 'succeeded'); assert.equal(finished.results.length, 1);
    assert.equal(finished.results[0].actorId, 'actor-b'); // recorder, not the original authorizer
    await coordinator.start(a, { ...startInput, expectedStateRevision: 999 }); await coordinator.idle();
    assert.equal(seen.length, 1); assert.equal(h.repository.list(a, scope, 'attempt').length, 1); assert.deepEqual(grant(), consumed);
  } finally { await coordinator.close(); audit.close(); }
});
