import {AccountStore} from './account-store.mjs';
import {accountKey} from './account-mail.mjs';
import {OBSIDIAN_SOURCE,readNoteIdentity} from '../../public/obsidian-notes.js';
import {frozenCallAccounting} from './model-pricing.mjs';
import {ModelRelayStore} from './model-relay-store.mjs';
import {ModelRelay} from './model-relay.mjs';
import {ChatStore,scopedChat} from './chat-store.mjs';
import {ModelVault} from './model-vault.mjs';
import {ModelService} from './model-service.mjs';
import {followupRequest,followupHistory,followupInput} from './task-followup.mjs';
import {validateResultAdoption,resultAdoption} from './result-adoption.mjs';
import {readExecutionStatus,prepareExecutionStatus} from './execution-status.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ProtocolError, PROTOCOL_VERSION, validateWire, validateEvidence, validateUsage, validatePrepare, sha256, payloadHash,
} from '../../packages/contracts/validate.mjs';
import { readImportResult } from '../../packages/contracts/import-result.mjs';
import { validateExecutionRequest } from './execution-input.mjs';
import { parseCodexSession,CODEX_SESSION_PARSER,CODEX_SESSION_VERSION } from '../../packages/ingestion/codex-session.mjs';
import {validateQuestion,validateAnswers} from './execution-question.mjs';
import {usageLedger,validatePrice} from '../../packages/execution/accounting.mjs';
import {validateLimits,budgetProjection,requireBudget} from '../../packages/execution/budget.mjs';
import {SOURCE_FORMATS,sourceExtension} from '../../public/document-formats.js';
import {SearchIndex} from './search-index.mjs';
import {validateTaskPlan,projectTaskPlan,requireReadyStep,startableTaskSteps} from '../../packages/execution/task-plan.mjs';
import {compareTaskRoutes,planRouteFingerprint} from '../../packages/execution/task-routes.mjs';
import {sourceMetadata as validateSourceMetadata,claimDraft,claimVersions,claimDifference} from './authoring.mjs';
import {MemoryProjection} from './memory-projection.mjs';
import {recordJourney} from './record-journey.mjs';
import {projectExpression,renderExpressionHtml,validExpressionInput} from './project-expression.mjs';
import {validateExpressionVersion,expressionSummary,requireExpressionBytes} from './expression-versions.mjs';
import {ACTIVITY_LABELS,activitySource} from '../../packages/execution/activity.mjs';
import {sourcePreviewHeader,sourcePreviewPage,verifyPreviewSource} from './source-preview.mjs';

const now = () => new Date().toISOString();
const clone = x => structuredClone(x);
const sameScope = (a, b) => payloadHash(a) === payloadHash(b);
const unknownUsage = () => ({ observationScope: 'host_unavailable', provider: null, model: null,
  inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, pricingRevision: null, provenance: 'unknown' });
const noUsage = () => ({ ...unknownUsage(), observationScope: 'preparation_only',
  inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, provenance: 'no_model_call' });
const fail = (code, message, nextAction, retry = 'after_input') => { throw new ProtocolError(code, message, nextAction, retry); };
const denied = () => fail('scope_denied', '没有这项操作的权限或资料不在当前项目。', '使用获准的账号和项目范围。', 'never');
const requestMeta=request=>({requestId:request.requestId,expectedStateRevision:request.expectedStateRevision});
function checkMeta(meta) {
  if (!meta || typeof meta.requestId !== 'string' || !meta.requestId.length || meta.requestId.length > 128 ||
      !Number.isSafeInteger(meta.expectedStateRevision) || meta.expectedStateRevision < 0 ||
      Object.keys(meta).some(k => !['requestId', 'expectedStateRevision'].includes(k))) {
    fail('validation_failed', '请求标识或版本不符合要求。', '保留原请求标识并提供当前版本。');
  }
}

// One SQLite writer. Raw bytes and their admission receipt commit together, with no orphan cleanup.
// Only the trusted service can mint credentials; no HTTP or MCP operation exposes this method.
export class WorkspaceRepository {
  #db;
  #chatStore;
  #accounts;
  #dataDir;
  #modelVault;
  #modelService;
  #relayStore;
  #auth = new WeakMap();
  #prices=[];
  #limits=null;
  #search;
  #memory;
  constructor({ dataDir, fault = null, executionLimits, modelTransport }) {
    if (!dataDir) throw new TypeError('An isolated dataDir is required');
    const dir = resolve(dataDir);this.#dataDir=dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink()) throw new TypeError('Data directory cannot be a symbolic link');
    chmodSync(dir, 0o700);
    const path = join(dir, 'workspace.sqlite');
    try { if (lstatSync(path).isSymbolicLink()) throw new TypeError('Database cannot be a symbolic link'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.#db.exec(readFileSync(new URL('../../migrations/001-workspace.sql', import.meta.url), 'utf8'));
    this.#db.prepare('INSERT OR IGNORE INTO schema_versions VALUES (?,?)').run(1, now());
    prepareExecutionStatus(this.#db);
    try{this.#search=new SearchIndex(this.#db);this.#memory=new MemoryProjection(this.#db);}catch(error){this.#db.close();throw error;}
    this.#chatStore=new ChatStore(this.#db);
    this.#chatStore.interrupt();
    this.#modelVault=new ModelVault(this.#db,dir);
    this.#modelService=new ModelService(this,this.#db,{transport:modelTransport});
    this.#relayStore=new ModelRelayStore(this.#db,dir);this.#relayStore.interrupt();
    this.fault = fault;
    const priceFile=join(dir,'prices.json');
    try{
      const stat=lstatSync(priceFile);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('Prices must be an owner-only regular file');
      const values=JSON.parse(readFileSync(priceFile,'utf8'));
      if(!Array.isArray(values)||values.length>1000)throw new Error('Invalid configured price versions');
      this.#prices=values.map(validatePrice);
    }catch(error){if(error.code!=='ENOENT'){this.#db.close();throw error;}}
    try{
      if(executionLimits!==undefined)this.#limits=executionLimits===null?null:validateLimits(executionLimits);
      else{
        const file=join(dir,'execution-limits.json'),stat=lstatSync(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('Execution limits must be private');
        this.#limits=validateLimits(JSON.parse(readFileSync(file,'utf8')));
      }
    }catch(error){if(error.code!=='ENOENT'){this.#db.close();throw error;}}
  }
  accounts(options={}) {return this.#accounts??=new AccountStore(this.#db,{codeKey:()=>accountKey(this.#dataDir),...options});}
  close() { this.#db.close(); }
  #partition(ownerId, scope) { return payloadHash({ ownerId, scope }); }
  #row(partition) { return this.#db.prepare('SELECT * FROM scopes WHERE partition=?').get(partition); }
  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try { this.#search?.ensureCurrent(); const out = fn(); this.#search?.checkpoint(); this.#db.exec('COMMIT'); return out; }
    catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #put(partition, kind, value, identity = null) {
    this.#db.prepare('INSERT INTO records(partition,kind,id,identity_key,payload_hash,body_json) VALUES (?,?,?,?,?,?)')
      .run(partition, kind, value.id, identity, payloadHash(value), JSON.stringify(value));
    this.#search?.record(partition,kind,value);
  }
  #get(partition, kind, id) {
    const row = this.#db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? AND id=?').get(partition, kind, id);
    return row ? JSON.parse(row.body_json) : null;
  }
  #list(partition, kind) {
    return this.#db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? ORDER BY rowid').all(partition, kind)
      .map(r => JSON.parse(r.body_json));
  }
  #replace(partition, kind, value) {
    const changed = this.#db.prepare('UPDATE records SET body_json=?,payload_hash=? WHERE partition=? AND kind=? AND id=?')
      .run(JSON.stringify(value), payloadHash(value), partition, kind, value.id).changes;
    if (!changed) denied();
    this.#search?.record(partition,kind,value);
  }
  #identity(partition, kind, identity) {
    const row = this.#db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? AND identity_key=?').get(partition, kind, identity);
    return row ? JSON.parse(row.body_json) : null;
  }
  #currentAuth(auth, scope, capability) {
    const id = this.#auth.get(auth);
    if (!id) denied();
    const row = this.#db.prepare('SELECT c.*,s.owner_id,s.scope_json,s.permission_revision AS current_revision FROM credentials c JOIN scopes s USING(partition) WHERE c.id=?').get(id);
    if (!row || row.revoked || row.permission_revision !== row.current_revision ||
        !sameScope(JSON.parse(row.scope_json), scope) || !JSON.parse(row.capabilities_json).includes(capability)) denied();
    return { partition: row.partition, ownerId: row.owner_id, actorId: row.actor_id, kind: row.kind,
      permissionRevision: row.current_revision, capabilities: new Set(JSON.parse(row.capabilities_json)) };
  }
  createCredential({ ownerId, actorId, scope, capabilities, kind = 'agent' }) {
    validateWire('Scope', scope);
    const supported = new Set(['read_memory','write_memory','prepare_task','record_result','review_memory','execute','trusted_evidence']);
    if (!ownerId || !actorId || !Array.isArray(capabilities) || capabilities.some(c => !supported.has(c)) ||
        !['ui','agent','worker'].includes(kind) || (kind !== 'ui' && capabilities.includes('review_memory'))) throw new TypeError('Invalid trusted credential specification');
    const partition = this.#partition(ownerId, scope), token = randomBytes(32).toString('base64url'), id = randomUUID();
    this.#transaction(() => {
      this.#db.prepare('INSERT OR IGNORE INTO scopes(partition,owner_id,scope_json) VALUES (?,?,?)').run(partition, ownerId, JSON.stringify(scope));
      this.#db.prepare('INSERT INTO credentials(id,token_hash,partition,actor_id,kind,capabilities_json,permission_revision) VALUES (?,?,?,?,?,?,?)')
        .run(id, sha256(Buffer.from(token)), partition, actorId, kind, JSON.stringify([...new Set(capabilities)]), this.#row(partition).permission_revision);
    });
    return { id, token };
  }
  authenticate(token) {
    if (typeof token !== 'string' || token.length > 256) denied();
    const row = this.#db.prepare('SELECT c.*,s.owner_id,s.scope_json,s.permission_revision AS current_revision FROM credentials c JOIN scopes s USING(partition) WHERE token_hash=?')
      .get(sha256(Buffer.from(token)));
    return this.#credentialAuth(row);
  }
  #credentialAuth(row){
    if (!row || row.revoked || row.permission_revision !== row.current_revision) denied();
    const auth = Object.freeze({ ownerId: row.owner_id, actorId: row.actor_id,
      permissionRevision: row.current_revision, authorizedScope: Object.freeze(JSON.parse(row.scope_json)),
      kind: row.kind, capabilities: new Set(JSON.parse(row.capabilities_json)) });
    this.#auth.set(auth, row.id);
    return auth;
  }
  modelRelay(options={}){return new ModelRelay({repository:this,store:this.#relayStore,...options});}
  executionModelAccess(auth,scope){
    this.#currentAuth(auth,scope,'execute');if(auth.kind!=='ui')denied();
    return {credentialId:this.#auth.get(auth),models:this.models(auth,scope)};
  }
  resumeExecutionModelAccess(credentialId,scope){
    const row=this.#db.prepare('SELECT c.*,s.owner_id,s.scope_json,s.permission_revision AS current_revision FROM credentials c JOIN scopes s USING(partition) WHERE c.id=?').get(credentialId);
    const auth=this.#credentialAuth(row);return {auth,...this.executionModelAccess(auth,scope)};
  }
  checkExecutionModelOwner(auth,scope,credentialId){
    const current=this.#currentAuth(auth,scope,'execute');if(current.kind!=='ui')denied();
    const row=this.#db.prepare('SELECT c.actor_id,c.partition,s.owner_id FROM credentials c JOIN scopes s USING(partition) WHERE c.id=?').get(credentialId);
    if(!row||row.partition!==current.partition||row.owner_id!==current.ownerId||row.actor_id!==current.actorId)denied();
  }
  chat(auth,scope){
    const check=(capability='read_memory')=>{const t=this.#currentAuth(auth,scope,capability);if(t.kind!=='ui')denied();return t;};
    check();
    return scopedChat(this.#chatStore,{check,release:id=>this.#modelVault.release(auth,id),verifyBackground:background=>{
      const state=this.state(auth,scope);
      if(state.stateRevision!==background.stateRevision||state.permissionRevision!==background.permissionRevision)fail('stale_context','参考资料已经变化，本次还没有发送给模型。','查看最新资料后重新准备。');
    }});
  }
  configureBuiltinOwner(ownerId){this.#modelVault.configureBuiltinOwner(ownerId);}
  models(auth,scope){
    this.#currentAuth(auth,scope,'review_memory');
    if(auth.kind!=='ui')denied();
    const vault=this.#modelVault;
    const check=()=>this.#currentAuth(auth,scope,'review_memory');
    return {
      list(){check();return vault.list(auth);},
      save(input,admin=false){check();return vault.save(auth,input,admin);},
      change(input,admin=false){check();return vault.change(auth,input,admin);},
      acquire(selection,id,options){check();return vault.acquire(auth,selection,id,options);},
      release(id){check();return vault.release(auth,id);},
    };
  }
  async modelOperation(auth,input,action,options){return this.#modelService.call(auth,input,action,options);}
  revokeCredential(id) {
    this.#transaction(() => {
      const row = this.#db.prepare('SELECT partition FROM credentials WHERE id=?').get(id);
      if (!row) return;
      this.#db.prepare('UPDATE credentials SET revoked=1 WHERE id=?').run(id);
      // All existing frozen packets become unusable, and old scoped objects are checked on every call.
      this.#db.prepare('UPDATE scopes SET permission_revision=permission_revision+1 WHERE partition=?').run(row.partition);
    });
  }
  async forScope(auth, scope) {
    validateWire('Scope', scope);
    this.#currentAuth(auth, scope, 'read_memory');
    return new ScopedRepository(this, auth, clone(scope));
  }
  read(auth, scope, kind, id, capability = 'read_memory') {
    const { partition } = this.#currentAuth(auth, scope, capability);
    return this.#get(partition, kind, id);
  }
  list(auth, scope, kind, capability = 'read_memory') {
    const { partition } = this.#currentAuth(auth, scope, capability);
    return this.#list(partition, kind);
  }
  recent(auth,scope,kind,limit=200) {
    const {partition}=this.#currentAuth(auth,scope,'read_memory');
    if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw new TypeError('Invalid recent record limit');
    return this.#db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? ORDER BY rowid DESC LIMIT ?').all(partition,kind,limit).reverse().map(row=>JSON.parse(row.body_json));
  }
  recordCount(auth,scope,kind) {
    const {partition}=this.#currentAuth(auth,scope,'read_memory');
    return this.#db.prepare('SELECT count(*) AS total FROM records WHERE partition=? AND kind=?').get(partition,kind).total;
  }
  sourcePreview(auth,scope,sourceId,{cursor=null,summaryOnly=false}={}) {
    const t=this.#currentAuth(auth,scope,'read_memory'),source=this.#get(t.partition,'source',sourceId);if(!source)denied();
    verifyPreviewSource(this.#db,t.ownerId,source);
    const header=sourcePreviewHeader(this.#db,t.partition,sourceId);
    const queryHash=payloadHash({purpose:'source-preview/1',sourceId,parsedId:header.parsed?.id??null,permissionRevision:t.permissionRevision});
    const offset=this.#decodeCursor(cursor,t.partition,queryHash),page=!summaryOnly&&header.parsed?sourcePreviewPage(this.#db,t.partition,header.parsed.id,offset):null;
    return {source,...header,parsed:header.parsed?{...header.parsed,blocks:page?.blocks??[]}:null,metadata:this.sourceMetadata(auth,scope,sourceId),
      page:{displayOnly:true,summaryOnly,displayBytes:page?.displayBytes??0,cursor:page?.more?this.#encodeCursor(t.partition,queryHash,page.nextOffset):null}};
  }
  sourceBrief(auth,scope,sourceId){
    return this.#transaction(()=>{
      const t=this.#currentAuth(auth,scope,'read_memory'),source=this.#get(t.partition,'source',sourceId);if(!source)denied();
      return this.#memory.source({...t,source,metadata:this.sourceMetadata(auth,scope,sourceId),claimRows:this.#search.sourceClaims(t.partition,sourceId)});
    });
  }
  sourceCoverage(auth,scope,sourceIds) {
    const {partition}=this.#currentAuth(auth,scope,'read_memory');
    if(!Array.isArray(sourceIds)||sourceIds.length>200)throw new TypeError('Invalid bounded source projection');
    return this.#db.prepare(`SELECT json_extract(body_json,'$.sourceId') AS sourceId,json_extract(body_json,'$.parserVersion') AS parserVersion,
      json_extract(body_json,'$.coverage.status') AS status,json_array_length(body_json,'$.coverage.gaps') AS gapCount,json_array_length(body_json,'$.blocks') AS blockCount
      FROM records WHERE partition=? AND kind='parsed' AND json_extract(body_json,'$.sourceId') IN (SELECT value FROM json_each(?)) ORDER BY rowid`).all(partition,JSON.stringify(sourceIds));
  }
  #modelCallCosts(partition){
    const grouped=Map.groupBy(this.#relayStore.accounting(partition),c=>c.attemptId);
    return Object.fromEntries([...grouped].map(([id,calls])=>[id,frozenCallAccounting(calls)]));
  }
  usageLedger(auth,scope){
    const {partition}=this.#currentAuth(auth,scope,'read_memory');
    return usageLedger({attempts:this.#list(partition,'attempt'),results:this.#list(partition,'result'),
      reconciliations:this.#list(partition,'usage_reconciliation'),prices:this.#prices,modelCallCosts:this.#modelCallCosts(partition)});
  }
  #budget(ownerId,claimingId=null){
    if(!this.#limits)return null;
    const partitions=this.#db.prepare('SELECT partition FROM scopes WHERE owner_id=?').all(ownerId).map(s=>s.partition);
    const holds=[],rows=[];
    for(const p of partitions){
      rows.push(...usageLedger({attempts:this.#list(p,'attempt'),results:this.#list(p,'result'),reconciliations:this.#list(p,'usage_reconciliation'),prices:this.#prices,modelCallCosts:this.#modelCallCosts(p)}).rows);
      for(const h of this.#list(p,'budget_hold')){
        const job=this.#get(p,'execution_job',h.id),op=this.#get(p,'operation',h.id);
        holds.push({...h,...(h.id===claimingId?{startedAt:now()}:{}),notSubmitted:!!job&&job.claimId===null&&op?.executionStatus==='not_started'&&['cancelled','failed','needs_input'].includes(op.status)});
      }
    }
    return budgetProjection(this.#limits,holds,rows);
  }
  budgetStatus(auth,scope){
    const trusted=this.#currentAuth(auth,scope,'read_memory');
    if(trusted.kind!=='ui')denied();return this.#budget(trusted.ownerId);
  }
  reconcileUsage(auth,input){
    validateWire('ReconcileUsageRequest',input);
    if(!input.receiptReference.trim())fail('validation_failed','请填写账单出处。','用订单号或账单行号说明金额来源，不要填写密码或密钥。');
    const trusted=this.#currentAuth(auth,input.scope,'review_memory');if(trusted.kind!=='ui')denied();
    return this.#mutate(auth,input.scope,'reconcile_usage',{...input,expectedStateRevision:0},
      {requestId:input.requestId,expectedStateRevision:input.expectedStateRevision},'review_memory',false,(t,id)=>{
        if(!this.#get(t.partition,'attempt',input.attemptId))denied();
        const all=this.#list(t.partition,'usage_reconciliation');
        const replaced=new Set(all.map(x=>x.supersedesId).filter(Boolean));
        const active=all.filter(x=>x.attemptId===input.attemptId&&!replaced.has(x.id));
        if(input.supersedesId===null?active.length:active.length!==1||active[0].id!==input.supersedesId)
          fail('conflict','账单核对记录已经变化。','刷新后查看原金额，再明确更正；原记录会保留。');
        if(all.some(x=>x.receiptReference===input.receiptReference&&x.attemptId!==input.attemptId))
          fail('conflict','这条账单已对应另一项执行。','补充准确账单行号，不能重复记账。');
        const value={id:randomUUID(),attemptId:input.attemptId,costUsd:input.costUsd,receiptReference:input.receiptReference,
          supersedesId:input.supersedesId,actorId:t.actorId,recordedAt:now(),provenance:'user_invoice'};
        this.#put(t.partition,'usage_reconciliation',value);
        const operation={id,requestId:input.requestId,status:'succeeded',executionStatus:'not_started',writebackStatus:'saved',resultId:value.id,error:null};
        return {value,operation};
      });
  }
  lookupMutation(auth, scope, method, input, meta, capability) {
    checkMeta(meta);
    const trusted = this.#currentAuth(auth, scope, capability);
    const row = this.#db.prepare('SELECT * FROM receipts WHERE partition=? AND method=? AND request_id=?').get(trusted.partition, method, meta.requestId);
    if (!row) return null;
    if (row.input_hash !== payloadHash(input)) fail('conflict', '同一请求标识对应了不同内容。', '核对原回执，新的操作请明确使用新标识。', 'never');
    return { ...JSON.parse(row.reply_json), duplicate: true };
  }
  state(auth, scope) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory');
    const current = this.#row(trusted.partition), claims = this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='claim' AND json_extract(body_json,'$.lifecycle')='active' AND json_extract(body_json,'$.reviewStatus')!='rejected' ORDER BY rowid").all(trusted.partition).map(r=>JSON.parse(r.body_json));
    const active = type => claims.filter(c => c.type === type && c.lifecycle === 'active' && c.reviewStatus === 'confirmed');
    const resolved = new Set(this.#list(trusted.partition, 'conflict_resolution').map(r => r.conflictId));
    const conflicts = this.#db.prepare('SELECT id FROM quarantined_conflicts WHERE partition=? ORDER BY recorded_at').all(trusted.partition)
      .filter(r => !resolved.has(r.id)).map(r => `资料事件冲突：${r.id}`);
    return validateWire('ProjectState', { scope: clone(scope), stateRevision: current.state_revision,
      permissionRevision: current.permission_revision, facts: active('fact'), decisions: active('decision'),
      failures: active('failure'), lessons: active('lesson'), pending: claims.filter(c => c.reviewStatus === 'pending' && c.lifecycle === 'active'),
      conflicts, unknowns: claims.filter(c => c.type === 'unknown' && c.lifecycle==='active' && c.reviewStatus !== 'rejected').map(c => c.body) });
  }
  #mutate(auth, scope, method, input, meta, capability, semantic, fn, allowStale = false) {
    checkMeta(meta);
    const hash = payloadHash(input);
    return this.#transaction(() => {
      // Authenticate after obtaining the writer lock: another process may revoke a
      // credential while this connection waits for BEGIN IMMEDIATE.
      const trusted = this.#currentAuth(auth, scope, capability), partition = trusted.partition;
      const old = this.#db.prepare('SELECT * FROM receipts WHERE partition=? AND method=? AND request_id=?').get(partition, method, meta.requestId);
      if (old) {
        if (old.input_hash !== hash) fail('conflict', '同一请求标识对应了不同内容。', '核对原回执，新的操作请明确使用新标识。', 'never');
        return { ...JSON.parse(old.reply_json), duplicate: true };
      }
      const current = this.#row(partition);
      if (current.state_revision !== meta.expectedStateRevision && !allowStale) fail('stale_context', '项目已经更新，尚未应用这次修改。', '读取最新进展再确认这次操作。');
      const operationId = randomUUID();
      const outcome = fn(trusted, operationId);
      const value = outcome.value;
      if (semantic && outcome.changed !== false) this.#db.prepare('UPDATE scopes SET state_revision=state_revision+1 WHERE partition=?').run(partition);
      const stateRevision = this.#row(partition).state_revision;
      const operation = outcome.operation ?? { id: operationId, requestId: meta.requestId, status: 'succeeded', executionStatus: 'not_started', writebackStatus: 'saved', resultId: value?.id ?? null, error: null };
      validateWire('Operation', operation);
      this.#put(partition, 'operation', { ...operation, kind: method });
      const reply = { value, stateRevision, operationId, duplicate: false };
      this.#db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?,?)').run(partition, method, meta.requestId, hash, operationId, JSON.stringify(reply));
      if (semantic && outcome.changed !== false) this.#db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)')
        .run(randomUUID(), partition, 'memory_changed', JSON.stringify({ operationId, stateRevision }), 'pending', now());
      this.fault?.({ method, phase: 'before_commit' });
      return clone(reply);
    });
  }
  saveBlob(auth, scope, input, meta) {
    if (!(input?.bytes instanceof Uint8Array) || input.bytes.byteLength > 64 * 1024 * 1024 ||
        !SOURCE_FORMATS.includes(input.format)) fail('validation_failed', '资料格式或大小不符合要求。', '选择文字、PDF、Word、表格或幻灯片；原文件不能超过64兆。');
    const bytes = Buffer.from(input.bytes), hash = sha256(bytes);
    return this.#mutate(auth, scope, 'save_blob', { hash, format: input.format }, meta, 'write_memory', false,
      trusted => ({ value: this.#saveSource(trusted, bytes, input.format) }));
  }
  #saveSource(trusted, bytes, format) {
    const hash = sha256(bytes), identity = payloadHash({ hash, format });
    const old = this.#identity(trusted.partition, 'source', identity);
    if (old) return old;
    this.#db.prepare('INSERT OR IGNORE INTO raw_blobs VALUES (?,?,?)').run(trusted.ownerId, hash, bytes);
    const source = validateWire('SourceBlob', { id: randomUUID(), sha256: hash, byteLength: bytes.length, format, createdAt: now() });
    this.#put(trusted.partition, 'source', source, identity);
    return source;
  }
  getBlob(auth, scope, sourceId) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory'), blob = this.#get(trusted.partition, 'source', sourceId);
    if (!blob) denied();
    const row = this.#db.prepare('SELECT bytes FROM raw_blobs WHERE owner_id=? AND sha256=?').get(trusted.ownerId, blob.sha256);
    if (!row || sha256(row.bytes) !== blob.sha256 || row.bytes.length !== blob.byteLength) fail('conflict', '原件与保存的指纹不一致。', '保留记录并核对备份，不能用查询重建原件。', 'never');
    return { blob, bytes: Uint8Array.from(row.bytes) };
  }
  appendParsed(auth, scope, input, meta) {
    if (!Array.isArray(input)) fail('validation_failed', '解析结果需要列表。', '核对解析器输出。');
    return this.#mutate(auth, scope, 'append_parsed', input, meta, 'write_memory', true, trusted => {
      const items = [];
      for (const item of input) {
        const parsed = validateWire('ParsedRevision', { ...item, id: randomUUID(), recordedAt: now() });
        const source = this.#get(trusted.partition, 'source', item.sourceId);
        if (!source) denied();
        const coverage = parsed.coverage;
        // Normalization belongs to the versioned parser; the shared contract does not prescribe
        // a join separator for blocks. Do not invent one and break otherwise valid DSH parsers.
        if (coverage.totalBytes !== source.byteLength || coverage.coveredBytes > source.byteLength) {
          fail('conflict', '解析内容、覆盖范围或原文指纹不一致。', '保留原件并核对解析器输出。');
        }
        const blockIds = new Set();
        let end = 0;
        for (const block of parsed.blocks) {
          if (blockIds.has(block.id) || block.rawStartByte < end || block.rawEndByte < block.rawStartByte || block.rawEndByte > source.byteLength) fail('conflict', '解析区段重复或超出原件。', '核对原文区段。');
          blockIds.add(block.id); end = block.rawEndByte;
        }
        let gapEnd = 0;
        for (const gap of coverage.gaps) {
          if (gap.rawStartByte < gapEnd || gap.rawEndByte <= gap.rawStartByte || gap.rawEndByte > source.byteLength) fail('conflict', '未处理区段范围不一致。', '补充真实覆盖缺口。');
          gapEnd = gap.rawEndByte;
        }
        if (coverage.coveredBytes + coverage.gaps.reduce((sum,gap) => sum + gap.rawEndByte - gap.rawStartByte, 0) !== source.byteLength) fail('conflict', '覆盖字节数与未处理区段不一致。', '核对解析覆盖统计。');
        if (coverage.status === 'complete' && (coverage.coveredBytes !== source.byteLength || coverage.gaps.length) ||
            coverage.status !== 'complete' && source.byteLength && !coverage.gaps.length ||
            coverage.status === 'unsupported' && (coverage.coveredBytes !== 0 || parsed.blocks.length)) fail('conflict', '覆盖状态与解析结果不一致。', '如实报告未处理部分。');
        let native;
        if(parsed.parserVersion===CODEX_SESSION_PARSER){
          if(source.format!=='application/x-ndjson')denied();
          native=parseCodexSession(this.getBlob(auth,scope,source.id).bytes,source.sha256);
          if(payloadHash(parsed.blocks)!==payloadHash(native.blocks)||payloadHash(parsed.coverage)!==payloadHash(native.coverage)||parsed.normalizedTextHash!==native.normalizedTextHash)denied();
        }
        const identity = payloadHash(item), existing = this.#identity(trusted.partition, 'parsed', identity);
        if (existing) items.push(existing); else { this.#put(trusted.partition, 'parsed', parsed, identity);if(native)this.#put(trusted.partition,'native_mapping',{id:parsed.id,records:native.records});items.push(parsed); }
      }
      return { value: items, changed: input.length > 0 };
    });
  }
  appendOccurrences(auth, scope, input, meta) {
    if (!Array.isArray(input)) fail('validation_failed', '来源事件需要列表。', '核对事件输出。');
    try {
      return this.#mutate(auth, scope, 'append_occurrences', input, meta, 'write_memory', true, trusted => {
        let changed = false;
        const items = input.map(item => {
          const value = validateWire('Occurrence', { ...item, id: randomUUID(), recordedAt: now(), scope: clone(scope) });
          const source = this.#get(trusted.partition, 'source', value.sourceId), parsed = value.parsedRevisionId === null ? null : this.#get(trusted.partition, 'parsed', value.parsedRevisionId);
          if (!source || value.parsedRevisionId !== null && (!parsed || parsed.sourceId !== source.id)) denied();
          let allowedBlocks;
          if(parsed?.parserVersion===CODEX_SESSION_PARSER){
            const mapping=this.#get(trusted.partition,'native_mapping',parsed.id),record=mapping?.records.find(r=>r.eventId===value.eventId);
            if(!record||value.externalSystem!=='codex-native-session'||value.formatVersion!==CODEX_SESSION_VERSION||['sessionId','seq','occurredAt','payloadHash'].some(k=>value[k]!==record[k]))denied();
            allowedBlocks=record.blockIds;
          }
          const identity = payloadHash({ externalSystem: value.externalSystem, formatVersion: value.formatVersion, sessionId: value.sessionId, eventId: value.eventId });
          const existing = this.#identity(trusted.partition, 'occurrence', identity);
          if (existing) {
            if (payloadHash(item) !== payloadHash(Object.fromEntries(Object.entries(existing).filter(([k]) => !['id','recordedAt','scope'].includes(k))))) {
              const error = new ProtocolError('conflict', '同一来源事件出现了不同内容，已保留冲突待核对。', '核对来源事件，不能覆盖旧记录。', 'never');
              error.quarantine = { partition: trusted.partition, kind: 'occurrence', identity, existingHash: existing.payloadHash, incomingHash: item.payloadHash, incoming: clone(item) };
              throw error;
            }
            return existing;
          }
          changed = true; this.#put(trusted.partition, 'occurrence', value, identity);if(allowedBlocks)this.#put(trusted.partition,'occurrence_blocks',{id:value.id,blockIds:allowedBlocks});return value;
        });
        return { value: items, changed };
      });
    } catch (error) {
      if (error.quarantine) {
        const q = error.quarantine;
        this.#transaction(() => {
          const identity=payloadHash(q);
          if(this.#identity(q.partition,'quarantined_conflict',identity))return;
          const id=randomUUID(),recordedAt=now();
          this.#put(q.partition,'quarantined_conflict',{id,...q,recordedAt},identity);
          this.#db.prepare('INSERT INTO quarantined_conflicts VALUES (?,?,?,?,?,?,?)').run(id,q.partition,q.kind,q.identity,q.existingHash,q.incomingHash,recordedAt);
          this.#db.prepare('UPDATE scopes SET state_revision=state_revision+1 WHERE partition=?').run(q.partition);
          this.#db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)').run(randomUUID(),q.partition,'memory_changed',JSON.stringify({conflictId:id,stateRevision:this.#row(q.partition).state_revision}),'pending',recordedAt);
        });
      }
      throw error;
    }
  }
  conflictDetails(auth, scope) {
    const t=this.#currentAuth(auth,scope,'review_memory');
    if(t.kind!=='ui')denied();
    const resolutions=this.#list(t.partition,'conflict_resolution');
    return this.#list(t.partition,'quarantined_conflict').map(q=>{
      const original=this.#identity(t.partition,'occurrence',q.identity);
      const excerpt=o=>this.#get(t.partition,'parsed',o?.parsedRevisionId)?.blocks.map(b=>b.text).join('\n').slice(0,8000)??'';
      const relatedClaims=this.#list(t.partition,'claim').filter(c=>c.lifecycle==='active'&&c.evidence.some(e=>e.occurrenceId===original?.id));
      return {id:q.id,recordedAt:q.recordedAt,existing:original,incoming:q.incoming,relatedClaims,
        existingText:excerpt(original),incomingText:excerpt(q.incoming),resolution:resolutions.find(r=>r.conflictId===q.id)??null};
    });
  }
  resolveConflict(auth, request) {
    const correcting=['correct','merge'].includes(request?.action);
    const keys=['protocolVersion','scope','requestId','expectedStateRevision','conflictId','action','note',...(correcting?['replacement']:[])];
    if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION||
      typeof request.conflictId!=='string'||!['keep_existing','keep_separate','correct','merge'].includes(request.action)||
      typeof request.note!=='string'||!request.note.trim()||request.note.length>8000)fail('validation_failed','请说明如何处理这两份资料。','选择处理方式，并填写原因。');
    if(correcting){
      const r=request.replacement;
      if(!r||Object.keys(r).sort().join(',')!=='body,condition,supersedes,title,type')fail('validation_failed','请填写新结论及需要替代的记录。','写清标题、内容、类型和适用条件。');
      validateWire('CandidateInput',{...r,evidenceKind:'user_statement',evidence:[],occurredAt:null});
      if(!r.title.trim()||!r.body.trim()||r.type==='lesson'&&!r.condition?.trim())fail('validation_failed','结论不能为空，经验还需要适用条件。','写清内容及什么情况下可以使用。');
    }
    const {scope,requestId,expectedStateRevision}=request;
    if(this.#currentAuth(auth,scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,scope,'resolve_conflict',request,{requestId,expectedStateRevision},'review_memory',true,t=>{
      const q=this.#get(t.partition,'quarantined_conflict',request.conflictId);
      if(!q)denied();
      if(this.#list(t.partition,'conflict_resolution').some(r=>r.conflictId===q.id))fail('conflict','这处冲突已有处理结论。','查看已保存的选择，不重复处理。','never');
      let occurrenceId=null;
      if(request.action==='keep_separate'||correcting){
        // Preserve the source's exact event identity. This reviewed branch has a distinct
        // storage identity and provenance; it is not a forged native event or a confirmed claim.
        const occurrence=validateWire('Occurrence',{...q.incoming,id:randomUUID(),scope:clone(scope),recordedAt:now()});
        this.#put(t.partition,'occurrence',occurrence,payloadHash({reviewedConflict:q.id}));occurrenceId=occurrence.id;
        const parsed=this.#get(t.partition,'parsed',occurrence.parsedRevisionId);
        if(parsed?.parserVersion===CODEX_SESSION_PARSER){
          const record=this.#get(t.partition,'native_mapping',parsed.id)?.records.find(r=>r.eventId===occurrence.eventId);
          if(!record)denied();
          this.#put(t.partition,'occurrence_blocks',{id:occurrence.id,blockIds:record.blockIds});
        }
      }
      let claimId=null;
      if(correcting){
        const original=this.#identity(t.partition,'occurrence',q.identity);
        const affected=new Set(this.#list(t.partition,'claim').filter(c=>c.lifecycle==='active'&&c.evidence.some(e=>e.occurrenceId===original.id)).map(c=>c.id));
        if(new Set(request.replacement.supersedes).size!==request.replacement.supersedes.length||request.replacement.supersedes.some(id=>!affected.has(id)))denied();
        // The user's new statement is its own immutable source, not a fabricated quote from an old file.
        const {title,body,...rest}=request.replacement;
        const text=`${title}\n${body}\n更正依据：${request.note}`,bytes=Buffer.from(text);
        const source=this.#saveSource(t,bytes,'text/plain');
        const block={id:'human:'+q.id,text,rawStartByte:0,rawEndByte:bytes.length};
        const parsed=validateWire('ParsedRevision',{id:randomUUID(),sourceId:source.id,parserVersion:'synplex.human-correction/1',normalizedTextHash:payloadHash([text]),blocks:[block],coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]},recordedAt:now()});
        this.#put(t.partition,'parsed',parsed);
        const occurrence=validateWire('Occurrence',{id:randomUUID(),scope:clone(scope),sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:'synplex-human-correction',formatVersion:'1',sessionId:null,eventId:q.id,seq:null,importOrigin:'user_paste',occurredAt:null,recordedAt:now(),payloadHash:source.sha256});
        this.#put(t.partition,'occurrence',occurrence);
        const evidence={sourceId:source.id,parsedRevisionId:parsed.id,occurrenceId:occurrence.id,blockId:block.id,start:0,end:text.length,offsetUnit:'utf16_code_unit',quote:text,quoteHash:source.sha256};
        this.#checkEvidence(t,evidence);
        const claim=validateWire('Claim',{...rest,title,body,id:randomUUID(),evidenceKind:'user_statement',evidence:[evidence],occurredAt:null,lifecycle:'active',reviewStatus:'confirmed',recordedAt:now(),effectiveFrom:now(),effectiveUntil:null,actorId:t.actorId});
        this.#put(t.partition,'claim',claim);claimId=claim.id;
        for(const id of claim.supersedes){const old=this.#get(t.partition,'claim',id),before=clone(old);old.lifecycle='superseded';old.effectiveUntil=claim.effectiveFrom;this.#replace(t.partition,'claim',old);this.#put(t.partition,'claim_revision',{id:randomUUID(),claimId:id,before,after:clone(old),replacementId:claim.id,reason:request.note,actorId:t.actorId,recordedAt:now()});}
      }
      const resolution={id:randomUUID(),conflictId:q.id,action:request.action,note:request.note,
        actorId:t.actorId,occurrenceId,claimId,recordedAt:now()};
      this.#put(t.partition,'conflict_resolution',resolution);return {value:resolution};
    });
  }
  taskConflicts(auth,scope,selectedOccurrenceIds){
    const t=this.#currentAuth(auth,scope,'read_memory'),selected=new Set();
    for(const id of selectedOccurrenceIds){const o=this.#get(t.partition,'occurrence',id);if(!o)denied();selected.add(o.sourceId);}
    const resolved=new Set(this.#list(t.partition,'conflict_resolution').map(r=>r.conflictId));
    return this.#list(t.partition,'quarantined_conflict').filter(q=>!resolved.has(q.id)).filter(q=>{
      if(!selected.size)return true;
      const original=this.#identity(t.partition,'occurrence',q.identity);
      if(!original||selected.has(original.sourceId)||selected.has(q.incoming.sourceId))return true;
      const texts=[original,q.incoming].map(o=>this.#get(t.partition,'parsed',o.parsedRevisionId)?.blocks.map(b=>b.text).join('\n'));
      // Only an explicit source selection can exclude ordinary unrelated conflicts.
      // Missing parsers and global safety boundaries remain blocking; no lexical guess may waive them.
      return texts.some(text=>!text||/(?:不得|禁止|不能|不允许|必须|务必|仅允许|\bnever\b|\bmust\b|\bdo not\b)/i.test(text));
    }).map(q=>`资料事件冲突：${q.id}`);
  }
  #checkEvidence(trusted, span) {
    validateWire('EvidenceSpan', span);
    const parsed = this.#get(trusted.partition, 'parsed', span.parsedRevisionId), occurrence = this.#get(trusted.partition, 'occurrence', span.occurrenceId);
    if (!parsed || !occurrence || parsed.sourceId !== span.sourceId || occurrence.sourceId !== span.sourceId ||
        occurrence.parsedRevisionId !== parsed.id) denied();
    const block = parsed.blocks.find(b => b.id === span.blockId);
    if (!block) denied();
    const source=this.#get(trusted.partition,'source',span.sourceId);
    if(source.format==='application/x-ndjson'&&!this.#get(trusted.partition,'occurrence_blocks',occurrence.id)?.blockIds.includes(block.id))denied();
    validateEvidence(span, block);
  }
  #excerpt(block, query) {
    const found=block.text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
    let start=Math.max(0,found-256),end=Math.min(block.text.length,Math.max(start+1024,found+query.length));
    const splits=offset=>offset>0&&offset<block.text.length&&block.text.charCodeAt(offset-1)>=0xD800&&block.text.charCodeAt(offset-1)<=0xDBFF&&block.text.charCodeAt(offset)>=0xDC00&&block.text.charCodeAt(offset)<=0xDFFF;
    if(splits(start))start--;if(splits(end))end++;
    return {start,end,quote:block.text.slice(start,end)};
  }
  appendCandidates(auth, scope, input, meta) {
    if (!Array.isArray(input)) fail('validation_failed', '候选记录需要列表。', '核对候选输出。');
    input.forEach(item => validateWire('CandidateInput', item));
    return this.#mutate(auth, scope, 'append_candidates', input, meta, 'write_memory', true, trusted => {
      const items = input.map(candidate => {
        for(const sourceId of new Set(candidate.evidence.map(e=>e.sourceId)))if(this.#get(trusted.partition,'source_metadata',sourceId)?.locked)
          fail('conflict','这份资料已锁定，不能自动重新整理。','原文件和之前的整理仍保留；本人可修改，或明确解除锁定。');
        if (['direct_tool_receipt','independent_check'].includes(candidate.evidenceKind) && !trusted.capabilities.has('trusted_evidence')) denied();
        for (const span of candidate.evidence) {
          this.#checkEvidence(trusted, span);
          if(!span.quote.trim())fail('validation_failed','候选记录没有可读的原文依据。','选择有实际内容的引用，未知信息应明确标为未知。');
        }
        for (const id of candidate.supersedes) {const old=this.#get(trusted.partition,'claim',id);if(!old)denied();
          if(old.evidence.some(e=>this.#get(trusted.partition,'source_metadata',e.sourceId)?.locked))fail('conflict','要替代的记录来自已锁定资料。','由本人修改或解除锁定，不能让自动整理覆盖。');}
        if (!candidate.evidence.length && candidate.type !== 'unknown') fail('validation_failed', '这条记录缺少原文依据。', '添加来源或将缺失信息标为未知。');
        const value = validateWire('Claim', { ...candidate, id: randomUUID(), lifecycle: 'active', reviewStatus: 'pending',
          recordedAt: now(), effectiveFrom: null, effectiveUntil: null, actorId: trusted.actorId });
        this.#put(trusted.partition, 'claim', value); return value;
      });
      return { value: items, changed: items.length > 0 };
    });
  }
  sourceMetadata(auth,scope,sourceId){
    const t=this.#currentAuth(auth,scope,'read_memory');if(!this.#get(t.partition,'source',sourceId))denied();
    return this.#get(t.partition,'source_metadata',sourceId)??{id:sourceId,revision:0,title:(this.#get(t.partition,'source_filename',sourceId)?.name??'').slice(0,160),category:'',tags:[],locked:false};
  }
  updateSourceMetadata(auth,request){
    if(!request||Object.keys(request).sort().join(',')!=='expectedMetadataRevision,expectedStateRevision,metadata,protocolVersion,requestId,scope,sourceId'||request.protocolVersion!==PROTOCOL_VERSION||!Number.isSafeInteger(request.expectedMetadataRevision)||request.expectedMetadataRevision<0)denied();
    const metadata=validateSourceMetadata(request.metadata);if(this.#currentAuth(auth,request.scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'update_source_metadata',request,requestMeta(request),'review_memory',true,t=>{
      const before=this.sourceMetadata(auth,request.scope,request.sourceId);
      if(before.revision!==request.expectedMetadataRevision)fail('stale_context','资料名称、分类或锁定状态已更新。','重新打开这份资料，再确认修改。');
      const value={id:request.sourceId,...metadata,revision:before.revision+1,updatedAt:now(),actorId:t.actorId};
      if(before.revision)this.#replace(t.partition,'source_metadata',value);else this.#put(t.partition,'source_metadata',value);
      this.#put(t.partition,'source_metadata_revision',{id:randomUUID(),sourceId:request.sourceId,before,after:clone(value),actorId:t.actorId,recordedAt:now()});return {value};
    });
  }
  editClaim(auth,request){
    return this.#editClaim(auth,request);
  }
  #editClaim(auth,request,historicalId=null){
    if(!request||Object.keys(request).sort().join(',')!=='claimId,draft,expectedClaimHash,expectedStateRevision,note,protocolVersion,requestId,scope'||request.protocolVersion!==PROTOCOL_VERSION||typeof request.expectedClaimHash!=='string'||typeof request.note!=='string'||!request.note.trim()||request.note.length>8000)denied();
    const draft=claimDraft(request.draft);if(this.#currentAuth(auth,request.scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,historicalId?'restore_claim':'edit_claim',request,requestMeta(request),'review_memory',true,t=>{
      const old=this.#get(t.partition,'claim',request.claimId);if(!old)denied();
      if(payloadHash(old)!==request.expectedClaimHash||old.lifecycle!=='active'||old.reviewStatus==='rejected')fail('stale_context','这条记录已修改、替代或未采用。','查看当前记录；历史不能自动恢复为当前结论。');
      const pending=this.#db.prepare(`SELECT 1 FROM search_replacements e JOIN records c ON c.partition=e.partition AND c.kind='claim' AND c.id=e.claim_id
        WHERE e.partition=? AND e.prior_claim_id=? AND json_extract(c.body_json,'$.lifecycle')='active' AND json_extract(c.body_json,'$.reviewStatus')='pending' LIMIT 1`).get(t.partition,old.id);
      if(pending)fail('conflict','这条记录已有待确认的修改。','先核对或修改待确认的版本，再继续。');
      if(historicalId){
        const chain=claimVersions(old.id,this.#search.relatedClaims(t.partition,[old.id]).map(r=>JSON.parse(r.body_json)),[]);
        if(old.reviewStatus!=='confirmed'||chain.current.length!==1||chain.current[0].id!==old.id||!chain.connected.has(historicalId)||this.#get(t.partition,'claim',historicalId)?.reviewStatus!=='confirmed')fail('conflict','当前记录或历史确认结果已变化。','核对唯一的当前结论后，再选择历史内容。');
      }
      // A manual edit has its own actual user statement. It cannot manufacture a
      // changed quotation in an imported original or silently become confirmed.
      const text=`${draft.title}\n${draft.body}\n修改原因：${request.note}`,bytes=Buffer.from(text),source=this.#saveSource(t,bytes,'text/plain');
      const block={id:'manual:'+randomUUID(),text,rawStartByte:0,rawEndByte:bytes.length},parsed=validateWire('ParsedRevision',{id:randomUUID(),sourceId:source.id,parserVersion:'synplex.manual-edit/1',normalizedTextHash:payloadHash([text]),blocks:[block],coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]},recordedAt:now()});this.#put(t.partition,'parsed',parsed);
      const occurrence=validateWire('Occurrence',{id:randomUUID(),sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:'synplex-manual-edit',formatVersion:'1',scope:clone(request.scope),sessionId:null,eventId:request.requestId,seq:null,importOrigin:'user_paste',occurredAt:null,recordedAt:now(),payloadHash:source.sha256});this.#put(t.partition,'occurrence',occurrence);
      const span={sourceId:source.id,parsedRevisionId:parsed.id,occurrenceId:occurrence.id,blockId:block.id,start:0,end:text.length,offsetUnit:'utf16_code_unit',quote:text,quoteHash:source.sha256};this.#checkEvidence(t,span);
      const value=validateWire('Claim',{...draft,id:randomUUID(),evidenceKind:'user_statement',evidence:[span],supersedes:[old.id,...(old.reviewStatus==='pending'?old.supersedes.filter(id=>this.#get(t.partition,'claim',id)?.lifecycle==='active'):[])],occurredAt:old.occurredAt,lifecycle:'active',reviewStatus:'pending',recordedAt:now(),effectiveFrom:null,effectiveUntil:null,actorId:t.actorId});this.#put(t.partition,'claim',value);
      // Prior evidence remains on the prior claim. Only the new user statement
      // supports this edited wording; a changed body is not a changed old quote.
      if(!this.#get(t.partition,'source_metadata',source.id))this.#put(t.partition,'source_metadata',{id:source.id,title:draft.title,category:this.sourceMetadata(auth,request.scope,old.evidence[0]?.sourceId??source.id).category,tags:[],locked:true,revision:1,updatedAt:now(),actorId:t.actorId});
      const before=clone(old);if(old.reviewStatus==='pending'){old.lifecycle='superseded';old.effectiveUntil=now();this.#replace(t.partition,'claim',old);}
      this.#put(t.partition,'claim_revision',{id:randomUUID(),claimId:old.id,before,after:clone(old),replacementId:value.id,reason:request.note,...(historicalId?{restoredFrom:historicalId}:{}),actorId:t.actorId,recordedAt:now()});return {value};
    });
  }
  claimDetail(auth,scope,claimId){
    return this.#transaction(()=>this.#claimDetail(auth,scope,claimId));
  }
  #expressionPreview(auth,scope,input){
    // This facade is used only while the caller holds our SQLite transaction.
    // It reuses existing projection rules without nested BEGIN statements.
    return projectExpression({claimDetail:(a,s,id)=>this.#claimDetail(a,s,id),read:(a,s,kind,id)=>{
      if(kind!=='source')denied();return this.getBlob(a,s,id).blob;
    }},auth,scope,input);
  }
  approveExpression(auth,request){
    validateExpressionVersion(request);if(!validExpressionInput(request))denied();
    if(this.#currentAuth(auth,request.scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'approve_expression',request,requestMeta(request),'review_memory',false,t=>{
      const selection={title:request.title.trim(),claimIds:request.claimIds,includeEvidence:request.includeEvidence};
      const preview=this.#expressionPreview(auth,request.scope,{...selection,expectedSelectionHash:request.expectedSelectionHash});
      const html=renderExpressionHtml(preview,{linked:true}),version={id:randomUUID(),selection,content:{title:preview.title,count:preview.count,sections:preview.sections},selectionHash:preview.selectionHash,
        html,sha256:sha256(Buffer.from(html)),createdAt:now(),authorCredentialId:this.#auth.get(auth),permissionRevision:t.permissionRevision};
      requireExpressionBytes(version);this.#put(t.partition,'project_expression_version',version);
      return {value:expressionSummary(version,'saved')};
    });
  }
  stopExpression(auth,request){
    validateExpressionVersion(request,{stop:true});if(this.#currentAuth(auth,request.scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'stop_expression',request,requestMeta(request),'review_memory',false,t=>{
      if(!this.#get(t.partition,'project_expression_version',request.versionId))denied();
      if(!this.#get(t.partition,'project_expression_stop',request.versionId))this.#put(t.partition,'project_expression_stop',{
        id:request.versionId,actorId:t.actorId,stoppedAt:now()});
      return {value:{id:request.versionId,status:'stopped'}};
    },true); // Withdrawal stays available even if another edit has just arrived.
  }
  expressionVersions(auth,scope){
    const t=this.#currentAuth(auth,scope,'review_memory');if(t.kind!=='ui')denied();
    const rows=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='project_expression_version' ORDER BY rowid DESC LIMIT 50").all(t.partition);
    const versions=rows.map(row=>{const v=JSON.parse(row.body_json);return expressionSummary(v,this.#get(t.partition,'project_expression_stop',v.id)?'stopped':'saved');});
    return {versions,total:this.recordCount(auth,scope,'project_expression_version'),complete:versions.length===this.recordCount(auth,scope,'project_expression_version')};
  }
  expressionVersion(auth,scope,id,{forLink=false}={}){
    return this.#transaction(()=>{
      const t=this.#currentAuth(auth,scope,'review_memory');if(t.kind!=='ui')denied();
      const version=this.#get(t.partition,'project_expression_version',id);if(!version)denied();requireExpressionBytes(version);
      const stopped=!!this.#get(t.partition,'project_expression_stop',id);
      if(forLink){
        if(stopped||t.permissionRevision!==version.permissionRevision)denied();
        const author=this.#db.prepare('SELECT * FROM credentials WHERE id=? AND partition=?').get(version.authorCredentialId,t.partition);
        if(!author||author.revoked||author.kind!=='ui'||author.permission_revision!==t.permissionRevision)denied();
        this.#expressionPreview(auth,scope,{...version.selection,expectedSelectionHash:version.selectionHash});
      }
      return {...expressionSummary(version,stopped?'stopped':'saved'),content:version.content,html:version.html,selection:version.selection,selectionHash:version.selectionHash};
    });
  }
  #claimDetail(auth,scope,claimId){
    const t=this.#currentAuth(auth,scope,'read_memory'),claim=this.#get(t.partition,'claim',claimId);if(!claim)denied();
    const related=this.#search.relatedClaims(t.partition,[claimId]).map(r=>JSON.parse(r.body_json)),relatedIds=new Set(related.map(c=>c.id));
    const allRevisions=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='claim_revision' AND json_extract(body_json,'$.claimId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(t.partition,JSON.stringify([...relatedIds])).map(r=>JSON.parse(r.body_json)),chain=claimVersions(claimId,related,allRevisions);
    const reviews=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='review' AND json_extract(body_json,'$.claimId') IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(t.partition,JSON.stringify([...chain.connected])).map(r=>JSON.parse(r.body_json));
    const occurrences=[...new Set(related.flatMap(c=>c.evidence.map(e=>e.occurrenceId)))];
    const outcomes=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='result_source_link' AND json_extract(body_json,'$.occurrenceId') IN (SELECT value FROM json_each(?)) ORDER BY rowid DESC").all(t.partition,JSON.stringify(occurrences)).map(row=>{
      const link=JSON.parse(row.body_json),result=this.#get(t.partition,'result',link.id);
      const r=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='result_review' AND json_extract(body_json,'$.resultId')=? ORDER BY rowid DESC LIMIT 1").get(t.partition,link.id);
      return result?{id:result.id,summary:result.summary,recordedAt:result.recordedAt,review:r?JSON.parse(r.body_json):null}:null;
    }).filter(Boolean);
    const journey=recordJourney({claims:related.filter(c=>chain.connected.has(c.id)),revisions:allRevisions,reviews,outcomes});
    return {claim,journey,contentHash:payloadHash(claim),versions:chain.versions,current:chain.current,currentHashes:Object.fromEntries(chain.current.map(c=>[c.id,payloadHash(c)])),versionCount:chain.total,complete:chain.complete,
      revisions:allRevisions.filter(r=>chain.connected.has(r.claimId)&&chain.connected.has(r.replacementId)),sources:claim.evidence.map(e=>this.sourceMetadata(auth,scope,e.sourceId))};
  }
  compareClaims(auth,scope,beforeId,afterId){
    const detail=this.claimDetail(auth,scope,afterId),before=detail.versions.find(c=>c.id===beforeId);if(!before)denied();
    return {before,after:detail.claim,changes:claimDifference(before,detail.claim)};
  }
  restoreClaim(auth,request){
    const keys=['protocolVersion','scope','requestId','expectedStateRevision','claimId','expectedClaimHash','historicalClaimId','note'];
    if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION||typeof request.note!=='string'||!request.note.trim()||request.note.length>7600)denied();
    const detail=this.claimDetail(auth,request.scope,request.claimId),historical=detail.versions.find(c=>c.id===request.historicalClaimId);
    if(!historical||historical.id===request.claimId||historical.reviewStatus!=='confirmed')fail('conflict','只能选用同一记录中曾确认过的历史内容。','先比较当前与历史版本；未确认或未采用的内容不能直接恢复。');
    const {historicalClaimId,...rest}=request;
    // Use the existing atomic edit path, preserving CAS, one pending successor,
    // human-only authorization and idempotency. Restoration never confirms.
    return this.#editClaim(auth,{...rest,draft:claimDraft({title:historical.title,body:historical.body,type:historical.type,condition:historical.condition}),note:`重新选用曾确认的历史内容。${request.note}`},historicalClaimId);
  }
  sourceMetadataHistory(auth,scope,sourceId){
    const current=this.sourceMetadata(auth,scope,sourceId),t=this.#currentAuth(auth,scope,'read_memory');
    const total=this.#db.prepare("SELECT COUNT(*) n FROM records WHERE partition=? AND kind='source_metadata_revision' AND json_extract(body_json,'$.sourceId')=?").get(t.partition,sourceId).n;
    return {current,total,complete:total<=100,revisions:this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='source_metadata_revision' AND json_extract(body_json,'$.sourceId')=? ORDER BY rowid DESC LIMIT 100").all(t.partition,sourceId).map(r=>JSON.parse(r.body_json))};
  }
  issueReviewAuthorization(auth, request) {
    validateWire('ReviewRequest', { ...request, authorizationId: 'issued-by-service' });
    const trusted = this.#currentAuth(auth, request.scope, 'review_memory');
    if (trusted.kind !== 'ui') denied();
    const state = this.#row(trusted.partition);
    if (state.state_revision !== request.expectedStateRevision) fail('stale_context', '项目已更新。', '核对最新记录后重新确认。');
    if (!this.#get(trusted.partition, 'claim', request.claimId)) denied();
    const id = randomUUID(), expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    this.#db.prepare('INSERT INTO authorizations VALUES (?,?,?,?,?,?,?,?,?)').run(id, trusted.partition, trusted.actorId, 'review',
      payloadHash({ claimId: request.claimId, reviewStatus: request.reviewStatus, requestId: request.requestId }), state.state_revision, state.permission_revision, expiresAt, 0);
    return { authorizationId: id, expiresAt };
  }
  review(auth, request) {
    validateWire('ReviewRequest', request);
    return this.#mutate(auth, request.scope, 'review', request, { requestId: request.requestId, expectedStateRevision: request.expectedStateRevision }, 'review_memory', true, trusted => {
      if (trusted.kind !== 'ui') denied();
      const grant = this.#db.prepare('SELECT * FROM authorizations WHERE id=?').get(request.authorizationId);
      if (!grant || grant.used || grant.partition !== trusted.partition || grant.actor_id !== trusted.actorId ||
          grant.permission_revision !== trusted.permissionRevision || grant.state_revision !== request.expectedStateRevision || grant.expires_at < now() ||
          grant.input_hash !== payloadHash({ claimId: request.claimId, reviewStatus: request.reviewStatus, requestId: request.requestId })) denied();
      const claim = this.#get(trusted.partition, 'claim', request.claimId);
      if (!claim) denied();
      if(claim.lifecycle!=='active')fail('stale_context','这条记录已被替代。','保留历史；请核对当前记录，不能用旧版本覆盖新结论。');
      const appliedBefore=!!this.#db.prepare("SELECT 1 FROM records WHERE partition=? AND kind='review' AND json_extract(body_json,'$.claimId')=? AND json_extract(body_json,'$.after.reviewStatus')='confirmed' LIMIT 1").get(trusted.partition,claim.id);
      if(request.reviewStatus==='confirmed'&&!appliedBefore&&claim.supersedes.some(id=>{
        const old=this.#get(trusted.partition,'claim',id);
        // A pending manual predecessor was intentionally retired on editing.
        const manualLink=!!this.#db.prepare("SELECT 1 FROM records WHERE partition=? AND kind='claim_revision' AND json_extract(body_json,'$.claimId')=? AND json_extract(body_json,'$.replacementId')=? AND json_extract(body_json,'$.before.reviewStatus')='pending' LIMIT 1").get(trusted.partition,id,claim.id);
        return !old||old.reviewStatus==='rejected'||old.lifecycle!=='active'&&!manualLink;
      }))fail('stale_context','要替代的记录已发生变化。','核对当前结论后再修改，不能用晚到的旧版本覆盖新结论。');
      const before = clone(claim);
      claim.reviewStatus = request.reviewStatus;
      if(request.reviewStatus==='confirmed'&&before.reviewStatus!=='confirmed'){claim.effectiveFrom=now();claim.effectiveUntil=null;}
      this.#replace(trusted.partition, 'claim', claim);
      this.#put(trusted.partition, 'review', { id: randomUUID(), claimId: claim.id, before, after: clone(claim), actorId: trusted.actorId, authorizationId: grant.id, recordedAt: now() });
      // Only confirmation makes the replacement effective; the old record remains available in history.
      if (request.reviewStatus === 'confirmed' && claim.lifecycle === 'active') for (const id of claim.supersedes) {
        const old = this.#get(trusted.partition, 'claim', id);
        old.lifecycle = 'superseded'; old.effectiveUntil = claim.effectiveFrom??now();
        this.#replace(trusted.partition, 'claim', old);
      }
      this.#db.prepare('UPDATE authorizations SET used=1 WHERE id=?').run(grant.id);
      return { value: clone(claim) };
    });
  }
  query(auth, scope, query) {
    return this.#transaction(()=>this.#query(auth,scope,query));
  }
  #query(auth, scope, query) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory');
    if (!query || typeof query.query !== 'string' || !query.query.trim() || Array.from(query.query).length > 512 || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100 ||
        typeof query.includeHistory !== 'boolean' || query.occurrenceIds !== null && (!Array.isArray(query.occurrenceIds) || query.occurrenceIds.some(id => !this.#get(trusted.partition, 'occurrence', id)))) fail('validation_failed', '检索条件不完整或关键词过长。', '提供最多512字的关键词、范围与1到100的返回数量。');
    const offset = this.#decodeCursor(query.cursor, trusted.partition, payloadHash({ ...query, cursor: null }));
    const hits=this.#search.find(trusted.partition,query,offset),more=hits.length>query.limit;
    const items=hits.slice(0,query.limit).map(row=>{
      const block={id:row.block_id,text:row.body_text},excerpt=this.#excerpt(block,query.query);
      const span={sourceId:row.source_id,parsedRevisionId:row.parsed_id,occurrenceId:row.occurrence_id,blockId:row.block_id,...excerpt,offsetUnit:'utf16_code_unit',quoteHash:sha256(Buffer.from(excerpt.quote))};
      return {claim:row.claim_json?JSON.parse(row.claim_json):null,span,occurrence:JSON.parse(row.occurrence_json)};
    });
    return {items,cursor:more?this.#encodeCursor(trusted.partition,payloadHash({...query,cursor:null}),offset+items.length):null,stateRevision:this.#row(trusted.partition).state_revision};
  }
  #encodeCursor(partition, queryHash, offset) {
    return Buffer.from(JSON.stringify({ partition, queryHash, offset, revision: this.#row(partition).state_revision })).toString('base64url');
  }
  #decodeCursor(cursor, partition, queryHash) {
    if (cursor === null) return 0;
    try {
      const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (c.partition !== partition || c.queryHash !== queryHash || c.revision !== this.#row(partition).state_revision || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new Error();
      return c.offset;
    } catch { fail('stale_context', '检索位置已过期或不属于这次查询。', '从当前项目重新查询。'); }
  }
  listOccurrences(auth, scope, query) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory');
    if (!Number.isInteger(query?.limit) || query.limit < 1 || query.limit > 100) fail('validation_failed', '列表数量不符合要求。', '选择1到100条。');
    const offset = this.#decodeCursor(query.cursor, trusted.partition, 'occurrences');
    const rows=this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='occurrence' ORDER BY rowid LIMIT ? OFFSET ?").all(trusted.partition,query.limit+1,offset);
    const items=rows.slice(0,query.limit).map(row=>JSON.parse(row.body_json));
    return {items,cursor:rows.length>query.limit?this.#encodeCursor(trusted.partition,'occurrences',offset+items.length):null,stateRevision:this.#row(trusted.partition).state_revision};
  }
  checkpoint(auth, scope, value, meta) {
    validateWire('ChunkCheckpoint', value); validateUsage(value.usage);
    return this.#mutate(auth, scope, 'save_checkpoint', value, meta, 'write_memory', false, trusted => {
      if (!this.#get(trusted.partition, 'source', value.sourceId)) denied();
      if (value.permissionRevision !== trusted.permissionRevision || value.stateRevision !== meta.expectedStateRevision) fail('stale_context', '分块处理基于旧权限或旧进展。', '核对当前范围，不自动重新调用模型。');
      for (const id of value.candidateIds) if (!this.#get(trusted.partition, 'claim', id)) denied();
      for (const id of value.attemptIds) if (!this.#get(trusted.partition, 'attempt', id)) denied();
      const old = this.#identity(trusted.partition, 'checkpoint', value.cacheKey);
      if (old && (old.id !== value.id || old.sourceId !== value.sourceId || old.chunkHash !== value.chunkHash ||
          old.permissionRevision !== value.permissionRevision || old.stateRevision !== value.stateRevision ||
          old.parserVersion !== value.parserVersion || old.ruleVersion !== value.ruleVersion || old.promptVersion !== value.promptVersion || old.model !== value.model)) fail('conflict', '缓存标识对应了不同的区段或处理条件。', '按来源、版本和权限建立新的缓存标识。');
      if (old && ['succeeded','unknown'].includes(old.status) && payloadHash(old) !== payloadHash(value)) fail('conflict', '已完成或结果未知的区段不能重新改为待执行。', '先核对已有回执，避免重复付费。', 'lookup_operation');
      if (old) this.#replace(trusted.partition, 'checkpoint', value); else this.#put(trusted.partition, 'checkpoint', value, value.cacheKey);
      return { value: clone(value) };
    });
  }
  operation(auth, scope, operationId) {
    const stored = this.read(auth, scope, 'operation', operationId);
    if (!stored) denied();
    const { kind, ...operation } = stored;
    return validateWire('Operation', operation);
  }
  async importResult(auth, scope, operationId) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory');
    return (await readImportResult({ ...trusted, authorizedScope: scope }, { protocolVersion: PROTOCOL_VERSION, scope, operationId }, async id => {
      const stored = this.#get(trusted.partition, 'operation', id);
      if (!stored) return null;
      const { kind, ...operation } = stored;
      return { ownerId: trusted.ownerId, scope, kind, operation, result: operation.resultId ? this.#get(trusted.partition, 'import_result', operation.resultId) : null };
    })).body;
  }
  obsidianNotes(auth,scope){
    const {partition}=this.#currentAuth(auth,scope,'read_memory');
    const rows=this.#db.prepare(`SELECT j.body_json, o.body_json AS operation FROM records j
      JOIN records o ON o.partition=j.partition AND o.kind='operation' AND o.id=j.id
      WHERE j.partition=? AND j.kind='import_job' AND json_extract(j.body_json,'$.metadata.sourceSystem')=?
      ORDER BY j.rowid DESC LIMIT 1001`).all(partition,OBSIDIAN_SOURCE);
    const selected=new Map();
    for(const row of rows.slice(0,1000)){
      const job=JSON.parse(row.body_json),identity=readNoteIdentity(job.metadata.sessionId);if(!identity)continue;
      const key=JSON.stringify(identity),previous=selected.get(key);
      const source=this.#get(partition,'source',job.sourceId),operation=JSON.parse(row.operation);
      if(!source)continue;
      const locked=!!this.#get(partition,'source_metadata',source.id)?.locked;
      // Keep the newest readable snapshot as the link target. A later failed
      // import must not hide a previously readable note or its edit lock.
      if(!previous||!['succeeded','needs_input'].includes(previous.status)&&['succeeded','needs_input'].includes(operation.status))
        selected.set(key,{...identity,sourceId:source.id,sha256:source.sha256,operationId:job.id,status:operation.status,locked:locked||!!previous?.locked});
      else if(locked)previous.locked=true;
    }
    return {items:[...selected.values()],complete:rows.length<=1000};
  }
  admitImport(auth, request, bytes) {
    validateWire('ImportMetadataRequest', request);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 64 * 1024 * 1024) fail('validation_failed', '原件超过64MiB。', '明确拆分后再导入。');
    if(request.sourceSystem===OBSIDIAN_SOURCE&&(!readNoteIdentity(request.sessionId)||request.format!=='text/markdown'||request.formatVersion!=='1'||bytes.byteLength>2*1024*1024))fail('validation_failed','笔记内容或位置无法读取。','每份笔记不超过2兆，请重新选择笔记库内的文件。');
    return this.#mutate(auth, request.scope, 'import_source', { request: { ...request, expectedStateRevision: 0 }, rawHash: sha256(bytes) },
      { requestId: request.requestId, expectedStateRevision: request.expectedStateRevision }, 'write_memory', false, (trusted, id) => {
        if(request.sourceSystem===OBSIDIAN_SOURCE){
          const identity=readNoteIdentity(request.sessionId),locked=this.#db.prepare(`SELECT json_extract(j.body_json,'$.sourceId') source_id
            FROM records j JOIN records m ON m.partition=j.partition AND m.kind='source_metadata' AND m.id=json_extract(j.body_json,'$.sourceId')
            WHERE j.partition=? AND j.kind='import_job' AND json_extract(j.body_json,'$.metadata.sourceSystem')=?
            AND json_extract(json_extract(j.body_json,'$.metadata.sessionId'),'$.vault')=? AND json_extract(json_extract(j.body_json,'$.metadata.sessionId'),'$.path')=?
            AND json_extract(m.body_json,'$.locked')=1 ORDER BY j.rowid DESC LIMIT 1`).get(trusted.partition,OBSIDIAN_SOURCE,identity.vault,identity.path);
          if(locked&&this.#get(trusted.partition,'source',locked.source_id)?.sha256!==sha256(bytes))fail('conflict','这篇笔记已锁定，没有替换原记录。','先在资料的“名称与分类”核对锁定状态。');
        }
        const source = this.#saveSource(trusted, Buffer.from(bytes), request.format);
        if(request.sourceName&&!this.#get(trusted.partition,'source_filename',source.id))this.#put(trusted.partition,'source_filename',{id:source.id,name:request.sourceName});
        const operation = { id, requestId: request.requestId, status: 'queued', executionStatus: 'not_started', writebackStatus: 'not_required', resultId: null, error: null };
        this.#put(trusted.partition, 'import_job', { id, sourceId: source.id, metadata: clone(request), actorId: trusted.actorId });
        return { value: { source, operation }, operation };
      });
  }
  settleImport(auth, scope, operationId, { parsed, occurrences, warnings, outcome, error = null }) {
    const trusted = this.#currentAuth(auth, scope, 'write_memory');
    return this.#transaction(() => {
      const op = this.#get(trusted.partition, 'operation', operationId), job = this.#get(trusted.partition, 'import_job', operationId);
      if (!op || op.kind !== 'import_source' || !job) denied();
      if (op.resultId) {
        const old = this.#get(trusted.partition, 'import_result', op.resultId);
        if (payloadHash({ parsed: old.parsed, occurrences: old.occurrences, warnings: old.warnings, outcome: old.outcome, error: old.error }) !== payloadHash({ parsed, occurrences, warnings, outcome, error })) fail('conflict', '导入终态不能覆盖。', '核对已保存结果。', 'never');
        return clone(old);
      }
      const source = this.#get(trusted.partition, 'source', job.sourceId);
      if (parsed !== null) {
        const stored = this.#get(trusted.partition, 'parsed', parsed.id);
        if (!stored || payloadHash(stored) !== payloadHash(parsed) || parsed.sourceId !== source.id || parsed.coverage.status !== outcome && !['failed','cancelled'].includes(outcome)) fail('conflict', '导入解析结果不属于这次原件。', '核对保存的解析回执。');
      } else if (!['failed','cancelled'].includes(outcome)) fail('conflict', '这次导入缺少覆盖说明。', '提供解析结果或明确失败。');
      for (const occ of occurrences) if (payloadHash(this.#get(trusted.partition, 'occurrence', occ.id)) !== payloadHash(occ) || occ.sourceId !== source.id || occ.parsedRevisionId !== null && occ.parsedRevisionId !== parsed?.id) fail('conflict', '来源事件与导入结果不一致。', '核对来源事件回执。');
      const snapshot = { id: randomUUID(), operationId, source, parsed, occurrences, warnings, outcome, error, recordedAt: now() };
      snapshot.contentHash = payloadHash(snapshot); validateWire('ImportResultSnapshot', snapshot);
      if (['partial','unsupported'].includes(outcome) && !warnings.some(w => w.code === (outcome === 'partial' ? 'partial_parse' : 'unsupported_format'))) fail('conflict', '导入缺口需要明确提示。', '提供未处理范围和继续条件。');
      if (outcome === 'failed' && !error || ['complete','partial','unsupported'].includes(outcome) && error !== null) fail('conflict', '导入状态和错误说明不一致。', '核对导入结果。');
      for (const w of warnings) if (w.operationId !== null && w.operationId !== operationId) fail('conflict', '警告不属于此次导入。', '核对操作标识。');
      this.#put(trusted.partition, 'import_result', snapshot);
      op.status = { complete: 'succeeded', partial: 'needs_input', unsupported: 'needs_input', failed: 'failed', cancelled: 'cancelled' }[outcome];
      op.resultId = snapshot.id; op.error = error; validateWire('Operation', (({kind,...wire})=>wire)(op));
      this.#replace(trusted.partition, 'operation', op);
      this.fault?.({ method: 'settle_import', phase: 'before_commit' });
      return clone(snapshot);
    });
  }
  importProgress(auth, scope, operationId, status, error = null) {
    const trusted = this.#currentAuth(auth, scope, 'write_memory');
    return this.#transaction(() => {
      const op = this.#get(trusted.partition, 'operation', operationId);
      if (!op || op.kind !== 'import_source') denied();
      if (op.resultId || !['queued','running','unknown'].includes(status) || op.status === 'unknown' && status !== 'unknown' ||
          status === 'unknown' && error?.retry !== 'lookup_operation') fail('conflict', '导入状态不能这样更新。', '核对已有回执，不重新提取。', 'lookup_operation');
      op.status = status; op.error = error;
      validateWire('Operation', (({kind,...wire})=>wire)(op)); this.#replace(trusted.partition, 'operation', op);
      return this.operation(auth, scope, operationId);
    });
  }
  validateFrozenContext(auth, scope, packetId) {
    const trusted = this.#currentAuth(auth, scope, 'read_memory'), packet = this.#get(trusted.partition, 'context', packetId), state = this.#row(trusted.partition);
    if (!packet) denied();
    if (packet.stateRevision !== state.state_revision || packet.permissionRevision !== state.permission_revision) fail('stale_context', '这份背景已过期，尚未发送或执行。', '按最新进展重新准备。');
    const run=this.#db.prepare("SELECT id FROM records WHERE partition=? AND kind='run' AND json_extract(body_json,'$.contextPacketId')=?").get(trusted.partition,packetId);
    const step=run&&this.#get(trusted.partition,'task_step',run.id);
    if(step){const plan=this.taskPlan(auth,scope,step.planId),node=plan.nodes.find(n=>n.id===step.nodeId);
      if(node.runId!==step.runId||node.status==='blocked_dependency'||payloadHash(node.inputRefs)!==payloadHash(step.inputRefs))fail('stale_context','前置成果或步骤安排已经变化。','保留已完成成果，按最新版本重新准备这一步。');}
    return clone(packet);
  }
  createTaskPlan(auth,request){
    const keys='baseRunId,expectedStateRevision,plan,protocolVersion,requestId,scope';
    if(!request||Object.keys(request).filter(k=>k!=='baseResultId').sort().join(',')!==keys||request.protocolVersion!==PROTOCOL_VERSION||typeof request.baseRunId!=='string'||request.baseResultId!==undefined&&typeof request.baseResultId!=='string')denied();
    const plan=validateTaskPlan(request.plan);
    if(this.#currentAuth(auth,request.scope,'prepare_task').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'create_task_plan',request,requestMeta(request),'prepare_task',false,t=>{
      const run=this.#get(t.partition,'run',request.baseRunId),packet=run&&this.#get(t.partition,'context',run.contextPacketId);if(!packet)denied();
      const value={...plan,id:randomUUID(),baseRunId:run.id,scope:clone(request.scope),createdAt:now(),actorId:t.actorId};
      if(request.baseResultId!==undefined){
        const result=this.#get(t.partition,'result',request.baseResultId),attempt=result&&this.#get(t.partition,'attempt',result.attemptId);
        if(!attempt||attempt.runId!==run.id||plan.nodes.length!==1||plan.nodes[0].dependsOn.length)denied();
        this.#put(t.partition,'task_step',{id:randomUUID(),planId:value.id,nodeId:plan.nodes[0].id,runId:run.id,generation:1,inputRefs:[],previousResultId:null,selectedResultId:result.id,instruction:'',preparationHash:null,createdAt:now()});
      }
      this.#put(t.partition,'task_plan',value);return {value};
    });
  }
  taskPlan(auth,scope,id){
    const {partition}=this.#currentAuth(auth,scope,'read_memory'),plan=this.#get(partition,'task_plan',id);if(!plan)denied();
    const selection=this.#list(partition,'task_route_selection').findLast(s=>s.planId===id)??null;
    const projected=projectTaskPlan({...plan,routeSelection:selection},{...Object.fromEntries([['links','task_step'],['runs','run'],['attempts','attempt'],['results','result'],['reviews','result_review'],['operations','operation'],['selections','task_result_selection']].map(([name,kind])=>[name,this.#list(partition,kind)])),executionOptionsForRun:run=>this.#get(partition,'context',run.contextPacketId)?.executionOptions??null});
    const base=this.#get(partition,'run',plan.baseRunId),startable=startableTaskSteps(projected);
    return {...projected,mode:base?.mode,executorOwner:base?.executorOwner,nextStepId:startable[0]?.id??null,startableStepIds:startable.map(n=>n.id)};
  }
  #planChoices(partition,plan,executors){
    const run=this.#get(partition,'run',plan.baseRunId),adapter=executors.find(e=>e.owner===run?.executorOwner&&e.mode===run?.mode);
    if(run?.mode==='host_assist'||!adapter?.selectionChoices?.length)fail('capability_unavailable','这个工具尚未提供可选型号。','选择可以指定型号的工具后再安排步骤。');
    return adapter.selectionChoices;
  }
  quoteTaskRoutes(auth,request,executors){
    if(!request||Object.keys(request).filter(k=>k!=='assignments').sort().join(',')!=='expectedStateRevision,planId,protocolVersion,requestId,scope'||request.protocolVersion!==PROTOCOL_VERSION||typeof request.planId!=='string')denied();
    const t=this.#currentAuth(auth,request.scope,'prepare_task');if(t.kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'quote_task_routes',{...request,expectedStateRevision:0},requestMeta(request),'prepare_task',false,(trusted,id)=>{
      const plan=this.taskPlan(auth,request.scope,request.planId),run=this.#get(trusted.partition,'run',plan.baseRunId),packet=this.#get(trusted.partition,'context',run.contextPacketId);
      const choices=this.#planChoices(trusted.partition,plan,executors);
      const value={id,planId:plan.id,actorId:trusted.actorId,choices:clone(choices),stateRevision:this.#row(trusted.partition).state_revision,
        permissionRevision:trusted.permissionRevision,...compareTaskRoutes({plan,packet,choices,prices:this.#prices,assignments:request.assignments,quotedAt:now()})};
      this.#put(trusted.partition,'task_route_quote',value);return {value};
    }).value;
  }
  selectTaskRoute(auth,request,executors){
    if(!request||Object.keys(request).sort().join(',')!=='expectedStateRevision,protocolVersion,quoteId,requestId,routeId,scope'||request.protocolVersion!==PROTOCOL_VERSION||typeof request.quoteId!=='string'||typeof request.routeId!=='string')denied();
    const t=this.#currentAuth(auth,request.scope,'prepare_task');if(t.kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'select_task_route',{...request,expectedStateRevision:0},requestMeta(request),'prepare_task',false,(trusted,id)=>{
      const quote=this.#get(trusted.partition,'task_route_quote',request.quoteId);if(!quote||quote.actorId!==trusted.actorId)denied();
      const plan=this.taskPlan(auth,request.scope,quote.planId),choices=this.#planChoices(trusted.partition,plan,executors),route=quote.routes.find(r=>r.id===request.routeId);
      if(!route)denied();
      if(quote.permissionRevision!==trusted.permissionRevision||quote.stateRevision!==this.#row(trusted.partition).state_revision||quote.planFingerprint!==planRouteFingerprint(plan)||quote.choicesFingerprint!==payloadHash(choices)||quote.pricesFingerprint!==payloadHash(this.#prices.map(p=>p.revision))||Date.parse(quote.quotedAt)+300000<Date.now())fail('stale_context','安排或单价已经更新，请重新比较。','保留当前选择，重新打开比较再确认，尚未开始执行。');
      if(!plan.nodes.some(n=>!n.generation)||route.assignments.some(a=>plan.nodes.find(n=>n.id===a.nodeId)?.generation))fail('conflict','只能调整尚未准备的步骤。','已准备、正在执行和已完成的步骤保留原设置，不会重新执行。');
      const value={id,planId:plan.id,quoteId:quote.id,routeId:route.id,assignments:clone(route.assignments),actorId:trusted.actorId,createdAt:now()};
      this.#put(trusted.partition,'task_route_selection',value);return {value};
    }).value;
  }
  admitPlanStep(auth,request){
    if(!request||Object.keys(request).sort().join(',')!=='expectedStateRevision,nodeId,planId,protocolVersion,requestId,scope,stepHash'||request.protocolVersion!==PROTOCOL_VERSION||typeof request.planId!=='string'||typeof request.nodeId!=='string'||typeof request.stepHash!=='string'||!/^[a-f0-9]{64}$/.test(request.stepHash))denied();
    const t=this.#currentAuth(auth,request.scope,'execute');if(t.kind!=='ui')denied();
    const result=this.#mutate(auth,request.scope,'start_plan_step',{...request,expectedStateRevision:0},requestMeta(request),'execute',false,(trusted,id)=>{
      const plan=this.taskPlan(auth,request.scope,request.planId),node=startableTaskSteps(plan).find(n=>n.id===request.nodeId);
      if(plan.mode==='host_assist')fail('capability_unavailable','这份安排交给其他工具处理。','复制步骤说明到正在使用的工具，不会在这里额外启动任务。');
      if(!node||node.executionHash!==request.stepHash)fail('stale_context','所选步骤或前置成果已经变化，尚未开工。','刷新步骤安排，检查最新进展后再开始。');
      const preparation=node.status==='prepared'?null:{protocolVersion:PROTOCOL_VERSION,scope:clone(request.scope),requestId:randomUUID(),expectedStateRevision:request.expectedStateRevision,planId:plan.id,nodeId:node.id,instruction:'',baseResultId:node.resultId};
      if(preparation)this.stepPreparation(auth,preparation);
      const value={id,planId:plan.id,nodeId:node.id,actorId:trusted.actorId,preparation,runId:preparation?null:node.runId,inputRefs:node.inputRefs,executionRequestId:randomUUID(),createdAt:now()};
      this.#put(trusted.partition,'plan_step_start',value);return {value};
    });
    if(result.value.actorId!==t.actorId)denied();return result.value;
  }
  planStepExecution(auth,scope,startId,runId){
    return this.#transaction(()=>{
      const t=this.#currentAuth(auth,scope,'execute'),intent=this.#get(t.partition,'plan_step_start',startId);
      if(t.kind!=='ui'||!intent||intent.actorId!==t.actorId)denied();
      const previous=this.#get(t.partition,'plan_step_dispatch',startId);if(previous){if(previous.request.runId!==runId)denied();return clone(previous.request);}
      const plan=this.taskPlan(auth,scope,intent.planId),node=plan.nodes.find(n=>n.id===intent.nodeId),run=this.#get(t.partition,'run',runId);
      if(!run||node?.runId!==runId||node.status!=='prepared'||payloadHash(node.inputRefs)!==payloadHash(intent.inputRefs))fail('stale_context','这一步的说明或前置成果已经变化。','检查原任务和最新成果，不重复开工。');
      const packet=this.validateFrozenContext(auth,scope,run.contextPacketId);
      const request={protocolVersion:PROTOCOL_VERSION,scope:clone(scope),requestId:intent.executionRequestId,expectedStateRevision:packet.stateRevision,runId};
      const grant=this.#executionAuthorization(auth,request,t);
      const dispatch={...request,authorizationId:grant.authorizationId};
      this.#put(t.partition,'plan_step_dispatch',{id:startId,request:dispatch});
      this.fault?.({method:'plan_step_dispatch',phase:'before_commit'});
      return dispatch;
    });
  }
  #resultInput(trusted,resultId,role){
    const result=this.#get(trusted.partition,'result',resultId);if(!result)denied();
    for(const artifact of result.artifacts)if(!this.#get(trusted.partition,'artifact_file',payloadHash({resultId,artifactId:artifact.id})))
      fail('conflict','上一版的成果文件还没有保存。','先在成果页保存原文件，再准备修改或下一步。');
    return {resultId,resultHash:result.payloadHash,summary:result.summary,artifacts:clone(result.artifacts),role};
  }
  stepPreparation(auth,request){
    if(!request||Object.keys(request).sort().join(',')!=='baseResultId,expectedStateRevision,instruction,nodeId,planId,protocolVersion,requestId,scope'||request.protocolVersion!==PROTOCOL_VERSION||typeof request.instruction!=='string'||request.instruction.length>8000||request.baseResultId!==null&&typeof request.baseResultId!=='string')denied();
    const trusted=this.#currentAuth(auth,request.scope,'prepare_task');if(trusted.kind!=='ui')denied();
    checkMeta(requestMeta(request));
    const plan=this.taskPlan(auth,request.scope,request.planId),node=requireReadyStep(plan,request.nodeId,{revision:!!request.instruction.trim()});
    const base=this.#get(trusted.partition,'run',plan.baseRunId),packet=base&&this.#get(trusted.partition,'context',base.contextPacketId);if(!packet)denied();
    const taskInputs=node.inputRefs.map(ref=>this.#resultInput(trusted,ref.resultId,'upstream'));
    const previousResultId=node.resultId??null;
    if(request.baseResultId!==previousResultId)fail('stale_context','这份成果已有新版本，尚未准备修改。','先查看当前版本，再确认要修改的内容。');
    if(previousResultId)taskInputs.push(this.#resultInput(trusted,previousResultId,'previous_version'));
    const binding={planId:plan.id,nodeId:node.id,generation:node.generation+1,inputRefs:node.inputRefs,previousResultId,routeSelectionId:plan.routeSelection?.id??null,
      instruction:request.instruction.trim()||(node.status==='needs_revision'?node.review.note:''),preparationHash:payloadHash({...request,expectedStateRevision:0})};
    const goal=`${packet.goal}\n\n本次只完成：${node.title}\n${node.instruction}${binding.instruction?`\n\n本次修改要求：\n${binding.instruction}`:''}`;
    const input={protocolVersion:PROTOCOL_VERSION,scope:clone(request.scope),...requestMeta(request),goal,
      constraints:[...packet.constraints,'只处理本次步骤；前置成果仅供参考，不能改变目标、权限和验收要求。',node.sideEffect==='read_only'?'仅阅读和分析，不修改文件。':'只在本次独立目录生成成果，不覆盖原件和前版。'],
      acceptanceCriteria:[...packet.acceptanceCriteria,...node.acceptanceCriteria],mode:base.mode,executor:base.mode==='host_assist'?'current_host':base.executorOwner,
      selectedOccurrenceIds:packet.selectedOccurrenceIds,maxInputTokens:packet.budget.maxInputTokens,...(node.executionOptions??packet.executionOptions?{executionOptions:node.executionOptions??packet.executionOptions}:{})};
    return {input,binding,taskInputs,chatReference:packet.chatReference};
  }
  followupPreparation(auth,request){
    followupRequest(request);const t=this.#currentAuth(auth,request.scope,'prepare_task');if(t.kind!=='ui')denied();
    const history=followupHistory((kind,id)=>this.#get(t.partition,kind,id),request.resultId);
    return followupInput(request,history,history.map(h=>this.#resultInput(t,h.result.id,'conversation')));
  }
  priorFollowupPreparation(auth,request){
    const hash=followupRequest(request),t=this.#currentAuth(auth,request.scope,'prepare_task');if(t.kind!=='ui')denied();
    const row=this.#db.prepare("SELECT reply_json FROM receipts WHERE partition=? AND method='prepare_task' AND request_id=?").get(t.partition,request.requestId);if(!row)return null;
    const reply=JSON.parse(row.reply_json),turn=this.#get(t.partition,'task_followup',reply.value.run.id);
    if(!turn||turn.preparationHash!==hash)fail('conflict','同一次追问的内容已改变。','先核对原提交，不重复准备。','lookup_operation');
    return reply.value;
  }
  taskConversation(auth,scope,runId){
    const t=this.#currentAuth(auth,scope,'read_memory'),run=this.#get(t.partition,'run',runId),packet=run&&this.#get(t.partition,'context',run.contextPacketId);if(t.kind!=='ui'||!packet)denied();
    const turn=this.#get(t.partition,'task_followup',run.id);if(!turn)return null;
    const history=followupHistory((kind,id)=>this.#get(t.partition,kind,id),turn.parentResultId);
    return {rootRunId:turn.rootRunId,originalGoal:history[0].packet.goal,turns:history.map(h=>({runId:h.run.id,resultId:h.result.id,question:h.turn?.question??h.packet.goal,answer:h.result.summary})),currentQuestion:turn.question};
  }
  priorStepPreparation(auth,request){
    if(!request||Object.keys(request).sort().join(',')!=='baseResultId,expectedStateRevision,instruction,nodeId,planId,protocolVersion,requestId,scope'||request.protocolVersion!==PROTOCOL_VERSION)denied();
    const t=this.#currentAuth(auth,request.scope,'prepare_task');if(t.kind!=='ui')denied();
    const row=this.#db.prepare("SELECT reply_json FROM receipts WHERE partition=? AND method='prepare_task' AND request_id=?").get(t.partition,request.requestId);
    if(!row)return null;const reply=JSON.parse(row.reply_json),step=this.#get(t.partition,'task_step',reply.value.run.id);
    if(!step||step.preparationHash!==payloadHash({...request,expectedStateRevision:0}))fail('conflict','同一次准备对应了不同内容。','核对原任务说明，不重复开工。','lookup_operation');
    return reply.value;
  }
  taskInputFiles(auth,scope,packet){
    const files=[];let total=0;
    for(const input of packet.taskInputs??[]){
      const result=this.read(auth,scope,'result',input.resultId);if(!result||result.payloadHash!==input.resultHash)denied();
      for(const artifact of input.artifacts){
        const {receipt,bytes}=this.artifactFile(auth,scope,input.resultId,artifact.id);
        if(receipt.sha256!==artifact.sha256||receipt.byteLength!==artifact.byteLength)denied();
        total+=bytes.length;if(total>64*1024*1024||files.length>=30)fail('budget_exceeded','前置文件超过这次处理容量。','减少本次步骤引用的成果文件。');
        files.push({resultId:input.resultId,artifactId:artifact.id,name:artifact.name,sha256:artifact.sha256,mediaType:artifact.mediaType,bytes});
      }
    }
    return files;
  }
  selectedSourceFiles(auth,scope,packet){
    const t=this.#currentAuth(auth,scope,'read_memory'),seen=new Set(),files=[];let total=0;
    for(const id of packet.selectedOccurrenceIds){
      const occurrence=this.#get(t.partition,'occurrence',id);if(!occurrence)denied();
      if(seen.has(occurrence.sourceId))continue;seen.add(occurrence.sourceId);
      const {blob,bytes}=this.getBlob(auth,scope,occurrence.sourceId),metadata=this.sourceMetadata(auth,scope,blob.id);
      total+=bytes.length;if(total>64*1024*1024||files.length>=30)fail('budget_exceeded','选中的原资料超过本次文件容量。','减少选中的资料或拆成较小的步骤，原件仍保留。');
      const extension=sourceExtension(blob.format),title=metadata.title.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,180);
      const originalName=this.#get(t.partition,'source_filename',blob.id)?.name;
      const name=originalName??(title&&!['.','..'].includes(title)?(title.includes('.')?title:title+'.'+extension):'资料-'+blob.sha256.slice(0,12)+'.'+extension);
      files.push({sourceId:blob.id,occurrenceId:id,name,sha256:blob.sha256,byteLength:bytes.length,mediaType:blob.format,bytes});
    }
    return files;
  }
  #checkPreparedStep(auth,request,packet,taskBinding,trusted){
          const plan=this.taskPlan(auth,request.scope,taskBinding.planId),node=requireReadyStep(plan,taskBinding.nodeId,{revision:!!taskBinding.instruction});
          if(node.generation+1!==taskBinding.generation||payloadHash(node.inputRefs)!==payloadHash(taskBinding.inputRefs)||taskBinding.previousResultId!==(node.resultId??null)||(plan.routeSelection?.id??null)!==taskBinding.routeSelectionId)fail('stale_context','步骤、型号安排或上一版成果已更新。','检查最新安排和成果后重新准备本次步骤。');
          const basePacket=this.#get(trusted.partition,'context',this.#get(trusted.partition,'run',plan.baseRunId).contextPacketId);
          if(payloadHash(basePacket.chatReference??null)!==payloadHash(packet.chatReference??null))denied();
          if(payloadHash(node.executionOptions??basePacket.executionOptions??null)!==payloadHash(packet.executionOptions??null))denied();
          const expectedInputs=node.inputRefs.map(ref=>this.#resultInput(trusted,ref.resultId,'upstream'));
          if(taskBinding.previousResultId)expectedInputs.push(this.#resultInput(trusted,taskBinding.previousResultId,'previous_version'));
          if(payloadHash(expectedInputs)!==payloadHash(packet.taskInputs??[]))denied();
  }
  #checkPreparedFollowup(auth,request,packet,followupBinding){
          const prior=this.followupPreparation(auth,followupBinding.request);
          if(payloadHash(prior.chatReference??null)!==payloadHash(packet.chatReference??null)||payloadHash(prior.binding)!==payloadHash(followupBinding.binding)||payloadHash(prior.input)!==payloadHash(request)||payloadHash(prior.taskInputs)!==payloadHash(packet.taskInputs??[]))denied();
  }
  registerPrepared(auth, request, packet, taskBinding=null, followupBinding=null) {
    validatePrepare(request); validateWire('ContextPacket', packet);
    if(payloadHash(request.executionOptions??null)!==payloadHash(packet.executionOptions??null))fail('conflict','准备的型号或思考程度发生变化。','保留所选配置，重新准备。');
    if (!sameScope(request.scope, packet.scope) || request.goal !== packet.goal || payloadHash(request.constraints) !== payloadHash(packet.constraints) ||
        payloadHash(request.acceptanceCriteria) !== payloadHash(packet.acceptanceCriteria) || request.maxInputTokens !== packet.budget.maxInputTokens ||
        payloadHash(request.selectedOccurrenceIds) !== payloadHash(packet.selectedOccurrenceIds)) fail('conflict', '准备的工作说明改变了原目标或要求。', '保留完整目标重新准备。');
    const { contentHash, ...content } = packet;
    if (contentHash !== payloadHash(content) || packet.budget.estimatedTokens + packet.budget.reservedTokens > packet.budget.maxInputTokens) fail('budget_exceeded', '必要背景超出预算或内容指纹不一致。', '缩小任务范围或明确增加背景预算。');
    return this.#mutate(auth, request.scope, 'prepare_task', { ...request, expectedStateRevision: 0 },
      { requestId: request.requestId, expectedStateRevision: request.expectedStateRevision }, 'prepare_task', false, (trusted, id) => {
        const current = this.#row(trusted.partition);
        if (packet.stateRevision !== current.state_revision || packet.permissionRevision !== trusted.permissionRevision) fail('stale_context', '这份背景来自旧进展或权限。', '重新准备当前项目背景。');
        for (const span of packet.evidence) this.#checkEvidence(trusted, span);
        for (const occurrenceId of packet.selectedOccurrenceIds) if (!this.#get(trusted.partition, 'occurrence', occurrenceId)) denied();
        for (const list of ['facts','failures','lessons','candidates']) for (const claim of packet[list]) {
          const stored = this.#get(trusted.partition, 'claim', claim.id);
          if (!stored || payloadHash(stored) !== payloadHash(claim)) denied();
          const permittedTypes = { facts: ['fact','decision'], failures: ['failure'], lessons: ['lesson'] };
          if (list !== 'candidates' && (claim.reviewStatus !== 'confirmed' || claim.lifecycle !== 'active' || !permittedTypes[list].includes(claim.type))) fail('conflict', '待核对或历史记录不能冒充当前事实。', '分开待核对、历史和当前事实。');
        }
        if(request.conversationId){
          const reference=this.chat(auth,request.scope).snapshot(request.conversationId);
          if(payloadHash(reference)!==payloadHash(packet.chatReference??null))fail('stale_context','这段对话已更新。','查看最新对话后再准备任务。');
        }else if(packet.chatReference&&!taskBinding&&!followupBinding)denied();
        if(taskBinding)this.#checkPreparedStep(auth,request,packet,taskBinding,trusted);
        else if(followupBinding)this.#checkPreparedFollowup(auth,request,packet,followupBinding);
        else if(packet.taskInputs?.length)denied();
        this.#put(trusted.partition, 'context', clone(packet));
        const run = validateWire('Run', { id: randomUUID(), scope: clone(request.scope), contextPacketId: packet.id, requestId: request.requestId,
          mode: request.mode, executorOwner: request.mode === 'host_assist' ? `host:${trusted.actorId}` : request.executor,
          status: 'prepared', writebackStatus: 'not_required', attemptIds: [], createdAt: now() });
        this.#put(trusted.partition, 'run', run);
        if(followupBinding)this.#put(trusted.partition,'task_followup',{...clone(followupBinding.binding),id:run.id,createdAt:now()});
        if(taskBinding)this.#put(trusted.partition,'task_step',{...clone(taskBinding),id:run.id,runId:run.id,createdAt:now()});
        const operation = { id, requestId: request.requestId, status: packet.coverage === 'needs_input' ? 'needs_input' : 'succeeded', executionStatus: 'not_started', writebackStatus: 'not_required', resultId: run.id, error: null };
        return { value: { packet: clone(packet), run, operation }, operation };
      });
  }
  recordResult(auth, request) {
    validateWire('RecordResultRequest', request); validateUsage(request.result.usage);
    return this.#mutate(auth, request.scope, 'record_result', { ...request, expectedStateRevision: 0 },
      { requestId: request.requestId, expectedStateRevision: request.expectedStateRevision }, 'record_result', true, (trusted, id) => {
        const run = this.#get(trusted.partition, 'run', request.runId), result = request.result;
        if (!run || run.mode !== 'host_assist' || run.executorOwner !== `host:${trusted.actorId}`) denied();
        const identity = payloadHash({ runId: run.id, provider: result.provider, eventId: result.eventId });
        const existing = this.#identity(trusted.partition, 'result', identity);
        if (existing) {
          if (existing.payloadHash !== payloadHash(result)) fail('conflict', '同一执行事件内容发生变化。', '修订请使用新事件并关联旧结果。', 'never');
          const operation = { id, requestId: request.requestId, status: 'succeeded', executionStatus: 'unknown', writebackStatus: 'saved', resultId: existing.id, error: null };
          return { value: { result: existing, operation }, operation, changed: false };
        }
        if (result.supersedesResultId !== null && !this.#list(trusted.partition, 'result').some(x => x.id === result.supersedesResultId && this.#list(trusted.partition, 'attempt').some(a => a.runId === run.id && a.id === x.attemptId))) denied();
        const oldAttempt = this.#get(trusted.partition, 'attempt', result.attemptId);
        if (oldAttempt && oldAttempt.runId !== run.id) denied();
        const raw = clone(result);
        const normalized = { ...clone(result), artifacts: result.artifacts.map(a => ({ ...a, verification: 'reported' })),
          id: randomUUID(), revision: this.#list(trusted.partition, 'result').filter(x => this.#list(trusted.partition, 'attempt').some(a => a.runId === run.id && a.id === x.attemptId)).length + 1,
          payloadHash: payloadHash(result), actorId: trusted.actorId, recordedAt: now(), trust: 'host_reported' };
        validateWire('ResultRevision', normalized);
        this.#put(trusted.partition, 'result', normalized, identity);
        this.#put(trusted.partition, 'raw_result', { id: normalized.id, input: raw });
        const attempt = oldAttempt ?? { id: result.attemptId, runId: run.id, executorOwner: run.executorOwner, status: 'unknown', resultRevisionIds: [], usage: unknownUsage(), createdAt: now(), finishedAt: null };
        attempt.resultRevisionIds.push(normalized.id);
        // Reports cannot establish business success or provider completion. Unknown observations stay unknown.
        if (oldAttempt) this.#replace(trusted.partition, 'attempt', attempt); else this.#put(trusted.partition, 'attempt', validateWire('Attempt', attempt));
        if (!run.attemptIds.includes(attempt.id)) run.attemptIds.push(attempt.id);
        run.writebackStatus = 'saved'; this.#replace(trusted.partition, 'run', run);
        const operation = { id, requestId: request.requestId, status: 'succeeded', executionStatus: 'unknown', writebackStatus: 'saved', resultId: normalized.id, error: null };
        return { value: { result: normalized, operation }, operation };
      }, true);
  }
  issueExecutionAuthorization(auth, request) {
    validateExecutionRequest(request);
    const trusted = this.#currentAuth(auth,request.scope,'execute');
    if (trusted.kind !== 'ui') denied();
    return this.#transaction(() => this.#executionAuthorization(auth,request,trusted));
  }
  #executionAuthorization(auth,request,trusted){
      this.#currentAuth(auth,request.scope,'execute');
      const run = this.#get(trusted.partition,'run',request.runId);
      if (!run || run.mode === 'host_assist') denied();
      if (run.status !== 'prepared') fail('conflict','这项工作已有执行记录。','先查询执行结果，不要重新提交。','lookup_operation');
      const packet = this.validateFrozenContext(auth,request.scope,run.contextPacketId);
      if (packet.coverage === 'needs_input' || packet.conflicts.length) fail('conflict','工作说明仍有缺口或冲突。','先补齐并核对，再准备执行。');
      if (packet.stateRevision !== request.expectedStateRevision) fail('stale_context','授权针对的是旧项目进展。','重新准备工作说明。');
      const id = randomUUID(), expiresAt = new Date(Date.now()+300_000).toISOString();
      this.#db.prepare('INSERT INTO authorizations VALUES (?,?,?,?,?,?,?,?,?)').run(id,trusted.partition,trusted.actorId,'execute',
        payloadHash({runId:run.id,packetHash:packet.contentHash,requestId:request.requestId}),packet.stateRevision,trusted.permissionRevision,expiresAt,0);
      return { authorizationId:id, expiresAt };
  }
  admitExecution(auth, request) {
    validateExecutionRequest(request,true);
    return this.#mutate(auth,request.scope,'execute_task',{...request,expectedStateRevision:0},
      {requestId:request.requestId,expectedStateRevision:request.expectedStateRevision},'execute',false,(trusted,id) => {
        if (trusted.kind !== 'ui') denied();
        const run = this.#get(trusted.partition,'run',request.runId), grant = this.#db.prepare('SELECT * FROM authorizations WHERE id=?').get(request.authorizationId);
        if (!run || run.mode === 'host_assist') denied();
        if (run.status !== 'prepared') fail('conflict','这项工作已有执行负责人。','先查询原执行回执。','lookup_operation');
        const packet = this.validateFrozenContext(auth,request.scope,run.contextPacketId);
        if (!grant || grant.used || grant.action !== 'execute' || grant.partition !== trusted.partition || grant.actor_id !== trusted.actorId ||
            grant.permission_revision !== trusted.permissionRevision || grant.state_revision !== request.expectedStateRevision || grant.expires_at <= now() ||
            grant.input_hash !== payloadHash({runId:run.id,packetHash:packet.contentHash,requestId:request.requestId})) denied();
        if (packet.coverage === 'needs_input' || packet.conflicts.length) fail('conflict','工作说明尚未核对完整。','补齐信息后重新准备。');
        requireBudget(this.#budget(trusted.ownerId));
        const attempt = validateWire('Attempt',{id:randomUUID(),runId:run.id,executorOwner:run.executorOwner,status:'queued',
          resultRevisionIds:[],usage:unknownUsage(),createdAt:now(),finishedAt:null});
        this.#put(trusted.partition,'attempt',attempt);
        run.status='queued'; run.attemptIds.push(attempt.id); this.#replace(trusted.partition,'run',run);
        const job = {id,runId:run.id,attemptId:attempt.id,executorOwner:run.executorOwner,mode:run.mode,packetId:packet.id,
          claimId:null,leaseExpiresAt:null,cancelRequested:false,cancellationSentAt:null,receiptId:null};
        this.#put(trusted.partition,'execution_job',job);
        if(this.#limits)this.#put(trusted.partition,'budget_hold',{id,attemptId:attempt.id,createdAt:attempt.createdAt,
          reservationUsd:this.#limits.reservationUsd,policyRevision:this.#limits.revision});
        this.#db.prepare('UPDATE authorizations SET used=1 WHERE id=?').run(grant.id);
        const operation = {id,requestId:request.requestId,status:'queued',executionStatus:'not_started',writebackStatus:'not_required',resultId:null,error:null};
        return {value:{run:clone(run),attempt:clone(attempt),operation},operation};
      });
  }
  executionStatus(auth,scope){const t=this.#currentAuth(auth,scope,'read_memory');return readExecutionStatus(this.#db,t.partition);}
  executionState(auth,scope,id) {
    const t=this.#currentAuth(auth,scope,'read_memory'),job=this.#get(t.partition,'execution_job',id);
    if (!job) denied();
    const attempt=this.#get(t.partition,'attempt',job.attemptId);
    return {archiveOrigin:job.archiveOrigin??null,operation:this.operation(auth,scope,id),run:this.#get(t.partition,'run',job.runId),attempt,
      results:attempt.resultRevisionIds.map(r=>this.#get(t.partition,'result',r)),cancelRequested:job.cancelRequested,
      goal:this.#get(t.partition,'context',job.packetId)?.goal??'已保存的工作',
      activity:this.#db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='execution_activity' AND json_extract(body_json,'$.operationId')=? ORDER BY rowid DESC LIMIT 100").all(t.partition,id).reverse().map(r=>JSON.parse(r.body_json)),
      questions:this.#list(t.partition,'execution_question').filter(q=>q.operationId===id).map(q=>({...q,
        status:q.status==='pending'&&(this.operation(auth,scope,id).status!=='running'||job.cancelRequested||q.expiresAt<=now())?'unavailable':q.status}))};
  }
  saveExecutionQuestion(auth,scope,id,claimId,prompt,expiresAt){
    validateQuestion(prompt);
    return this.#transaction(()=>{
      const {t,job,op}=this.#claimedExecution(auth,scope,id,claimId);
      if(op.status!=='running'||job.cancelRequested||job.receiptId)denied();
      const identity=payloadHash({operationId:id,claimId,remoteRequestId:prompt.remoteRequestId});
      const prior=this.#identity(t.partition,'execution_question',identity);if(prior)return clone(prior);
      const value={id:randomUUID(),operationId:id,attemptId:job.attemptId,claimId,prompt:clone(prompt),status:'pending',
        expiresAt,recordedAt:now(),answers:null,answeredBy:null,delivery:null};
      this.#put(t.partition,'execution_question',value,identity);
      job.waitingForInput=true;this.#replace(t.partition,'execution_job',job);return clone(value);
    });
  }
  #hasUnresolvedExecution(exceptId){
    return !!this.#db.prepare(`SELECT 1 FROM records o
      LEFT JOIN records j ON j.partition=o.partition AND j.kind='execution_job' AND j.id=o.id
      WHERE o.kind='operation' AND o.id!=? AND json_extract(o.body_json,'$.kind')='execute_task'
      AND json_extract(o.body_json,'$.status') IN ('running','unknown')
      AND NOT (json_extract(o.body_json,'$.status')='running'
        AND COALESCE(json_extract(j.body_json,'$.waitingForInput'),0)=1
        AND json_extract(j.body_json,'$.leaseExpiresAt')>?
        AND EXISTS (SELECT 1 FROM records q WHERE q.partition=o.partition AND q.kind='execution_question'
          AND json_extract(q.body_json,'$.operationId')=o.id
          AND json_extract(q.body_json,'$.status') IN ('pending','answered')
          AND COALESCE(json_extract(q.body_json,'$.delivery'),'pending')!='unavailable')) LIMIT 1`).get(exceptId,now());
  }
  resumeExecutionInput(auth,scope,id,claimId){
    return this.#transaction(()=>{
      const {t,job,op}=this.#claimedExecution(auth,scope,id,claimId);
      if(op.status!=='running'||job.cancelRequested||job.receiptId)denied();
      if(this.#hasUnresolvedExecution(id))return false;
      job.waitingForInput=false;this.#replace(t.partition,'execution_job',job);return true;
    });
  }
  answerExecutionQuestion(auth,request){
    const keys=['protocolVersion','scope','requestId','expectedStateRevision','questionId','answers'];
    if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION||typeof request.questionId!=='string')denied();
    const {scope,requestId,expectedStateRevision}=request;
    if(this.#currentAuth(auth,scope,'execute').kind!=='ui')denied();
    return this.#mutate(auth,scope,'answer_execution_question',request,{requestId,expectedStateRevision},'execute',false,t=>{
      const q=this.#get(t.partition,'execution_question',request.questionId);if(!q)denied();
      const {job,op}=this.#claimedExecution(auth,scope,q.operationId,q.claimId);
      if(q.status!=='pending'||q.expiresAt<=now()||op.status!=='running'||job.cancelRequested||job.receiptId)
        fail('conflict','这个问题已回答或原连接已失效。','查看原任务进展，不重新开工。','lookup_operation');
      q.answers=validateAnswers(q.prompt,request.answers);q.status='answered';q.answeredBy=t.actorId;q.answeredAt=now();q.delivery='pending';
      this.#replace(t.partition,'execution_question',q);return {value:q};
    });
  }
  finishExecutionQuestion(auth,scope,questionId,status){
    const t=this.#currentAuth(auth,scope,'execute');
    if(!['sent','unavailable'].includes(status))denied();
    return this.#transaction(()=>{
      const q=this.#get(t.partition,'execution_question',questionId);if(!q)denied();
      if(status==='sent'&&q.status!=='answered')denied();
      if(q.status==='pending')q.status='unavailable';
      q.delivery=status;this.#replace(t.partition,'execution_question',q);
    });
  }
  appendExecutionActivity(auth,scope,id,claimId,{stage,source}) {
    if(!Object.hasOwn(ACTIVITY_LABELS,stage))fail('validation_failed','执行进展格式无效。','使用已知步骤类型。');
    source=activitySource(source);
    return this.#transaction(()=>{
      const {t,job,op}=this.#claimedExecution(auth,scope,id,claimId);
      if(!['running','unknown'].includes(op.status)||job.receiptId)return;
      const eventId=source?payloadHash({operationId:id,taskId:source.taskId,sequence:source.sequence}):randomUUID();
      const previous=this.#get(t.partition,'execution_activity',eventId);
      if(source)this.#checkActivitySource(t.partition,id,job.attemptId,source,stage,previous);
      if(previous)return clone(previous);
      const event={id:eventId,operationId:id,stage,label:ACTIVITY_LABELS[stage],at:now(),...(source?{source}:{})};
      this.#put(t.partition,'execution_activity',event);return clone(event);
    });
  }
  #checkActivitySource(partition,id,attemptId,source,stage,previous){
    const submission=this.#get(partition,'remote_submission',id);
    if(submission?.attemptId!==attemptId||submission.taskId!==source.taskId)denied();
    if(previous&&(previous.stage!==stage||payloadHash(previous.source)!==payloadHash(source)))fail('conflict','同一步骤出现不同的进度记录。','保留原记录，继续核对原任务，不重新执行。','lookup_operation');
  }
  claimExecution(auth,scope,id,leaseMs=30_000) {
    const t=this.#currentAuth(auth,scope,'execute');
    if (!Number.isInteger(leaseMs) || leaseMs < 10 || leaseMs > 300_000) fail('validation_failed','执行租期无效。','使用合理的服务租期。');
    return this.#transaction(() => {
      this.#currentAuth(auth,scope,'execute');
      const job=this.#get(t.partition,'execution_job',id),op=this.#get(t.partition,'operation',id);
      if (!job || op.kind !== 'execute_task') denied();
      if (op.status !== 'queued') return null; // Never reclaim running/unknown work by resubmitting it.
      try{requireBudget(this.#budget(t.ownerId,id),0);}catch(error){
        if(error.code!=='budget_exceeded')throw error;
        op.error={code:error.code,message:error.message,nextAction:error.nextAction,retry:error.retry,operationId:id};
        this.#replace(t.partition,'operation',op);return null;
      }
      // Serialize across projects and server processes, including work whose
      // connection timed out but whose remote executor may still be running.
      // BEGIN IMMEDIATE makes this check and the claim one atomic decision.
      const unresolved=this.#hasUnresolvedExecution(id);
      if(unresolved){
        op.error={code:'conflict',message:'前一项工作尚未结束或回执待核对，这项工作还没发送。',nextAction:'先核对原任务，结束后再接着执行这项工作。',retry:'after_input',operationId:id};
        this.#replace(t.partition,'operation',op);return null;
      }
      const run=this.#get(t.partition,'run',job.runId),attempt=this.#get(t.partition,'attempt',job.attemptId);
      let packet;
      try {packet=this.validateFrozenContext(auth,scope,job.packetId);}
      catch (error) {
        if (error.code !== 'stale_context') throw error;
        run.status='needs_input'; attempt.status='cancelled'; attempt.finishedAt=now(); op.status='needs_input';
        op.error={code:'stale_context',message:'排队期间项目已更新，任务尚未执行。',nextAction:'按最新进展重新准备。',retry:'after_input',operationId:id};
        this.#replace(t.partition,'run',run);this.#replace(t.partition,'attempt',attempt);this.#replace(t.partition,'operation',op);return null;
      }
      job.claimId=randomUUID();job.leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString();
      const hold=this.#get(t.partition,'budget_hold',id);
      if(hold){hold.startedAt=now();this.#replace(t.partition,'budget_hold',hold);}
      run.status='running';attempt.status='running';op.status='running';op.executionStatus='running';op.error=null;
      for (const [kind,value] of [['execution_job',job],['run',run],['attempt',attempt],['operation',op]])this.#replace(t.partition,kind,value);
      this.fault?.({method:'claim_execution',phase:'before_commit'});
      return {claimId:job.claimId,operationId:id,attemptId:attempt.id,executorOwner:job.executorOwner,mode:job.mode,packet};
    });
  }
  #claimedExecution(auth,scope,id,claimId) {
    const t=this.#currentAuth(auth,scope,'execute'),job=this.#get(t.partition,'execution_job',id);
    if (!job || !claimId || job.claimId !== claimId) denied();
    return {t,job,op:this.#get(t.partition,'operation',id),run:this.#get(t.partition,'run',job.runId),attempt:this.#get(t.partition,'attempt',job.attemptId)};
  }
  claimPausedExecution(auth,scope,id,prompt,leaseMs){
    validateQuestion(prompt);
    if(!Number.isInteger(leaseMs)||leaseMs<10||leaseMs>300_000)fail('validation_failed','连接有效期不正确。','使用工作台配置的有效期。');
    const trusted=this.#currentAuth(auth,scope,'execute');if(trusted.kind!=='ui')denied();
    return this.#transaction(()=>{
      this.#currentAuth(auth,scope,'execute');
      const job=this.#get(trusted.partition,'execution_job',id),op=this.#get(trusted.partition,'operation',id);
      if(!job||job.receiptId||job.cancelRequested||!job.waitingForInput||
        !['running','unknown'].includes(op?.status)||op.status==='running'&&job.leaseExpiresAt>now())return null;
      const questions=this.#list(trusted.partition,'execution_question').filter(q=>q.operationId===id);
      const last=questions.at(-1);
      if(!last||last.answers!==null||payloadHash(last.prompt)!==payloadHash(prompt))return null;
      if(this.#hasUnresolvedExecution(id))return null;
      const previousClaimId=job.claimId;job.claimId=randomUUID();job.leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString();
      job.waitingForInput=false;
      const run=this.#get(trusted.partition,'run',job.runId),attempt=this.#get(trusted.partition,'attempt',job.attemptId),packet=this.#get(trusted.partition,'context',job.packetId);
      run.status='running';attempt.status='running';op.status='running';op.executionStatus='running';op.error=null;
      for(const [kind,value] of [['execution_job',job],['run',run],['attempt',attempt],['operation',op]])this.#replace(trusted.partition,kind,value);
      this.#put(trusted.partition,'execution_recovery',{id:randomUUID(),operationId:id,attemptId:attempt.id,previousClaimId,claimId:job.claimId,remoteRequestId:prompt.remoteRequestId,mode:'input_observation',at:now()});
      return {claimId:job.claimId,operationId:id,attemptId:attempt.id,executorOwner:job.executorOwner,mode:job.mode,packet};
    });
  }
  heartbeatExecution(auth,scope,id,claimId,leaseMs=30_000) {
    if (!Number.isInteger(leaseMs) || leaseMs < 10 || leaseMs > 300_000) fail('validation_failed','执行租期无效。','使用合理的服务租期。');
    return this.#transaction(() => {
      const {t,job,op}=this.#claimedExecution(auth,scope,id,claimId);
      if (op.status !== 'running') return false;
      // A missed lease is a reconciliation boundary, not permission to execute again.
      if (job.leaseExpiresAt <= now()) return false;
      job.leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString();this.#replace(t.partition,'execution_job',job);return true;
    });
  }
  markExecutionUnknown(auth,scope,id,claimId) {
    return this.#transaction(() => {
      const {t,job,op,run,attempt}=this.#claimedExecution(auth,scope,id,claimId);
      if (job.receiptId || !['running','unknown'].includes(op.status)) return false;
      run.status='unknown';attempt.status='unknown';op.status='unknown';op.executionStatus='unknown';
      op.error={code:'conflict',message:'连接中断，实际执行结果待核对。',nextAction:'查询原执行记录，不能自动重跑。',retry:'lookup_operation',operationId:id};
      for(const [kind,value] of [['run',run],['attempt',attempt],['operation',op]])this.#replace(t.partition,kind,value);return true;
    });
  }
  recoverExpiredExecutions(auth,scope) {
    const t=this.#currentAuth(auth,scope,'execute');
    for(const job of this.#list(t.partition,'execution_job')) {
      const op=this.#get(t.partition,'operation',job.id);
      if(op.status==='running' && job.leaseExpiresAt <= now())this.markExecutionUnknown(auth,scope,job.id,job.claimId);
    }
  }
  requestExecutionCancellation(auth,scope,id) {
    const t=this.#currentAuth(auth,scope,'execute');
    if(t.kind !== 'ui')denied();
    return this.#transaction(() => {
      const job=this.#get(t.partition,'execution_job',id);
      if(!job)denied();
      const op=this.#get(t.partition,'operation',id);
      if(!['queued','running','unknown'].includes(op.status))return this.executionState(auth,scope,id);
      job.cancelRequested=true;this.#replace(t.partition,'execution_job',job);
      if(op.status==='queued') {
        const run=this.#get(t.partition,'run',job.runId),attempt=this.#get(t.partition,'attempt',job.attemptId);
        run.status='cancelled';attempt.status='cancelled';attempt.finishedAt=now();op.status='cancelled';op.executionStatus='not_started';
        for(const [kind,value] of [['run',run],['attempt',attempt],['operation',op]])this.#replace(t.partition,kind,value);
      }
      return this.executionState(auth,scope,id);
    });
  }
  takeExecutionCancellation(auth,scope,id,claimId) {
    return this.#transaction(() => {
      const {t,job,op}=this.#claimedExecution(auth,scope,id,claimId);
      if(!job.cancelRequested || job.cancellationSentAt || !['running','unknown'].includes(op.status))return false;
      job.cancellationSentAt=now();this.#replace(t.partition,'execution_job',job);return true;
    });
  }
  saveExecutionReceipt(auth,scope,id,claimId,{status,result}) {
    validateWire('ResultInput',result);validateUsage(result.usage);
    if(!['succeeded','failed','cancelled'].includes(status))fail('validation_failed','执行器回执不完整。','核对执行器实际终态。');
    return this.#transaction(() => {
      const {t,job,op,run,attempt}=this.#claimedExecution(auth,scope,id,claimId);
      if(result.attemptId !== attempt.id || result.supersedesResultId !== null)denied();
      const hash=payloadHash({status,result});
      if(job.receiptId) {
        const old=this.#get(t.partition,'execution_receipt',job.receiptId);
        if(old.payloadHash !== hash)fail('conflict','执行回执发生冲突。','保留已有结果并核对执行器。','lookup_operation');
        return clone(old);
      }
      if(!['running','unknown'].includes(op.status))fail('conflict','这项执行已结束。','查询已有回执。','lookup_operation');
      const receipt={id:randomUUID(),operationId:id,status,result:clone(result),payloadHash:hash,recordedAt:now()};
      this.#put(t.partition,'execution_receipt',receipt);job.receiptId=receipt.id;
      run.status=status;run.writebackStatus='pending';attempt.status=status;attempt.finishedAt=receipt.recordedAt;attempt.usage=clone(result.usage);
      op.status=status;op.executionStatus=status;op.writebackStatus='pending';
      op.error={code:'writeback_pending',message:'执行已有结果，记录待补齐。',nextAction:'仅补写记录，不重新执行。',retry:'writeback_only',operationId:id};
      for(const [kind,value] of [['execution_job',job],['run',run],['attempt',attempt],['operation',op]])this.#replace(t.partition,kind,value);
      this.#db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)').run(randomUUID(),t.partition,'execution_writeback',JSON.stringify({operationId:id,receiptId:receipt.id}),'pending',now());
      this.fault?.({method:'save_execution_receipt',phase:'before_commit'});
      return clone(receipt);
    });
  }
  // Internal bridge bookkeeping only; it is not part of ScopedRepository or the six MCP tools.
  reserveRemoteSubmission(auth,scope,id,attemptId,binding) {
    const t=this.#currentAuth(auth,scope,'execute');
    if(t.kind!=='ui')denied();
    if(!binding || Object.keys(binding).sort().join(',')!=='packetHash,payloadHash,targetKey' ||
        Object.values(binding).some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))
      fail('validation_failed','执行连接指纹不完整。','使用服务固定的连接和完整工作说明。');
    return this.#transaction(()=>{
      this.#currentAuth(auth,scope,'execute');
      const job=this.#get(t.partition,'execution_job',id);
      if(!job || job.attemptId!==attemptId)denied();
      const packet=this.#get(t.partition,'context',job.packetId);
      if(packet.contentHash!==binding.packetHash)fail('conflict','提交背景与已授权说明不一致。','核对原任务，不重新提交。','lookup_operation');
      const previous=this.#get(t.partition,'remote_submission',id);
      if(previous){
        if(previous.attemptId!==attemptId || payloadHash(previous.binding)!==payloadHash(binding))
          fail('conflict','执行连接或提交内容已改变。','核对原连接和任务编号，不向新连接重发。','lookup_operation');
        return {fresh:false,submission:clone(previous)};
      }
      const op=this.#get(t.partition,'operation',id);
      if(op.status!=='running' || !job.claimId || job.leaseExpiresAt<=now())
        fail('conflict','任务没有有效的执行领取。','查询原执行状态，不创建第二次提交。','lookup_operation');
      this.validateFrozenContext(auth,scope,job.packetId);
      const submission={id,attemptId,binding:clone(binding),taskId:null,recordedAt:now(),identifiedAt:null};
      this.#put(t.partition,'remote_submission',submission);
      this.fault?.({method:'reserve_remote_submission',phase:'before_commit'});
      return {fresh:true,submission:clone(submission)};
    });
  }
  bindRemoteTask(auth,scope,id,attemptId,taskId) {
    const t=this.#currentAuth(auth,scope,'execute');
    if(t.kind!=='ui')denied();
    if(typeof taskId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(taskId))
      fail('validation_failed','远端任务编号无效。','核对原服务回执，不重复提交。','lookup_operation');
    return this.#transaction(()=>{
      this.#currentAuth(auth,scope,'execute');
      const submission=this.#get(t.partition,'remote_submission',id);
      if(!submission || submission.attemptId!==attemptId)denied();
      if(submission.taskId!==null && submission.taskId!==taskId)
        fail('conflict','这次执行已有其他远端任务编号。','保留原编号并核对回执。','lookup_operation');
      if(submission.taskId===null){submission.taskId=taskId;submission.identifiedAt=now();this.#replace(t.partition,'remote_submission',submission);}
      this.fault?.({method:'bind_remote_task',phase:'before_commit'});
      return clone(submission);
    });
  }
  flushExecutionReceipt(auth,scope,id) {
    const t=this.#currentAuth(auth,scope,'execute');
    return this.#transaction(() => {
      const job=this.#get(t.partition,'execution_job',id),op=this.#get(t.partition,'operation',id);
      if(!job || !job.receiptId)fail('conflict','尚无完整执行回执。','先查原执行结果，不要重跑。','lookup_operation');
      if(op.writebackStatus==='saved')return this.executionState(auth,scope,id);
      const receipt=this.#get(t.partition,'execution_receipt',job.receiptId),input=receipt.result;
      if(receipt.operationId!==id || receipt.payloadHash!==payloadHash({status:receipt.status,result:input}) || input.attemptId!==job.attemptId)
        fail('conflict','保存的执行回执与指纹不一致。','保留原记录并核对执行器，不重跑。','lookup_operation');
      // actorId identifies this writeback recorder, not the original execution authorizer.
      const normalized=validateWire('ResultRevision',{...clone(input),artifacts:input.artifacts.map(a=>({...a,verification:'reported'})),
        id:randomUUID(),revision:1,payloadHash:payloadHash(input),actorId:t.actorId,recordedAt:receipt.recordedAt,trust:'platform_receipt'});
      // A direct executor completion is not an independent business check or human acceptance.
      this.#put(t.partition,'result',normalized,payloadHash({runId:job.runId,provider:input.provider,eventId:input.eventId}));
      this.#put(t.partition,'raw_result',{id:normalized.id,input:clone(input)});
      const run=this.#get(t.partition,'run',job.runId),attempt=this.#get(t.partition,'attempt',job.attemptId);
      attempt.resultRevisionIds.push(normalized.id);run.writebackStatus='saved';op.writebackStatus='saved';op.resultId=normalized.id;op.error=null;
      for(const [kind,value] of [['run',run],['attempt',attempt],['operation',op]])this.#replace(t.partition,kind,value);
      this.#db.prepare('UPDATE scopes SET state_revision=state_revision+1 WHERE partition=?').run(t.partition);
      for(const row of this.#db.prepare('SELECT id,payload_json FROM outbox WHERE partition=? AND kind=? AND status=?').all(t.partition,'execution_writeback','pending')) {
        if(JSON.parse(row.payload_json).operationId===id)this.#db.prepare('UPDATE outbox SET status=? WHERE id=?').run('saved',row.id);
      }
      this.#db.prepare('INSERT INTO outbox VALUES (?,?,?,?,?,?)').run(randomUUID(),t.partition,'memory_changed',JSON.stringify({operationId:id,stateRevision:this.#row(t.partition).state_revision}),'pending',now());
      this.fault?.({method:'flush_execution_receipt',phase:'before_commit'});
      return this.executionState(auth,scope,id);
    });
  }
  // Separately verified bytes do not rewrite immutable host reports or certify
  // business acceptance. Public paths/URIs are never dereferenced automatically.
  saveArtifactFile(auth,scope,resultId,artifact,bytes) {
    const t=this.#currentAuth(auth,scope,'review_memory');if(t.kind!=='ui')denied();
    bytes=Buffer.from(bytes);validateWire('Artifact',artifact);
    if(bytes.length>64*1024*1024)fail('validation_failed','成果文件超过保存限制。','选择64 MB以内的文件，或拆分后核对。');
    return this.#transaction(()=>{
      this.#currentAuth(auth,scope,'review_memory');
      const result=this.#get(t.partition,'result',resultId),reported=result?.artifacts.find(a=>a.id===artifact.id);
      if(!reported||payloadHash(reported)!==payloadHash(artifact)||sha256(bytes)!==artifact.sha256||bytes.length!==artifact.byteLength)fail('conflict','文件与原成果回执不一致。','核对对应原文件，不修改旧回执。');
      const id=payloadHash({resultId,artifactId:artifact.id}),prior=this.#get(t.partition,'artifact_file',id);
      if(prior)return clone(prior);
      this.#db.prepare('INSERT OR IGNORE INTO raw_blobs VALUES (?,?,?)').run(t.ownerId,artifact.sha256,bytes);
      const receipt={id,resultId,artifactId:artifact.id,sha256:artifact.sha256,byteLength:bytes.length,name:artifact.name,mediaType:artifact.mediaType,verifiedAt:now(),method:'sha256_and_length',verifiedBy:t.actorId};
      this.#put(t.partition,'artifact_file',receipt);return clone(receipt);
    });
  }
  artifactFile(auth,scope,resultId,artifactId) {
    const t=this.#currentAuth(auth,scope,'read_memory'),receipt=this.#get(t.partition,'artifact_file',payloadHash({resultId,artifactId}));
    if(!receipt)fail('capability_unavailable','这个成果的原文件尚未接回。','请先选择原文件核对；工具自述不等于可下载成果。');
    const row=this.#db.prepare('SELECT bytes FROM raw_blobs WHERE owner_id=? AND sha256=?').get(t.ownerId,receipt.sha256);
    if(!row||sha256(row.bytes)!==receipt.sha256||row.bytes.length!==receipt.byteLength)fail('conflict','保存的成果文件校验未通过。','保留原记录并核对文件，不重新执行任务。');
    return {receipt:clone(receipt),bytes:Buffer.from(row.bytes)};
  }
  resultVersions(auth,scope,resultId){
    const t=this.#currentAuth(auth,scope,'read_memory');if(t.kind!=='ui')denied();
    return this.#transaction(()=>{
      if(!this.#get(t.partition,'result',resultId))denied();
      // Real receipt revision or an explicit previous-result task binding only.
      // Similar filenames, timestamps and adjacent tasks never form a lineage.
      const rows=this.#db.prepare(`WITH RECURSIVE edges(before_id,after_id) AS (
        SELECT json_extract(body_json,'$.supersedesResultId'),id FROM records
          WHERE partition=? AND kind='result' AND json_extract(body_json,'$.supersedesResultId') IS NOT NULL
        UNION SELECT json_extract(s.body_json,'$.previousResultId'),r.id FROM records s
          JOIN records a ON a.partition=s.partition AND a.kind='attempt' AND json_extract(a.body_json,'$.runId')=json_extract(s.body_json,'$.runId')
          JOIN records r ON r.partition=s.partition AND r.kind='result' AND json_extract(r.body_json,'$.attemptId')=a.id
          WHERE s.partition=? AND s.kind='task_step' AND json_extract(s.body_json,'$.previousResultId') IS NOT NULL
      ), related(id) AS (
        SELECT ? UNION SELECT e.after_id FROM edges e JOIN related n ON e.before_id=n.id
        UNION SELECT e.before_id FROM edges e JOIN related n ON e.after_id=n.id
      ) SELECT r.body_json,count(*) OVER() AS total FROM records r JOIN related n ON r.id=n.id
        WHERE r.partition=? AND r.kind='result' ORDER BY r.rowid DESC LIMIT 51`).all(t.partition,t.partition,resultId,t.partition);
      const chosen=this.#get(t.partition,'result',resultId),total=rows[0]?.total??0;
      let versions=rows.slice(0,50).map(r=>JSON.parse(r.body_json));
      if(!versions.some(r=>r.id===resultId))versions=[...versions.slice(0,49),chosen];
      return {selectedResultId:resultId,versionCount:total,complete:total<=50,versions:versions.map(r=>({id:r.id,runId:this.#get(t.partition,'attempt',r.attemptId)?.runId??null,recordedAt:r.recordedAt,summary:r.summary,artifacts:r.artifacts.map(a=>({...a,saved:!!this.#get(t.partition,'artifact_file',payloadHash({resultId:r.id,artifactId:a.id}))}))}))};
    });
  }
  adoptTaskResult(auth,request){
    validateResultAdoption(request);if(this.#currentAuth(auth,request.scope,'review_memory').kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'adopt_task_result',{...request,expectedStateRevision:0},requestMeta(request),'review_memory',false,(t,id)=>{
      const plan=this.taskPlan(auth,request.scope,request.planId),{node,result,run,inputRefs}=resultAdoption(plan,request,(kind,key)=>this.#get(t.partition,kind,key));
      // Verify the actual bytes again. Adoption is a local selection, not a
      // new execution, new receipt, acceptance or a file-copy operation.
      for(const a of result.artifacts)this.artifactFile(auth,request.scope,result.id,a.id);
      const prior=this.#list(t.partition,'result_review').findLast(r=>r.resultId===result.id);
      const value={id,planId:plan.id,nodeId:node.id,resultId:result.id,runId:run.id,resultHash:result.payloadHash,
        previousResultId:node.resultId,generation:node.generation,inputRefs:clone(inputRefs),priorReviewId:prior?.id??null,
        supersedesSelectionId:node.resultSelection?.id??null,note:request.note.trim(),actorId:t.actorId,createdAt:now()};
      this.#put(t.partition,'task_result_selection',value);return {value};
    });
  }
  reviewResult(auth,request){
    const keys=['protocolVersion','scope','requestId','expectedStateRevision','resultId','status','note'];
    if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION||typeof request.resultId!=='string'||!['passed','needs_revision','blocked'].includes(request.status)||typeof request.note!=='string'||!request.note.trim()||request.note.length>8000)fail('validation_failed','请写清成果核对结论和依据。','选择符合需求、需要修改或暂时做不到，并说明具体原因。');
    const trusted=this.#currentAuth(auth,request.scope,'review_memory');if(trusted.kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'review_result',{resultId:request.resultId,status:request.status,note:request.note},{requestId:request.requestId,expectedStateRevision:request.expectedStateRevision},'review_memory',true,t=>{
      const result=this.#get(t.partition,'result',request.resultId);if(!result)denied();
      const attempt=this.#list(t.partition,'attempt').find(a=>a.resultRevisionIds.includes(result.id)),run=attempt&&this.#get(t.partition,'run',attempt.runId),packet=run&&this.#get(t.partition,'context',run.contextPacketId);
      if(!packet)denied();
      if(request.status==='passed'&&result.artifacts.some(a=>!this.#get(t.partition,'artifact_file',payloadHash({resultId:result.id,artifactId:a.id}))))fail('validation_failed','先接回并核对成果文件，再确认内容符合需求。','下载或选择对应的原文件，确认文件和验收条件。');
      const prior=this.#list(t.partition,'result_review').filter(r=>r.resultId===result.id).at(-1);
      const review={id:randomUUID(),resultId:result.id,resultHash:result.payloadHash,contextPacketId:packet.id,contextHash:packet.contentHash,acceptanceCriteria:clone(packet.acceptanceCriteria),status:request.status,note:request.note,actorId:t.actorId,recordedAt:now(),supersedesReviewId:prior?.id??null};
      // Human acceptance is append-only and bound to a specific result and goal.
      // It never rewrites the host receipt, certifies future runs or auto-confirms a lesson.
      this.#put(t.partition,'result_review',review);return {value:review};
    });
  }
  proposeResultLesson(auth,request){
    const keys=['protocolVersion','scope','requestId','expectedStateRevision','resultId','body','condition'];
    if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION||typeof request.resultId!=='string'||typeof request.body!=='string'||!request.body.trim()||request.body.length>32000||typeof request.condition!=='string'||!request.condition.trim()||request.condition.length>8000)fail('validation_failed','请写清经验和使用条件。','说明从这次工作学到什么，下次什么情况可以借鉴。');
    const trusted=this.#currentAuth(auth,request.scope,'review_memory');if(trusted.kind!=='ui')denied();
    return this.#mutate(auth,request.scope,'result_lesson',{resultId:request.resultId,body:request.body,condition:request.condition},{requestId:request.requestId,expectedStateRevision:request.expectedStateRevision},'review_memory',true,t=>{
      const result=this.#get(t.partition,'result',request.resultId);if(!result)denied();
      // The immutable tool report becomes a traceable source, not a certified
      // business fact. The user supplies the lesson and its applicability.
      const text=result.summary,bytes=Buffer.from(text),source=this.#saveSource(t,bytes,'text/plain');
      let link=this.#get(t.partition,'result_source_link',result.id),parsed,occurrence;
      if(link){parsed=this.#get(t.partition,'parsed',link.parsedRevisionId);occurrence=this.#get(t.partition,'occurrence',link.occurrenceId);}
      else{
        const block={id:'block:'+payloadHash({resultId:result.id,text}),text,rawStartByte:0,rawEndByte:bytes.length};
        parsed=validateWire('ParsedRevision',{id:randomUUID(),sourceId:source.id,parserVersion:'synplex.result-receipt/1',normalizedTextHash:payloadHash([text]),blocks:[block],coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]},recordedAt:now()});this.#put(t.partition,'parsed',parsed);
        occurrence=validateWire('Occurrence',{id:randomUUID(),scope:clone(request.scope),sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:'synplex-result-receipt',formatVersion:'1',sessionId:null,eventId:'result:'+result.id,seq:null,importOrigin:'user_paste',occurredAt:result.occurredAt,recordedAt:now(),payloadHash:source.sha256});this.#put(t.partition,'occurrence',occurrence);
        link={id:result.id,sourceId:source.id,parsedRevisionId:parsed.id,occurrenceId:occurrence.id};this.#put(t.partition,'result_source_link',link);
      }
      const block=parsed.blocks[0],evidence={sourceId:source.id,parsedRevisionId:parsed.id,occurrenceId:occurrence.id,blockId:block.id,start:0,end:text.length,offsetUnit:'utf16_code_unit',quote:text,quoteHash:source.sha256};this.#checkEvidence(t,evidence);
      const claim=validateWire('Claim',{id:randomUUID(),type:'lesson',title:request.body.trim().split('\n')[0].slice(0,80),body:request.body,evidenceKind:'historical_tool_text',evidence:[evidence],occurredAt:result.occurredAt,supersedes:[],condition:request.condition,lifecycle:'active',reviewStatus:'pending',recordedAt:now(),effectiveFrom:null,effectiveUntil:null,actorId:t.actorId});this.#put(t.partition,'claim',claim);
      return {value:claim,changed:true};
    });
  }
  pendingOutbox(auth, scope) { const t = this.#currentAuth(auth, scope, 'read_memory'); return this.#db.prepare('SELECT id,kind,payload_json FROM outbox WHERE partition=? AND status=?').all(t.partition, 'pending').map(r => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload_json) })); }
  acknowledgeOutbox(auth, scope, id) { const t = this.#currentAuth(auth, scope, 'write_memory'); return this.#db.prepare('UPDATE outbox SET status=? WHERE partition=? AND id=? AND kind=?').run('saved', t.partition, id, 'memory_changed').changes; }
}

export class ScopedRepository {
  #repository;
  #auth;
  constructor(repository, auth, scope) { this.#repository = repository; this.#auth = auth; this.scope = Object.freeze(scope); Object.freeze(this); }
  async getState() { return this.#repository.state(this.#auth, this.scope); }
  async getClaimJourney(id) { return this.#repository.claimDetail(this.#auth,this.scope,id); }
  async taskConflicts(selectedOccurrenceIds) { return this.#repository.taskConflicts(this.#auth, this.scope, selectedOccurrenceIds); }
  async saveBlob(input, meta) { return this.#repository.saveBlob(this.#auth, this.scope, input, meta); }
  async getBlob(id) { return this.#repository.getBlob(this.#auth, this.scope, id); }
  async getSourceMetadata(id) { return this.#repository.sourceMetadata(this.#auth, this.scope, id); }
  async appendParsedRevisions(input, meta) { return this.#repository.appendParsed(this.#auth, this.scope, input, meta); }
  async appendOccurrences(input, meta) { return this.#repository.appendOccurrences(this.#auth, this.scope, input, meta); }
  async appendCandidates(input, meta) { return this.#repository.appendCandidates(this.#auth, this.scope, input, meta); }
  async queryEvidence(query) { return this.#repository.query(this.#auth, this.scope, query); }
  async listOccurrences(query) { return this.#repository.listOccurrences(this.#auth, this.scope, query); }
  async getChunkCheckpoint(key) { return this.#repository.list(this.#auth, this.scope, 'checkpoint').find(x => x.cacheKey === key) ?? null; }
  async saveChunkCheckpoint(value, meta) { return this.#repository.checkpoint(this.#auth, this.scope, value, meta); }
  async getOperation(id) { return this.#repository.operation(this.#auth, this.scope, id); }
  async getImportResult(id) { return this.#repository.importResult(this.#auth, this.scope, id); }
}
