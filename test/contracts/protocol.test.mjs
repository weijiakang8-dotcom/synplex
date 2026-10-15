import test from 'node:test';
import assert from 'node:assert/strict';
import { schema, validateWire, validatePrepare, validateEvidence, validateUsage, sha256, payloadHash, PROTOCOL_VERSION } from '../../packages/contracts/validate.mjs';

const scope = { projectId: 'fixture-project', versionId: 'v2', branchId: null };
const prepare = () => ({ protocolVersion: PROTOCOL_VERSION, requestId: 'request-1', scope, expectedStateRevision: 3, goal: '保留失败记录，继续修复项目', constraints: ['不改活动Weave'], acceptanceCriteria: ['真实文件及业务检查均可核对'], mode: 'host_assist', executor: 'current_host', selectedOccurrenceIds: [], maxInputTokens: 8000 });
test('所有冻结定义可编译，悬空ref或未支持关键字不能混入协议', () => {
  for (const type of Object.keys(schema.$defs)) { try { validateWire(type, {}); } catch (e) { assert.equal(e.code, 'validation_failed', type); } }
});
test('长目标超过原型4000仍完整保留，超过明确限额则拒绝而不截断', () => {
  const input = { ...prepare(), goal: '甲'.repeat(5000) + '最后一条必须保留的约束' };
  assert.equal(validatePrepare(input).goal, input.goal);
  assert.throws(() => validatePrepare({ ...input, goal: '甲'.repeat(16001) }), { code: 'validation_failed' });
});
test('未知模式与宿主辅助嵌套外部执行被拒绝', () => {
  assert.throws(() => validatePrepare({ ...prepare(), mode: 'whatever' }), { code: 'validation_failed' });
  assert.throws(() => validatePrepare({ ...prepare(), executor: 'dsh' }), { code: 'validation_failed' });
  assert.equal(validatePrepare({ ...prepare(), mode: 'delegated', executor: 'dsh' }).executor, 'dsh');
  assert.throws(()=>validatePrepare({...prepare(),executionOptions:{model:'test',effort:'low'}}),{code:'capability_unavailable'});
});
test('请求不能自选owner或用confirmed/actorId绕过确认入口', () => {
  for (const field of ['ownerId', 'confirmed', 'actorId']) assert.throws(() => validatePrepare({ ...prepare(), [field]: field === 'confirmed' ? true : 'forged' }), { code: 'validation_failed' });
  assert.throws(() => validateWire('Scope', { projectId: 'fixture-project' }), { code: 'validation_failed' });
});
test('宿主费用未知必须显式null，准备阶段零费用与后续执行分开', () => {
  const usage = { observationScope: 'host_unavailable', provider: null, model: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, pricingRevision: null, provenance: 'unknown' };
  assert.equal(validateUsage(usage).costUsd, null);
  assert.throws(() => validateUsage({ ...usage, costUsd: 0 }), { code: 'validation_failed' });
  const missing = { ...usage }; delete missing.costUsd;
  assert.throws(() => validateWire('Usage', missing), { code: 'validation_failed' });
});
test('emoji引用使用UTF16单位，不能切开代理对或捏造引用', () => {
  const block = { id: 'b1', text: '前🧪后', rawStartByte: 0, rawEndByte: 10 };
  const span = { sourceId: 's1', parsedRevisionId: 'p1', occurrenceId: 'o1', blockId: 'b1', start: 1, end: 3, offsetUnit: 'utf16_code_unit', quote: '🧪', quoteHash: sha256(Buffer.from('🧪')) };
  assert.equal(validateEvidence(span, block).quote, '🧪');
  assert.throws(() => validateEvidence({ ...span, end: 2 }, block), { code: 'conflict' });
  assert.throws(() => validateEvidence({ ...span, quote: '通过' }, block), { code: 'conflict' });
});
test('同内容不等于同事件，改写事件内容必须改变服务计算的指纹', () => {
  const a = { eventId: 'e1', summary: '失败', checks: [] };
  assert.equal(payloadHash(a), payloadHash({ checks: [], summary: '失败', eventId: 'e1' }));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, eventId: 'e2' }));
  assert.notEqual(payloadHash(a), payloadHash({ ...a, summary: '成功' }));
});
test('执行成功但写回待补是有效状态，不等于可以重新执行', () => {
  const error = { code: 'writeback_pending', message: '工作已完成，记录待补。', nextAction: '只补写结果。', retry: 'writeback_only', operationId: 'op1' };
  const op = { id: 'op1', requestId: 'r1', status: 'succeeded', executionStatus: 'succeeded', writebackStatus: 'pending', resultId: 'result1', error };
  assert.equal(validateWire('Operation', op).error.retry, 'writeback_only');
});
