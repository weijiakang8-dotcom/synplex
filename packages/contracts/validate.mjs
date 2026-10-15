import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const PROTOCOL_VERSION = 'synplex.workspace/1.0.0';
export const schema = JSON.parse(readFileSync(new URL('./workspace.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema);
const validators = new Map();

export class ProtocolError extends Error {
  constructor(code, message, nextAction, retry = 'after_input') {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
    this.retry = retry;
    this.operationId = null;
  }
}

export function validateWire(type, value) {
  if (!Object.hasOwn(schema.$defs, type)) throw new TypeError('Unknown contract definition');
  if (!validators.has(type)) validators.set(type, ajv.compile({ $ref: `${schema.$id}#/$defs/${type}` }));
  const check = validators.get(type);
  if (!check(value)) throw new ProtocolError('validation_failed', '内容格式或长度不符合要求，原内容没有被截断。', '请检查缺失字段、模式和长度。');
  return value;
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// Called only after schema validation on JSON values; array order remains significant.
export const payloadHash = value => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));

export function validateUsage(usage) {
  validateWire('Usage', usage);
  if ((usage.provenance === 'unknown' && usage.costUsd !== null) || (usage.provenance === 'no_model_call' && (usage.costUsd !== 0 || usage.inputTokens !== 0 || usage.outputTokens !== 0 || usage.cachedInputTokens !== 0))) {
    throw new ProtocolError('validation_failed', '未知费用不能填零，没有调用则需明确记录零用量。', '按实际观测范围补充用量。');
  }
  return usage;
}

export function validatePrepare(input) {
  validateWire('PrepareTaskRequest', input);
  const valid = { host_assist: ['current_host'], platform_owned: ['synplex'], delegated: ['codex', 'dsh'] };
  if (!input.goal.trim() || !valid[input.mode].includes(input.executor) || input.constraints.some(x => !x.trim()) || input.acceptanceCriteria.some(x => !x.trim())) {
    throw new ProtocolError('validation_failed', '请补充目标和验收要求，并选择可用的执行方式。', '当前工具继续、平台执行和外部委托应分别选择。');
  }
  if(input.mode==='host_assist'&&input.executionOptions)throw new ProtocolError('capability_unavailable','当前工具的型号请在工具自身选择。','此处只准备工作说明，不更改你正在使用的工具设置。');
  return input;
}

function cutsSurrogate(text, offset) {
  if (offset === 0 || offset === text.length) return false;
  const a = text.charCodeAt(offset - 1), b = text.charCodeAt(offset);
  return a >= 0xD800 && a <= 0xDBFF && b >= 0xDC00 && b <= 0xDFFF;
}
export function validateEvidence(span, block) {
  validateWire('EvidenceSpan', span);
  validateWire('Block', block);
  if (span.blockId !== block.id || span.start > span.end || span.end > block.text.length || cutsSurrogate(block.text, span.start) || cutsSurrogate(block.text, span.end) || block.text.slice(span.start, span.end) !== span.quote || sha256(Buffer.from(span.quote, 'utf8')) !== span.quoteHash) {
    throw new ProtocolError('conflict', '引用与保存的原文不一致。', '重新定位原文，保留冲突记录。');
  }
  return span;
}
