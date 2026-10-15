import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, payloadHash, sha256, validateWire } from '../../packages/contracts/validate.mjs';
import { readImportResult } from '../../packages/contracts/import-result.mjs';

const scope = { projectId: 'synthetic-project', versionId: 'v2', branchId: null };
const auth = () => ({ ownerId: 'owner-a', actorId: 'user-a', capabilities: new Set(['read_memory']), authorizedScope: scope });
const request = () => ({ protocolVersion: PROTOCOL_VERSION, scope, operationId: 'import-op' });
const error = code => ({ code, message: '合成夹具：资料尚未完整处理。', nextAction: '核对原件和处理范围。', retry: 'after_input', operationId: 'import-op' });
const bytes = Buffer.from('旧V1方案没有保留。🧪\n工具检查失败。');
function record(status = 'queued', outcome = 'complete') {
  const pending = ['queued', 'running', 'unknown'].includes(status);
  const source = { id: 'blob-1', sha256: sha256(bytes), byteLength: bytes.length, format: 'text/markdown', createdAt: '2026-10-13T12:00:00Z' };
  const coverageStatus = outcome === 'failed' || outcome === 'cancelled' ? 'partial' : outcome;
  const coveredBytes = coverageStatus === 'complete' ? bytes.length : 0;
  const parsed = { id: 'parsed-1', sourceId: source.id, parserVersion: 'synthetic/1', normalizedTextHash: sha256(bytes), blocks: coveredBytes ? [{ id: 'block-1', text: bytes.toString(), rawStartByte: 0, rawEndByte: bytes.length }] : [], coverage: { status: coverageStatus, coveredBytes, totalBytes: bytes.length, gaps: coveredBytes ? [] : [{ rawStartByte: 0, rawEndByte: bytes.length, reason: '合成未处理区段' }] }, recordedAt: '2026-10-13T12:00:00Z' };
  const warnings = outcome === 'partial' ? [error('partial_parse')] : outcome === 'unsupported' ? [error('unsupported_format')] : [];
  const operationError = status === 'unknown' ? { ...error('capability_unavailable'), retry: 'lookup_operation' } : outcome === 'failed' ? error('partial_parse') : null;
  const resultContent = { source, parsed: outcome === 'failed' || outcome === 'cancelled' ? null : parsed, occurrences: [], operationId: 'import-op', warnings, id: 'snapshot-1', outcome, error: outcome === 'failed' ? operationError : null, recordedAt: '2026-10-13T12:00:00Z' };
  const result = pending ? null : { ...resultContent, contentHash: payloadHash(resultContent) };
  const operation = { id: 'import-op', requestId: 'upload-request', status, executionStatus: 'not_started', writebackStatus: 'not_required', resultId: result?.id ?? null, error: operationError };
  return { ownerId: 'owner-a', scope, kind: 'import_source', operation, result };
}
const query = async (r, input = request(), principal = auth()) => readImportResult(principal, input, async () => r);
function reseal(r) { const { contentHash, ...content } = r.result; r.result.contentHash = payloadHash(content); return r; }

// Isolated contract HTTP harness with synthetic disk receipts; not the production service/repository.
async function serve(readRecord) {
  const server = http.createServer(async (req, res) => {
    let body;
    try {
      if (req.method !== 'POST' || req.url !== '/api/v1/get_import_result') { res.writeHead(404); return res.end(); }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString());
      const principal = req.headers.authorization === 'Bearer synthetic-owner-a' ? auth() : null;
      const reply = await readImportResult(principal, body, readRecord);
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body));
    } catch (e) {
      const reply = { code: e.code || 'validation_failed', message: e.code ? e.message : '请求格式不正确。', nextAction: e.nextAction || '检查请求。', retry: e.retry || 'after_input', operationId: e.operationId ?? null };
      validateWire('Error', reply);
      res.writeHead(e.httpStatus || 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply));
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}
const fetchResult = (base, input = request(), token = 'synthetic-owner-a') => fetch(base + '/api/v1/get_import_result', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(input) });

test('J2契约HTTP：queued→running→完成可取结果，重启后仍可读原件和终态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'synplex-import-contract-'));
  const receiptPath = join(dir, 'receipt.json'), sourcePath = join(dir, 'source.md');
  await writeFile(sourcePath, bytes); await writeFile(receiptPath, JSON.stringify(record()));
  const readRecord = async () => JSON.parse(await readFile(receiptPath, 'utf8'));
  let service = await serve(readRecord);
  try {
    for (const status of ['queued', 'running']) {
      await writeFile(receiptPath, JSON.stringify(record(status)));
      const response = await fetchResult(service.base);
      assert.equal(response.status, 202); assert.equal(response.headers.get('retry-after'), '2');
      const payload = await response.json(); assert.equal(payload.result, null); assert.equal(payload.operation.status, status);
    }
    await writeFile(receiptPath, JSON.stringify(record('succeeded')));
    const response = await fetchResult(service.base); assert.equal(response.status, 200);
    const payload = await response.json(); validateWire('ImportOperationResponse', payload);
    assert.equal(payload.operation.resultId, payload.result.id); assert.equal(payload.result.parsed.coverage.status, 'complete');
    assert.equal(payload.result.source.sha256, sha256(await readFile(sourcePath)));
    await service.close(); service = await serve(readRecord);
    assert.deepEqual(await (await fetchResult(service.base)).json(), payload);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});
test('partial与unsupported终态保留原件、解析覆盖缺口及警告', async () => {
  for (const [outcome, code] of [['partial', 'partial_parse'], ['unsupported', 'unsupported_format']]) {
    const reply = await query(record('succeeded', outcome));
    assert.equal(reply.status, 200); assert.equal(reply.body.result.source.sha256, sha256(bytes));
    assert.equal(reply.body.result.parsed.coverage.status, outcome); assert.equal(reply.body.result.parsed.coverage.gaps[0].rawEndByte, bytes.length);
    assert.equal(reply.body.result.warnings[0].code, code);
    assert.equal(reply.body.operation.executionStatus, 'not_started');
  }
});
test('导入失败或取消可取保留原件，没有解析版时明确null', async () => {
  for (const outcome of ['failed', 'cancelled']) {
    const reply = await query(record(outcome, outcome));
    assert.equal(reply.status, 200); assert.equal(reply.body.result.outcome, outcome);
    assert.equal(reply.body.result.parsed, null); assert.equal(reply.body.result.source.sha256, sha256(bytes));
    if (outcome === 'failed') assert.equal(reply.body.result.error.code, 'partial_parse');
  }
});
test('查询按认证owner及精确project/version/branch检查，null不是通配符', async () => {
  const r = record('succeeded');
  await assert.rejects(query(r, request(), { ...auth(), ownerId: 'owner-b' }), { code: 'scope_denied' });
  await assert.rejects(query(r, request(), { ...auth(), capabilities: new Set() }), { code: 'scope_denied' });
  for (const change of [{ projectId: 'other' }, { versionId: null }, { branchId: 'other' }]) {
    await assert.rejects(query(r, { ...request(), scope: { ...scope, ...change } }), { code: 'scope_denied' });
  }
  await assert.rejects(query(r, { ...request(), ownerId: 'owner-a' }), { code: 'validation_failed' });
});
test('重复读取无副作用，不增加revision或解析/提取次数，返回副本不能改旧快照', async () => {
  const r = record('succeeded'); const before = JSON.stringify(r);
  const counters = { stateRevision: 7, parseCalls: 1, extractionCalls: 0, readCalls: 0 };
  const reader = async () => { counters.readCalls++; return r; };
  for (let i = 0; i < 5; i++) {
    const response = await readImportResult(auth(), request(), reader);
    response.body.result.source.sha256 = '0'.repeat(64);
  }
  assert.equal(JSON.stringify(r), before);
  assert.deepEqual(counters, { stateRevision: 7, parseCalls: 1, extractionCalls: 0, readCalls: 5 });
});
test('结果指针、内容哈希或跨scope出处冲突被拒绝', async () => {
  const badPointer = record('succeeded'); badPointer.operation.resultId = 'another-result';
  await assert.rejects(query(badPointer), { code: 'conflict' });
  const badHash = record('succeeded'); badHash.result.source.byteLength++;
  await assert.rejects(query(badHash), { code: 'conflict' });
  const badSource = record('succeeded'); badSource.result.parsed.sourceId = 'other-source'; reseal(badSource);
  await assert.rejects(query(badSource), { code: 'conflict' });
  const crossScope = record('succeeded');
  crossScope.result.occurrences.push({ id: 'occurrence-1', sourceId: 'blob-1', parsedRevisionId: 'parsed-1', externalSystem: 'synthetic', formatVersion: 'fixture/1', sessionId: null, eventId: 'event-1', seq: null, importOrigin: 'isolated_test', occurredAt: null, recordedAt: '2026-10-13T12:00:00Z', scope: { ...scope, projectId: 'other' }, payloadHash: sha256(bytes) });
  reseal(crossScope); await assert.rejects(query(crossScope), { code: 'conflict' });
});
test('未知状态停止自动轮询并反馈核对条件，终态缺少结果不能冒充成功', async () => {
  const reply = await query(record('unknown'));
  assert.equal(reply.status, 200); assert.equal(reply.headers['Retry-After'], undefined);
  assert.equal(reply.body.result, null); assert.equal(reply.body.operation.error.retry, 'lookup_operation');
  const missing = record('succeeded'); missing.result = null;
  await assert.rejects(query(missing), { code: 'conflict' });
});
test('真实HTTP鉴权拒绝与恶意请求格式不泄漏原件，不触发读取', async () => {
  let reads = 0; const service = await serve(async () => { reads++; return record('succeeded'); });
  try {
    const denied = await fetchResult(service.base, request(), 'wrong-token'); assert.equal(denied.status, 403);
    const invalid = await fetchResult(service.base, { ...request(), confirmed: true }); assert.equal(invalid.status, 400);
    assert.equal(reads, 0); assert.ok(!JSON.stringify(await denied.json()).includes(bytes.toString()));
  } finally { await service.close(); }
});
