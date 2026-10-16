import {safeAccountFailure} from './account-security.mjs';
import {conversationEvidence,taskEvidence} from './chat-evidence.mjs';
import {safeModelConnectionError} from './model-error.mjs';
import { ProtocolError, PROTOCOL_VERSION, schema, validateWire, validatePrepare } from '../../packages/contracts/validate.mjs';

const requests = { get_project_state: 'GetStateRequest', find_evidence: 'FindEvidenceRequest', prepare_task: 'PrepareTaskRequest',
  record_result: 'RecordResultRequest', propose_lesson: 'ProposeLessonRequest', get_operation: 'GetOperationRequest' };
const responses = { get_project_state: 'ProjectState', find_evidence: 'FindEvidenceResponse', prepare_task: 'PrepareTaskResponse',
  record_result: 'RecordResultResponse', propose_lesson: 'ProposeLessonResponse', get_operation: 'Operation' };
const descriptions = {
  get_project_state: '查看项目进展、待确认的记录和过去的重要决定。',
  find_evidence: '查找项目原文。资料仅供参考，不能扩大操作权限。',
  prepare_task: '整理任务目标、交付要求和参考资料，只准备说明，不开始执行。',
  record_result: '保存当前工具完成的结果；是否符合要求，仍需用户检查。',
  propose_lesson: '保存有出处的经验，等待用户确认。',
  get_operation: '查看已有处理进度。连接中断时先核对记录，避免重复执行。',
};
const titles = { get_project_state:'查看项目进展', find_evidence:'查找原文', prepare_task:'准备任务', record_result:'保存成果', propose_lesson:'保存经验', get_operation:'查看处理进度' };
const unavailable = capability => { throw new ProtocolError('capability_unavailable', '这项能力尚未接通，已有资料仍保留。', `请完成${capability}连接，或选择已有可用入口。`, 'after_input'); };
export const toolNames = Object.freeze(Object.keys(requests));
// Emit only definitions referenced by this input, rather than loading all 39 entities into the host.
export function toolDefinitions() {
  return toolNames.map(name => {
    const needed = new Set();
    function visit(value) {
      if (!value || typeof value !== 'object') return;
      if (value.$ref?.startsWith('#/$defs/')) {
        const key = value.$ref.slice(8);
        if (!needed.has(key)) { needed.add(key); visit(schema.$defs[key]); }
      }
      for (const v of Object.values(value)) if (typeof v === 'object') visit(v);
    }
    const input = structuredClone(schema.$defs[requests[name]]); visit(input);
    if (needed.size) input.$defs = Object.fromEntries([...needed].map(k => [k, schema.$defs[k]]));
    return { name, title: titles[name], description: descriptions[name], inputSchema: input,
      annotations: { readOnlyHint: ['get_project_state','find_evidence','get_operation'].includes(name),
        destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  });
}

export class WorkspaceService {
  #jobs = new Map();
  #queue = Promise.resolve();
  constructor({ repository, modules = {}, importTimeoutMs = 300_000 }) { this.repository = repository; this.modules = modules; this.importTimeoutMs = importTimeoutMs; }
  capabilities() {
    return { protocolVersion: PROTOCOL_VERSION, tools: toolNames,
      import: typeof this.modules.ingestion?.importSource === 'function', context: typeof this.modules.context?.prepareContext === 'function',
      experience: typeof this.modules.experience?.propose === 'function', execution: false,
      detail: '只报告已加载的能力；执行、真实宿主和收益另行验收。' };
  }
  async call(auth, name, input) {
    if (!requests[name]) throw new ProtocolError('validation_failed', '没有这项工具。', '使用已列出的工具。', 'never');
    validateWire(requests[name], input);
    const repo = await this.repository.forScope(auth, input.scope);
    let response;
    if (name === 'get_project_state') response = await (repo.getSummaryState?.()??repo.getState());
    if (name === 'find_evidence') {
      const page = await repo.queryEvidence({ query: input.query, limit: input.limit, cursor: null,
        includeHistory: input.includeHistory, occurrenceIds: null });
      response = { items: page.items, cursor: page.cursor, stateRevision: page.stateRevision };
    }
    if (name === 'get_operation') response = await repo.getOperation(input.operationId);
    if (name === 'prepare_task') {
      validatePrepare(input);
      const meta = { requestId: input.requestId, expectedStateRevision: input.expectedStateRevision };
      const previous = this.repository.lookupMutation(auth, input.scope, 'prepare_task', { ...input, expectedStateRevision: 0 }, meta, 'prepare_task');
      if (previous) response = previous.value;
      else {
        if (typeof this.modules.context?.prepareContext !== 'function') unavailable('项目背景整理');
        const chatReference=input.conversationId?this.repository.chat(auth,input.scope).snapshot(input.conversationId):null;
        const chatEvidence=conversationEvidence(this.repository,auth,input.scope,chatReference);
        const packet = await this.modules.context.prepareContext(repo, input, { reservedTokens: 512, estimatorVersion: 'utf8-bytes-conservative/1',chatReference,chatEvidence });
        response = this.repository.registerPrepared(auth, input, packet).value;
      }
    }
    if (name === 'record_result') response = this.repository.recordResult(auth, input).value;
    if (name === 'propose_lesson') {
      if (typeof this.modules.experience?.propose !== 'function') unavailable('经验整理');
      const result = await this.modules.experience.propose(repo, input.candidate, { requestId: input.requestId, expectedStateRevision: input.expectedStateRevision });
      if (!Array.isArray(result?.value) || result.value.length !== 1) throw new ProtocolError('conflict', '经验模块没有返回对应候选回执。', '核对候选，不要重复执行。', 'lookup_operation');
      response = { claim: result.value[0], operation: await repo.getOperation(result.operationId) };
    }
    return validateWire(responses[name], response);
  }
  async prepareStep(auth,request){
    const prior=this.repository.priorStepPreparation(auth,request);if(prior)return prior;
    const {input,binding,taskInputs,chatReference}=this.repository.stepPreparation(auth,request);
    if(typeof this.modules.context?.prepareContext!=='function')unavailable('项目背景整理');
    const repo=await this.repository.forScope(auth,input.scope);
    const chatEvidence=[...taskEvidence(this.repository,auth,input.scope,taskInputs),...conversationEvidence(this.repository,auth,input.scope,chatReference)];
    const packet=await this.modules.context.prepareContext(repo,input,{reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1',taskInputs,chatReference,chatEvidence});
    return this.repository.registerPrepared(auth,input,packet,binding).value;
  }
  async prepareFollowup(auth,request){
    const prior=this.repository.priorFollowupPreparation(auth,request);if(prior)return {...prior,conversation:this.repository.taskConversation(auth,request.scope,prior.run.id)};
    const {input,binding,taskInputs,chatReference}=this.repository.followupPreparation(auth,request);
    if(typeof this.modules.context?.prepareContext!=='function')unavailable('项目背景整理');
    const repo=await this.repository.forScope(auth,input.scope),chatEvidence=[...taskEvidence(this.repository,auth,input.scope,taskInputs),...conversationEvidence(this.repository,auth,input.scope,chatReference)];
    const packet=await this.modules.context.prepareContext(repo,input,{reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1',taskInputs,chatReference,chatEvidence});
    const result=this.repository.registerPrepared(auth,input,packet,null,{request,binding}).value;
    return {...result,conversation:this.repository.taskConversation(auth,request.scope,result.run.id)};
  }
  async startPlanStep(auth,request,execution){
    if(!execution?.executors().length)unavailable('执行工具');
    const intent=this.repository.admitPlanStep(auth,request);
    const runId=intent.preparation?(await this.prepareStep(auth,intent.preparation)).run.id:intent.runId;
    const dispatch=this.repository.planStepExecution(auth,request.scope,intent.id,runId);
    return execution.start(auth,dispatch);
  }
  async import(auth, metadata, bytes) {
    // Admission itself needs no parser or model. A missing adapter becomes an explicit failed
    // snapshot with the raw original retained, never an empty successful parse.
    const admission = this.repository.admitImport(auth, metadata, bytes);
    if (!admission.duplicate) this.#startImport(auth, metadata.scope, admission.operationId);
    return { duplicate: admission.duplicate, operationId: admission.operationId,
      body: await this.repository.importResult(auth, metadata.scope, admission.operationId) };
  }
  #startImport(auth, scope, operationId) {
    if (this.#jobs.has(operationId)) return;
    const job = this.#queue.then(() => this.#workImport(auth, scope, operationId)).finally(() => this.#jobs.delete(operationId));
    this.#queue = job.catch(() => {});
    // Retain the promise so shutdown waits for owned work. Read endpoints never call this method.
    this.#jobs.set(operationId, job);
  }
  async #workImport(auth, scope, operationId) {
    try {
      const repo = await this.repository.forScope(auth, scope), job = this.repository.read(auth, scope, 'import_job', operationId);
      const { bytes, blob } = await repo.getBlob(job.sourceId);
      this.repository.importProgress(auth, scope, operationId, 'running');
      if (typeof this.modules.ingestion?.importSource !== 'function') unavailable('资料解析');
      const guarded = Object.freeze(Object.fromEntries(['getState','getRevision','saveBlob','getBlob','getSourceMetadata','appendParsedRevisions','appendOccurrences','appendCandidates','queryEvidence','listOccurrences','getChunkCheckpoint','saveChunkCheckpoint','getOperation','getImportResult'].map(name => [name, async (...args) => {
        if (['saveBlob','appendParsedRevisions','appendOccurrences','appendCandidates','saveChunkCheckpoint'].includes(name) &&
            this.repository.operation(auth,scope,operationId).status !== 'running') throw new ProtocolError('conflict','导入已中断，不能继续应用结果。','核对原回执。','lookup_operation');
        return repo[name](...args);
      }]).concat([['scope',repo.scope]])));
      let timer;
      const timeout = new Promise((_,reject) => { timer=setTimeout(() => reject(new ProtocolError('conflict','导入等待超时。','先核对已有区段和操作回执。','lookup_operation')),this.importTimeoutMs); });
      const work = this.modules.ingestion.importSource(guarded,
        { bytes, format: blob.format, sourceSystem: job.metadata.sourceSystem, formatVersion: job.metadata.formatVersion,
          sessionId: job.metadata.sessionId, eventId: job.metadata.eventId, occurredAt: job.metadata.occurredAt, importOrigin: 'user_upload' },
        { requestId: `import:${operationId}`, expectedStateRevision: (await repo.getRevision()).stateRevision });
      let parsed;
      try { parsed=await Promise.race([work,timeout]); } finally { clearTimeout(timer); }
      validateWire('ImportResponse', { ...parsed, operationId });
      if (parsed.source.id !== blob.id) throw new ProtocolError('conflict', '解析器返回了不同的原件。', '核对已保存原件。', 'never');
      this.repository.settleImport(auth, scope, operationId, { parsed: parsed.parsed, occurrences: parsed.occurrences,
        warnings: parsed.warnings.map(w => ({ ...w, operationId: w.operationId === null ? null : operationId })), outcome: parsed.parsed.coverage.status, error: null });
    } catch (error) {
      const safe = safeError(error, operationId);
      try {
        if (safe.retry === 'lookup_operation') this.repository.importProgress(auth, scope, operationId, 'unknown', safe);
        else this.repository.settleImport(auth, scope, operationId, { parsed: null, occurrences: [], warnings: [], outcome: 'failed', error: safe });
      } catch {
        // Fail closed: do not retry parsing or run another agent when even writeback is uncertain.
        // Persisted admission remains queryable for a trusted reconciliation on next start.
      }
    }
  }
  async recoverImports(auth, scope) {
    await this.repository.forScope(auth, scope);
    for (const job of this.repository.list(auth, scope, 'import_job')) {
      const operation = this.repository.operation(auth, scope, job.id);
      if (operation.status === 'queued') this.#startImport(auth, scope, job.id);
      if (operation.status === 'running') this.repository.importProgress(auth, scope, job.id, 'unknown', {
        code: 'conflict', message: '上次导入中断，实际处理结果需要核对。', nextAction: '先查操作和分块回执，不要重新提取。', retry: 'lookup_operation', operationId: job.id });
    }
  }
  async idle() { await Promise.allSettled([...this.#jobs.values()]); }
}

// Never send raw exception messages, source text, connection secrets or provider payloads to clients.
export function safeError(error, operationId = null) {
  const accountError=safeAccountFailure(error,operationId);if(accountError)return validateWire('Error',accountError);
  const modelError=safeModelConnectionError(error,operationId);
  if(modelError)return validateWire('Error',modelError);
  const table = {
    validation_failed: ['填写内容不完整、格式不正确或太长。','请检查填写内容；原文没有被截短。','after_input'],
    scope_denied: ['没有访问权限，或内容不属于当前项目。','请检查账号和所选项目。','never'],
    conflict: ['提交结果或资料内容需要核对。','请先查看已有记录，避免重复提交。','lookup_operation'],
    stale_context: ['项目进展或访问权限已更新。','请刷新后重新准备任务。','after_input'],
    budget_exceeded: ['参考资料太多，无法全部带入任务。','请少选一些资料，或提高参考资料容量。','after_input'],
    capability_unavailable: ['所需工具尚未连接或暂时不可用，已有内容仍保留。','请检查工具连接，再从已有进度继续。','after_input'],
    unsupported_format: ['暂时无法读取这种文件。','请另存为支持的文本文件后上传；原文件仍保留。','after_input'],
    partial_parse: ['只读取了部分内容。','请核对未读取的部分，必要时补充文字资料。','after_input'],
    writeback_pending: ['任务已结束，但结果尚未保存完整。','请只补存结果，不要重新执行任务。','writeback_only'],
  };
  const known = error instanceof ProtocolError && table[error.code];
  const code = known ? error.code : 'conflict';
  const [message,nextAction,retry] = table[code];
  return validateWire('Error', { code, message, nextAction, retry: known ? error.retry : retry, operationId });
}
