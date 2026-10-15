import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as experience from '../../packages/experience/index.mjs';
import { PROTOCOL_VERSION, validateWire, payloadHash, sha256 } from '../../packages/contracts/validate.mjs';
import { setup, scope } from '../ingestion/helpers.mjs';

const requestTypes = { get_project_state: 'GetStateRequest', find_evidence: 'FindEvidenceRequest',
  prepare_task: 'PrepareTaskRequest', propose_lesson: 'ProposeLessonRequest', get_operation: 'GetOperationRequest',
  get_import_result: 'GetImportResultRequest' };
const responseTypes = { get_project_state: 'ProjectState', find_evidence: 'FindEvidenceResponse',
  prepare_task: 'PrepareTaskResponse', propose_lesson: 'ProposeLessonResponse', get_operation: 'Operation',
  get_import_result: 'ImportOperationResponse' };
const envelope = extra => ({ protocolVersion: PROTOCOL_VERSION, scope, ...extra });

function verifyPacket(packet, request) {
  validateWire('ContextPacket', packet);
  assert.equal(packet.goal, request.goal);
  assert.deepEqual(packet.constraints, request.constraints);
  assert.deepEqual(packet.acceptanceCriteria, request.acceptanceCriteria);
  assert.deepEqual(packet.selectedOccurrenceIds, request.selectedOccurrenceIds);
  assert.deepEqual(packet.scope, scope);
  assert.equal(packet.stateRevision, request.expectedStateRevision);
  assert.equal(packet.budget.maxInputTokens, request.maxInputTokens);
  assert.equal(packet.budget.reservedTokens, 512);
  assert.equal(packet.budget.estimatorVersion, 'utf8-bytes-conservative/1');
  const mandatoryBytes = Buffer.byteLength(request.goal + request.constraints.join('') + request.acceptanceCriteria.join(''), 'utf8');
  assert.ok(packet.budget.estimatedTokens >= mandatoryBytes, 'conservative estimate covers mandatory UTF-8 text');
  assert.ok(packet.budget.estimatedTokens + 512 <= packet.budget.maxInputTokens);
  const { contentHash, ...content } = packet;
  assert.equal(contentHash, payloadHash(content));
}

test('real HTTP import, context and lesson review preserve frozen inputs, packets and stale receipts', { timeout: 15000 }, async t => {
  // Dynamic import permits writing this test before context is available; there is
  // deliberately no substitute implementation or skip when the module is missing.
  const context = await import('../../packages/context/index.mjs');
  let app;
  const h = await setup({ after: cleanup => t.after(async () => { try { if (app) await app.close(); } finally { cleanup(); } }) });
  const agent = h.repository.createCredential({ ownerId: 'test-owner', actorId: 'http-agent', scope,
    kind: 'agent', capabilities: ['read_memory', 'write_memory', 'prepare_task'] });
  app = createWorkspaceServer({ repository: h.repository, modules: { ingestion, context, experience } });
  const url = await app.listen(0);

  async function post(route, input, { token = agent.token, status = 200 } = {}) {
    if (requestTypes[route]) validateWire(requestTypes[route], input);
    if (route === 'authorize_review') validateWire('ReviewRequest', { ...input, authorizationId: 'issued-by-service' });
    if (route === 'review_claim') validateWire('ReviewRequest', input);
    const response = await fetch(`${url}/api/v1/${route}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });
    const body = await response.json();
    assert.ok([status].flat().includes(response.status), `${route}: status ${response.status}, ${JSON.stringify(body)}`);
    if (response.status >= 400) validateWire('Error', body);
    else if (responseTypes[route]) validateWire(responseTypes[route], body);
    else if (route === 'review_claim') validateWire('Claim', body.value);
    return body;
  }
  async function capabilities() {
    const response = await fetch(`${url}/api/v1/capabilities`, { headers: { Authorization: `Bearer ${agent.token}` } });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.deepEqual({ import: value.import, context: value.context, experience: value.experience, execution: value.execution },
      { import: true, context: true, experience: true, execution: false });
    return value;
  }
  const state = () => post('get_project_state', envelope({}));
  const mutation = async () => ({ requestId: randomUUID(), expectedStateRevision: (await state()).stateRevision });
  async function review(claimId, reviewStatus) {
    const request = envelope({ ...(await mutation()), claimId, reviewStatus });
    assert.equal((await post('authorize_review', request, { status: 403 })).code, 'scope_denied');
    const grant = await post('authorize_review', request, { token: h.credential.token });
    assert.ok(grant.authorizationId); assert.ok(Date.parse(grant.expiresAt) > Date.now());
    const input = { ...request, authorizationId: grant.authorizationId };
    assert.equal((await post('review_claim', input, { status: 403 })).code, 'scope_denied');
    const result = await post('review_claim', input, { token: h.credential.token });
    assert.equal(result.value.id, claimId); assert.equal(result.value.reviewStatus, reviewStatus);
    assert.equal(result.value.actorId, 'http-agent');
    assert.equal(result.stateRevision, request.expectedStateRevision + 1);
    return result;
  }

  await capabilities();
  const text = '请求超时。先查看原回执🧪，确认状态后再重试；历史失败与被拒经验不能被覆盖。';
  const metadata = envelope({ ...(await mutation()), format: 'text/plain', sourceSystem: 'user-text', formatVersion: '1',
    sessionId: null, eventId: randomUUID(), occurredAt: null });
  validateWire('ImportMetadataRequest', metadata);
  const form = new FormData(); form.append('metadata', JSON.stringify(metadata));
  form.append('source', new Blob([text], { type: 'text/plain' }), 'isolated-original.txt');
  const deniedUpload = await fetch(`${url}/api/v1/import_source`, { method: 'POST', headers: { Authorization: `Bearer ${agent.token}` }, body: form });
  assert.equal(deniedUpload.status, 403); validateWire('Error', await deniedUpload.json());
  const admitted = await fetch(`${url}/api/v1/import_source`, { method: 'POST', headers: { Authorization: `Bearer ${h.credential.token}` }, body: form });
  assert.ok([200, 201, 202].includes(admitted.status));
  const admission = await admitted.json(); validateWire('ImportOperationResponse', admission);
  let imported;
  for (let i = 0; i < 200; i++) {
    imported = await post('get_import_result', envelope({ operationId: admission.operation.id }), { status: [200, 202] });
    if (imported.result) break;
    assert.ok(['queued', 'running'].includes(imported.operation.status)); await delay(5);
  }
  assert.ok(imported.result, 'public import polling reaches a retained result');
  assert.equal(imported.operation.status, 'succeeded'); assert.equal(imported.result.outcome, 'complete');
  const { source, parsed, occurrences } = imported.result;
  assert.equal(source.sha256, sha256(Buffer.from(text))); assert.equal(occurrences.length, 1);
  const block = parsed.blocks[0]; assert.equal(block.text, text);
  const evidence = [{ sourceId: source.id, parsedRevisionId: parsed.id, occurrenceId: occurrences[0].id,
    blockId: block.id, start: 0, end: block.text.length, offsetUnit: 'utf16_code_unit', quote: block.text, quoteHash: sha256(Buffer.from(block.text)) }];
  const candidate = { type: 'lesson', title: '超时后先核对回执', body: '先查询原请求的状态，再决定是否重试。',
    evidenceKind: 'historical_tool_text', evidence, occurredAt: null, supersedes: [], condition: '已提交请求超时且结果未知时。' };
  const proposalRequest = envelope({ ...(await mutation()), candidate });
  assert.equal((await post('propose_lesson', proposalRequest, { token: null, status: 403 })).code, 'scope_denied');
  assert.equal((await post('propose_lesson', proposalRequest, { token: h.credential.token, status: 200 })).claim.reviewStatus, 'pending');
  // Replay the same public request using the authorized agent: identity stays that
  // of the original UI writer; use a fresh request for the agent-authored lesson.
  const first = await post('propose_lesson', proposalRequest);
  assert.equal(first.claim.actorId, 'test-ui'); assert.deepEqual(first.claim.evidence, evidence);
  const agentRequest = envelope({ ...(await mutation()), candidate: { ...candidate, title: '等待人工核对的经验' } });
  const proposed = await post('propose_lesson', agentRequest);
  assert.equal(proposed.claim.reviewStatus, 'pending'); assert.equal(proposed.claim.actorId, 'http-agent');
  assert.equal((await state()).lessons.length, 0);

  const prepareRequest = envelope({ ...(await mutation()), goal: '  核对超时请求的回执🧪，保留原文与经验审核记录。\n保持完整目标与两侧空格。  ',
    constraints: ['  不调用模型，不重复提交原请求。  ', '保留历史失败与被拒经验。'],
    acceptanceCriteria: ['目标、约束和验收逐字保留。', '经验必须经人工审核，原文引用可核对。'],
    mode: 'host_assist', executor: 'current_host', selectedOccurrenceIds: [occurrences[0].id], maxInputTokens: 16000 });
  assert.equal((await post('prepare_task', prepareRequest, { token: null, status: 403 })).code, 'scope_denied');
  assert.equal((await post('prepare_task', prepareRequest, { token: h.credential.token, status: 403 })).code, 'scope_denied');
  const prepared = await post('prepare_task', prepareRequest), immutablePrepared = structuredClone(prepared);
  verifyPacket(prepared.packet, prepareRequest);
  assert.ok(prepared.packet.candidates.some(c => c.id === proposed.claim.id && c.reviewStatus === 'pending'));
  assert.ok(!prepared.packet.lessons.some(c => c.id === proposed.claim.id));
  assert.ok(prepared.packet.evidence.some(span => payloadHash(span) === payloadHash(evidence[0])));
  assert.equal(prepared.run.status, 'prepared'); assert.deepEqual(prepared.run.attemptIds, []);
  assert.equal(prepared.operation.executionStatus, 'not_started');
  assert.equal(prepared.run.contextPacketId, prepared.packet.id);
  assert.equal((await post('get_operation', envelope({ operationId: prepared.operation.id }))).id, prepared.operation.id);

  await review(proposed.claim.id, 'confirmed');
  const confirmed = await state(); assert.ok(confirmed.lessons.some(c => c.id === proposed.claim.id && c.reviewStatus === 'confirmed'));
  assert.ok(!confirmed.pending.some(c => c.id === proposed.claim.id));
  const freshRequest = { ...prepareRequest, ...(await mutation()) };
  const fresh = await post('prepare_task', freshRequest); verifyPacket(fresh.packet, freshRequest);
  assert.ok(fresh.packet.lessons.some(c => c.id === proposed.claim.id && c.reviewStatus === 'confirmed'));

  const rejectedRequest = envelope({ ...(await mutation()), candidate: { ...candidate, title: '被否决的经验候选' } });
  const rejectedProposal = await post('propose_lesson', rejectedRequest);
  assert.equal(rejectedProposal.claim.reviewStatus, 'pending');
  await review(rejectedProposal.claim.id, 'rejected');
  const beforeReplay = await state();
  assert.ok(!beforeReplay.pending.some(c => c.id === rejectedProposal.claim.id));
  assert.ok(!beforeReplay.lessons.some(c => c.id === rejectedProposal.claim.id));
  const history = await post('find_evidence', envelope({ query: '请求超时', limit: 100, includeHistory: true }));
  assert.equal(history.items.find(item => item.claim?.id === rejectedProposal.claim.id)?.claim.reviewStatus, 'rejected');

  assert.deepEqual(await post('propose_lesson', rejectedRequest), rejectedProposal);
  prepared.packet.goal = '客户端修改'; prepared.packet.evidence.length = 0;
  assert.deepEqual(await post('prepare_task', prepareRequest), immutablePrepared);
  assert.deepEqual(h.repository.read(h.auth, scope, 'context', immutablePrepared.packet.id), immutablePrepared.packet);
  assert.equal(h.repository.list(h.auth, scope, 'claim').find(c => c.id === rejectedProposal.claim.id).reviewStatus, 'rejected');
  assert.equal((await post('propose_lesson', { ...rejectedRequest, candidate: { ...rejectedRequest.candidate, body: '更改内容' } }, { status: 409 })).code, 'conflict');
  assert.equal((await post('propose_lesson', { ...rejectedRequest, requestId: randomUUID() }, { status: 409 })).code, 'stale_context');
  assert.equal((await post('prepare_task', { ...prepareRequest, requestId: randomUUID() }, { status: 409 })).code, 'stale_context');
  assert.deepEqual(await state(), beforeReplay);
  await capabilities();
});
