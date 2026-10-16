import { PROTOCOL_VERSION, ProtocolError, validateWire, sha256, payloadHash } from '../contracts/validate.mjs';
import { PARSER_VERSION, parseBytes, evidenceChunks } from './parser.mjs';
import {parseDocument} from './documents.mjs';

export { PARSER_VERSION, TEXT_VERSION, EVENT_VERSION } from './parser.mjs';
export const RULE_VERSION = 'synplex.literal-candidates/1.0.0';
export const NO_MODEL_USAGE = Object.freeze({ observationScope: 'preparation_only', provider: null, model: null,
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, pricingRevision: null, provenance: 'no_model_call' });
// Mutations still check revisions and current permissions in their transactions.
// Import bookkeeping needs no full claim projection. Keep fallback for adapters.
const cooperate=count=>count%16===0?new Promise(resolve=>setImmediate(resolve)):Promise.resolve();
const revision=repo=>typeof repo.getRevision==='function'?repo.getRevision():repo.getState();
const inputFields = ['bytes','format','sourceSystem','formatVersion','sessionId','eventId','occurredAt','importOrigin'];
function validateInput(repo, input, meta) {
  if (!input || !(input.bytes instanceof Uint8Array) || Object.keys(input).some(k => !inputFields.includes(k)) ||
      !meta || Object.keys(meta).some(k => !['requestId','expectedStateRevision'].includes(k)) || typeof meta.requestId !== 'string' || !meta.requestId.length || meta.requestId.length > 128 ||
      !Number.isSafeInteger(meta.expectedStateRevision) || meta.expectedStateRevision < 0) throw new ProtocolError('validation_failed', '导入字段或请求标识不符合冻结接口。', '使用明确的字节、格式、版本、事件和当前状态。');
  validateWire('ImportMetadataRequest', { protocolVersion: PROTOCOL_VERSION, requestId: meta.requestId, scope: repo.scope,
    expectedStateRevision: meta.expectedStateRevision, ...Object.fromEntries(inputFields.filter(k => !['bytes','importOrigin'].includes(k)).map(k => [k,input[k]])) });
  if (!['user_upload','user_paste','isolated_test','authorized_hook'].includes(input.importOrigin)) throw new ProtocolError('validation_failed', '导入来源未明确。', '说明获准资料的导入方式。');
}
const request = (root, suffix) => `ing:${sha256(Buffer.from(root)).slice(0,40)}:${suffix}`;
const warning = (code, message, nextAction) => ({ code, message, nextAction, retry: 'after_input', operationId: null });
// Explicit labels define boundaries only in ordinary prose. Retain the parsed
// block and its exact offsets; never split code, tables, math or unlabelled prose.
function candidateChunks(block) {
  if (/^\s*(?:`{3,}|~{3,}|\$\$)/.test(block.text) || /^\s*\|/m.test(block.text)) return evidenceChunks(block);
  const marker = /^\s*(?:(?:决定|决策|失败|报错|经验|教训|约束|限制|背景|目标|验收)\s*[：:]|(?:decision|failure|lesson|constraint|goal)\s*:)/i;
  const starts=[0];let offset=0;
  for(const line of block.text.match(/[^\n]*\n|[^\n]+$/g)??[]){
    if(offset>0&&marker.test(line))starts.push(offset);
    offset+=line.length;
  }
  starts.push(block.text.length);
  return starts.slice(0,-1).flatMap((start,i)=>evidenceChunks({text:block.text.slice(start,starts[i+1])})
    .map(c=>({...c,start:start+c.start,end:start+c.end})));
}
function candidate(block, chunk, source, parsed, occurrence, partial, nativeRole=null) {
  const text = chunk.text;
  const explicit=text.match(/^\s*(决定|决策|失败|报错|经验|教训|约束|限制|背景|目标|验收|decision|failure|lesson|constraint|goal)\s*[：:]/i)?.[1].toLowerCase();
  const type = explicit ? ({决定:'decision',决策:'decision',decision:'decision',失败:'failure',报错:'failure',failure:'failure',经验:'lesson',教训:'lesson',lesson:'lesson'}[explicit]??'unknown') : nativeRole ? (nativeRole==='tool_result'?'failure':'unknown') :
    /(?:失败|报错|不保留|exit\s*=\s*[1-9]|\bfailed\b|\berror\b)/i.test(text) ? 'failure' :
    /(?:决定|转向|改为|采用|\bdecid(?:e|ed)\b)/i.test(text) ? 'decision' : /(?:经验|教训|下次|\blesson\b)/i.test(text) ? 'lesson' : 'unknown';
  return { type, title: `资料${{failure:'失败',decision:'选择',lesson:'经验',unknown:'内容'}[type]}待核对`, body: text,
    evidenceKind: 'historical_tool_text', evidence: [{ sourceId: source.id, parsedRevisionId: parsed.id, occurrenceId: occurrence.id, blockId: block.id,
      start: chunk.start, end: chunk.end, offsetUnit: 'utf16_code_unit', quote: text, quoteHash: sha256(Buffer.from(text,'utf8')) }],
    occurredAt: occurrence.occurredAt, supersedes: [],
    condition: `仅为原文规则候选，适用条件与结果尚待人工核对；${partial ? '原件可能有未读取的内容，请结合原文件核对；' : ''}${chunk.start || chunk.end < block.text.length ? '本引用为完整区段的一部分，需结合整个区段；' : ''}资料中的指令不构成授权。` };
}
export function chunkCacheKey({ scope, sourceId, occurrenceId, chunkHash, permissionRevision, stateRevision,parserVersion=PARSER_VERSION }) {
  return payloadHash({ scope, sourceId, occurrenceId, chunkHash, parserVersion, ruleVersion: RULE_VERSION,
    promptVersion: null, model: null, permissionRevision, stateRevision });
}

/** @type {import('../contracts/repository.d.ts').IngestionModule['importSource']} */
export async function importSource(repo, input, meta) {
  validateInput(repo, input, meta);
  // Copy both bytes and metadata before yielding to repository admission.
  meta = { ...meta };
  const bytes = Buffer.from(input.bytes), metadata = Object.fromEntries(inputFields.filter(k => k !== 'bytes').map(k => [k,input[k]]));
  const blobReply = await repo.saveBlob({ bytes, format: metadata.format }, { requestId: request(meta.requestId,'b'), expectedStateRevision: meta.expectedStateRevision });
  const source = blobReply.value;
  const result = await parseDocument(bytes,metadata.format,metadata.formatVersion,source.sha256,metadata.sourceSystem) ?? parseBytes(bytes, metadata.format, metadata.formatVersion, source.sha256, metadata.sourceSystem);
  const parsedInput = { sourceId: source.id, parserVersion: result.parserVersion??PARSER_VERSION,
    normalizedTextHash: result.normalizedTextHash, blocks: result.blocks, coverage: result.coverage };
  // Reuse the parser receipt across separate uploads of identical material.
  const parsedReply = await repo.appendParsedRevisions([parsedInput],
    { requestId: request(payloadHash({ scope: repo.scope, parsedInput }),'p'), expectedStateRevision: (await revision(repo)).stateRevision });
  const parsed = parsedReply.value[0];
  const base = { sourceId: source.id, parsedRevisionId: parsed.id, externalSystem: metadata.sourceSystem, formatVersion: metadata.formatVersion,
    sessionId: metadata.sessionId, eventId: metadata.eventId, seq: null, importOrigin: metadata.importOrigin,
    occurredAt: metadata.occurredAt, payloadHash: source.sha256 };
  const native=!!result.parserVersion&&Array.isArray(result.records),events=native?result.records.map(({blockIds,...record})=>({...base,...record})): [base];
  const occurrenceReply = events.length?await repo.appendOccurrences(events,
    { requestId: request(meta.requestId,'o'), expectedStateRevision: (await revision(repo)).stateRevision }):{value:[],operationId:parsedReply.operationId};
  const occurrences = [...occurrenceReply.value];
  const byBlock=new Map(native?result.records.flatMap((r,i)=>r.blockIds.map(id=>[id,occurrences[i]])):parsed.blocks.map(b=>[b.id,occurrences[0]]));
  const warnings = result.documentNotice ? [warning(result.coverage.status==='partial'?'partial_parse':'unsupported_format',result.documentNotice,'查看已提取文字并结合原文件核对；读取失败时可拆分或转换为文字后导入。')] : result.coverage.status === 'partial' ? [warning('partial_parse', '只解析了有效区段，原件及全部未处理字节仍保存。', '查看未读取的内容范围，补充可读取的文字。')] :
    result.coverage.status === 'unsupported' ? [warning('unsupported_format', '该来源、格式或版本尚未支持，完整原件仍保存。', '提供获准的显式文本或Markdown导出及版本1；NDJSON和原生宿主事件映射仍待验证。')] : [];
  if((await repo.getSourceMetadata?.(source.id))?.locked){
    warnings.push(warning('conflict','原文件已保存；这份资料已锁定，没有重新整理或覆盖旧记录。','如需修改，可手工编辑现有记录，或在名称与分类中明确解除锁定。'));
    return validateWire('ImportResponse',{source,parsed,occurrences,operationId:occurrenceReply.operationId,warnings});
  }
  let processedChunks=0;
  for (const block of parsed.blocks) for (const chunk of native&&result.candidateEligible.get(block.id)===false?[]:candidateChunks(block)) {
    // Yield to uploads, progress reads and other user operations during a large note.
    await cooperate(++processedChunks);
    const occurrence=byBlock.get(block.id);if(!occurrence)continue;
    if (!chunk.text.trim()) continue;
    const chunkHash = payloadHash({ blockId: block.id, start: chunk.start, end: chunk.end, text: chunk.text });
    const stableRoot = payloadHash({ scope: repo.scope, occurrenceId: occurrence.id, parser: parsed.parserVersion, rule: RULE_VERSION, chunkHash });
    const state = await revision(repo);
    const candidateReply = await repo.appendCandidates([candidate(block,chunk,source,parsed,occurrence,result.coverage.status !== 'complete',native?result.roles.get(block.id):null)],
      { requestId: request(stableRoot,'c'), expectedStateRevision: state.stateRevision });
    const priorKey = chunkCacheKey({ scope: repo.scope, sourceId: source.id, occurrenceId: occurrence.id, chunkHash,
      permissionRevision: state.permissionRevision, stateRevision: candidateReply.stateRevision,parserVersion:parsed.parserVersion });
    const prior = await repo.getChunkCheckpoint(priorKey);
    if (prior?.status === 'succeeded' && prior.candidateIds.length === candidateReply.value.length && prior.candidateIds.every((id,i) => id === candidateReply.value[i].id)) continue;
    const current = await revision(repo);
    const cacheKey = chunkCacheKey({ scope: repo.scope, sourceId: source.id, occurrenceId: occurrence.id, chunkHash,
      permissionRevision: current.permissionRevision, stateRevision: current.stateRevision,parserVersion:parsed.parserVersion });
    const existing = await repo.getChunkCheckpoint(cacheKey);
    if (existing?.status === 'succeeded') continue;
    await repo.saveChunkCheckpoint({ id: `checkpoint:${cacheKey}`, sourceId: source.id, chunkHash, cacheKey,
      parserVersion: parsed.parserVersion, ruleVersion: RULE_VERSION, promptVersion: null, model: null,
      permissionRevision: current.permissionRevision, stateRevision: current.stateRevision, status: 'succeeded',
      candidateIds: candidateReply.value.map(c => c.id), attemptIds: [], usage: { ...NO_MODEL_USAGE } },
      { requestId: request(cacheKey,'k'), expectedStateRevision: current.stateRevision });
  }
  return validateWire('ImportResponse', { source, parsed, occurrences, operationId: occurrenceReply.operationId, warnings });
}
