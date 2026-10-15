import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { PROTOCOL_VERSION, sha256, payloadHash, validateWire } from '../../packages/contracts/validate.mjs';

const scope = { projectId: 'test-project', versionId: 'v2', branchId: null };
const caps = ['read_memory','write_memory','prepare_task','record_result'];
const usage = { observationScope: 'host_unavailable', provider: null, model: null, inputTokens: null, outputTokens: null,
  cachedInputTokens: null, costUsd: null, pricingRevision: null, provenance: 'unknown' };
const errorIs = code => e => e.code === code;
function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'synplex-repo-'));
  const repository = new WorkspaceRepository({ dataDir });
  t.after(() => { try { repository.close(); } catch {} rmSync(dataDir, { recursive: true, force: true }); });
  const credential = repository.createCredential({ ownerId: 'owner', actorId: 'host-a', scope, capabilities: caps });
  const auth = repository.authenticate(credential.token);
  return { dataDir, repository, credential, auth };
}
const meta = async repo => ({ requestId: randomUUID(), expectedStateRevision: (await repo.getState()).stateRevision });
async function putText(repo, text = '旧方案被否决。V2只处理相关背景，emoji 🧪。search_knowledge') {
  const saved = await repo.saveBlob({ bytes: Buffer.from(text), format: 'text/markdown' }, await meta(repo));
  const source = saved.value;
  const parsed = (await repo.appendParsedRevisions([{ sourceId: source.id, parserVersion: 'test/1',
    normalizedTextHash: sha256(Buffer.from(text)), blocks: [{ id: 'block-1', text, rawStartByte: 0, rawEndByte: Buffer.byteLength(text) }],
    coverage: { status: 'complete', coveredBytes: source.byteLength, totalBytes: source.byteLength, gaps: [] } }], await meta(repo))).value[0];
  const occurrenceInput = { sourceId: source.id, parsedRevisionId: parsed.id, externalSystem: 'synthetic-test', formatVersion: '1',
    sessionId: 'session', eventId: randomUUID(), seq: 0, importOrigin: 'isolated_test', occurredAt: null, payloadHash: sha256(Buffer.from(text)) };
  const occurrence = (await repo.appendOccurrences([occurrenceInput], await meta(repo))).value[0];
  const span = { sourceId: source.id, parsedRevisionId: parsed.id, occurrenceId: occurrence.id, blockId: 'block-1',
    start: 0, end: text.length, offsetUnit: 'utf16_code_unit', quote: text, quoteHash: sha256(Buffer.from(text)) };
  return { source, parsed, occurrence, occurrenceInput, span, text };
}
function candidate(span, extra = {}) {
  return { type: 'decision', title: '保留V2', body: '先保证质量，再比较费用。', evidenceKind: 'user_statement', evidence: [span],
    occurredAt: null, supersedes: [], condition: null, ...extra };
}
async function review(repository, auth, claim, status, repo) {
  const request = { protocolVersion: PROTOCOL_VERSION, scope, ...(await meta(repo)), claimId: claim.id, reviewStatus: status };
  const { authorizationId } = repository.issueReviewAuthorization(auth, request);
  return repository.review(auth, { ...request, authorizationId });
}
async function prepare(repository, auth, repo, extra = {}) {
  const state = await repo.getState();
  const request = { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), scope,
    expectedStateRevision: state.stateRevision, goal: '整理一份项目说明', constraints: ['不读取密钥'], acceptanceCriteria: ['保留已否决方案'],
    mode: 'host_assist', executor: 'current_host', selectedOccurrenceIds: [], maxInputTokens: 2000, ...extra };
  const packet = { id: randomUUID(), protocolVersion: PROTOCOL_VERSION, scope, stateRevision: state.stateRevision,
    permissionRevision: state.permissionRevision, goal: request.goal, constraints: request.constraints, acceptanceCriteria: request.acceptanceCriteria,
    facts: state.facts, failures: state.failures, lessons: state.lessons, candidates: state.pending, conflicts: state.conflicts,
    unknowns: state.unknowns, evidence: state.pending.flatMap(x => x.evidence), selectedOccurrenceIds: request.selectedOccurrenceIds,
    coverage: 'complete', budget: { maxInputTokens: request.maxInputTokens, reservedTokens: 100, estimatedTokens: 500, estimatorVersion: 'test/1' }, createdAt: new Date().toISOString() };
  packet.contentHash = payloadHash(packet);
  return { request, packet, reply: repository.registerPrepared(auth, request, packet) };
}

test('exact owner/project/version/branch scope is enforced, including null and forged auth', async t => {
  const { repository, auth } = setup(t), repo = await repository.forScope(auth, scope);
  const { source } = await putText(repo);
  for (const wrong of [{...scope,projectId:'other'}, {...scope,versionId:null}, {...scope,branchId:'main'}]) {
    await assert.rejects(repository.forScope(auth, wrong), errorIs('scope_denied'));
  }
  await assert.rejects(repository.forScope({ ...auth }, scope), errorIs('scope_denied'));
  const other = repository.createCredential({ ownerId: 'someone', actorId:'host-a', scope, capabilities:caps });
  const otherRepo = await repository.forScope(repository.authenticate(other.token), scope);
  await assert.rejects(otherRepo.getBlob(source.id), errorIs('scope_denied'));
  assert.equal(repo.repository, undefined); assert.equal(repo.auth, undefined);
});

test('revocation invalidates already-created scoped repositories and frozen context', async t => {
  const { repository, auth, credential } = setup(t), repo = await repository.forScope(auth, scope);
  await prepare(repository, auth, repo);
  auth.capabilities.add('review_memory');
  assert.throws(() => repository.issueReviewAuthorization(auth, {protocolVersion:PROTOCOL_VERSION,scope,requestId:'fake',expectedStateRevision:0,claimId:'fake',reviewStatus:'confirmed'}), errorIs('scope_denied'));
  repository.revokeCredential(credential.id);
  await assert.rejects(repo.getState(), errorIs('scope_denied'));
  assert.throws(() => repository.authenticate(credential.token), errorIs('scope_denied'));
});

test('duplicate mutation returns original receipt before revision check; changed input conflicts', async t => {
  const { repository, auth } = setup(t), repo = await repository.forScope(auth, scope), text = await putText(repo);
  const m = await meta(repo), input = [candidate(text.span)];
  const first = await repo.appendCandidates(input, m), second = await repo.appendCandidates(input, m);
  assert.equal(second.duplicate, true); assert.equal(second.operationId, first.operationId);
  assert.equal(second.value[0].id, first.value[0].id);
  assert.equal((await repo.getState()).stateRevision, first.stateRevision);
  await assert.rejects(repo.appendCandidates([candidate(text.span,{body:'另一个内容'})],m), errorIs('conflict'));
});

test('concurrent independent SQLite writers produce one mutation and the same receipt', async t => {
  const { repository, auth, credential, dataDir } = setup(t), repo = await repository.forScope(auth, scope);
  const script = `import {WorkspaceRepository} from ${JSON.stringify(new URL('../../services/workspace/repository.mjs',import.meta.url).href)};
let s='';for await(const b of process.stdin)s+=b;const i=JSON.parse(s);const r=new WorkspaceRepository({dataDir:i.dataDir});
try { const p=await r.forScope(r.authenticate(i.token),i.scope);const a=await p.appendCandidates([i.candidate],i.meta);console.log(JSON.stringify({id:a.value[0].id,duplicate:a.duplicate})); }finally{r.close()}`;
  const input = {dataDir,token:credential.token,scope,candidate:{type:'unknown',title:'未知',body:'缺原始日志',evidenceKind:'user_statement',evidence:[],occurredAt:null,supersedes:[],condition:null},meta:{requestId:'simultaneous',expectedStateRevision:0}};
  const run = () => new Promise((resolve,reject) => {
    const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let out='',err='';
    p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',c=>c===0?resolve(JSON.parse(out)):reject(new Error(err)));p.stdin.end(JSON.stringify(input));
  });
  const [a,b] = await Promise.all([run(),run()]);
  assert.equal(a.id,b.id);assert.equal(Number(a.duplicate)+Number(b.duplicate),1);
  assert.equal((await repo.getState()).pending.length,1);assert.equal((await repo.getState()).stateRevision,1);
});

test('invalid second item and pre-commit failure roll back rows, revision, receipt and outbox', async t => {
  const { repository, auth } = setup(t), repo = await repository.forScope(auth, scope), input = await putText(repo);
  const before = await repo.getState(), pending = repository.pendingOutbox(auth,scope).length;
  await assert.rejects(repo.appendCandidates([candidate(input.span),candidate({...input.span,quote:'伪造'})],await meta(repo)),errorIs('conflict'));
  assert.deepEqual(await repo.getState(),before);assert.equal(repository.pendingOutbox(auth,scope).length,pending);
  const m = await meta(repo);repository.fault = ({method}) => {if(method==='append_candidates')throw new Error('synthetic-crash');};
  await assert.rejects(repo.appendCandidates([candidate(input.span)],m),/synthetic-crash/);
  assert.deepEqual(await repo.getState(),before);repository.fault=null;
  const retried=await repo.appendCandidates([candidate(input.span)],m);assert.equal(retried.duplicate,false);
});

test('same bytes retain separate events, same event changed payload is quarantined without replacing original', async t => {
  const { repository, auth }=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo);
  const source2=await repo.saveBlob({bytes:Buffer.from(input.text),format:'text/markdown'},await meta(repo));assert.equal(source2.value.id,input.source.id);
  await repo.appendOccurrences([{...input.occurrenceInput,eventId:'different-event'}],await meta(repo));
  const repeated=await repo.appendOccurrences([input.occurrenceInput],await meta(repo));assert.equal(repeated.value[0].id,input.occurrence.id);
  await assert.rejects(repo.appendOccurrences([{...input.occurrenceInput,payloadHash:sha256(Buffer.from('changed'))}],await meta(repo)),errorIs('conflict'));
  const all=await repo.listOccurrences({cursor:null,limit:100});assert.equal(all.items.length,2);
  assert.equal(all.items[0].payloadHash,input.occurrence.payloadHash);assert.equal((await repo.getState()).conflicts.length,1);
  const beforeRepeat=(await repo.getState()).stateRevision;
  await assert.rejects(repo.appendOccurrences([{...input.occurrenceInput,payloadHash:sha256(Buffer.from('changed'))}],await meta(repo)),errorIs('conflict'));
  assert.equal((await repo.getState()).stateRevision,beforeRepeat);
  assert.equal(repository.list(auth,scope,'quarantined_conflict')[0].incoming.eventId,input.occurrenceInput.eventId);
});

test('evidence joins, forged quote and UTF-16 surrogate splitting cannot create a claim', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo);
  for(const span of [{...input.span,sourceId:'other'}, {...input.span,occurrenceId:'other'}, {...input.span,quote:'fake'}])
    await assert.rejects(repo.appendCandidates([candidate(span)],await meta(repo)));
  await assert.rejects(repo.appendCandidates([candidate({...input.span,start:0,end:0,quote:'',quoteHash:sha256(Buffer.from(''))})],await meta(repo)),errorIs('validation_failed'));
  const start=input.text.indexOf('🧪'),half=input.text.slice(start,start+1);
  await assert.rejects(repo.appendCandidates([candidate({...input.span,start,end:start+1,quote:half,quoteHash:sha256(Buffer.from(half))})],await meta(repo)),errorIs('conflict'));
  const full='🧪';await repo.appendCandidates([candidate({...input.span,start,end:start+2,quote:full,quoteHash:sha256(Buffer.from(full))})],await meta(repo));
  assert.equal((await repo.getState()).pending.length,1);
});

test('assistant success remains a pending assistant statement; imports cannot mint independent evidence', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo,'AI说成功，工具实际exit=1。');
  const reply=await repo.appendCandidates([candidate(input.span,{evidenceKind:'assistant_statement'})],await meta(repo));
  assert.equal(reply.value[0].reviewStatus,'pending');assert.equal((await repo.getState()).decisions.length,0);
  await assert.rejects(repo.appendCandidates([candidate(input.span,{evidenceKind:'independent_check'})],await meta(repo)),errorIs('scope_denied'));
});

test('review requires service-bound UI authorization, preserves history and does not promote evidence kind', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo);
  const uiCred=repository.createCredential({ownerId:'owner',actorId:'human',scope,capabilities:[...caps,'review_memory'],kind:'ui'}),ui=repository.authenticate(uiCred.token);
  const old=(await repo.appendCandidates([candidate(input.span,{title:'V1',evidenceKind:'assistant_statement'})],await meta(repo))).value[0];
  assert.throws(()=>repository.review(auth,{protocolVersion:PROTOCOL_VERSION,scope,requestId:'host-review',expectedStateRevision:2,claimId:old.id,reviewStatus:'confirmed',authorizationId:'model-string'}));
  const confirm=await review(repository,ui,old,'confirmed',repo);assert.equal(confirm.value.evidenceKind,'assistant_statement');
  const newer=(await repo.appendCandidates([candidate(input.span,{title:'V2',supersedes:[old.id]})],await meta(repo))).value[0];
  assert.equal((await repo.getState()).decisions[0].id,old.id);
  await review(repository,ui,newer,'confirmed',repo);
  assert.equal((await repo.getState()).decisions[0].id,newer.id);
  const history=await repo.queryEvidence({query:'V2',limit:100,cursor:null,includeHistory:true,occurrenceIds:null});
  assert.ok(history.items.some(x=>x.claim?.id===old.id&&x.claim.lifecycle==='superseded'));
  const staleRequest={protocolVersion:PROTOCOL_VERSION,scope,...(await meta(repo)),claimId:newer.id,reviewStatus:'rejected'};
  const grant=repository.issueReviewAuthorization(ui,staleRequest);
  await repo.appendCandidates([candidate(input.span,{title:'另一项'})],await meta(repo));
  assert.throws(()=>repository.review(ui,{...staleRequest,...grant}),errorIs('validation_failed'));
  assert.throws(()=>repository.review(ui,{...staleRequest,authorizationId:grant.authorizationId}),errorIs('stale_context'));
});

test('short Chinese and exact code identifiers are searchable; cursor cannot cross scope or stale revision', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo);
  await repo.appendOccurrences([{...input.occurrenceInput,eventId:'second'}],await meta(repo));
  for(const query of ['否决','search_knowledge'])assert.equal((await repo.queryEvidence({query,limit:100,cursor:null,includeHistory:false,occurrenceIds:null})).items.length,2);
  const query={query:'V2',limit:1,cursor:null,includeHistory:true,occurrenceIds:null};
  const first=await repo.queryEvidence(query);assert.ok(first.cursor);
  assert.equal((await repo.queryEvidence({...query,cursor:first.cursor})).items.length,1);
  await repo.appendCandidates([candidate(input.span)],await meta(repo));
  await assert.rejects(repo.queryEvidence({...query,cursor:first.cursor}),errorIs('stale_context'));
});

test('retrieval returns a bounded relevant excerpt with valid UTF-16 offsets while full original stays intact',async t=>{
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),text='🧪'.repeat(1200)+'关键否决'+('后文'.repeat(4000)),input=await putText(repo,text);
  const result=await repo.queryEvidence({query:'关键否决',limit:10,cursor:null,includeHistory:false,occurrenceIds:null}),span=result.items[0].span;
  assert.ok(span.quote.includes('关键否决'));assert.ok(span.quote.length<=1026);assert.equal(text.slice(span.start,span.end),span.quote);
  assert.equal(sha256(Buffer.from(span.quote)),span.quoteHash);assert.equal(Buffer.from((await repo.getBlob(input.source.id)).bytes).toString(),text);
});

test('checkpoint survives actual DB reopen and succeeded/unknown chunks cannot be blindly restarted', async t => {
  const {repository,auth,credential,dataDir}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo),state=await repo.getState();
  const checkpoint={id:randomUUID(),sourceId:input.source.id,chunkHash:sha256(Buffer.from(input.text)),cacheKey:sha256(Buffer.from('complete-test-cache')),
    parserVersion:'test/1',ruleVersion:'1',promptVersion:null,model:null,permissionRevision:state.permissionRevision,stateRevision:state.stateRevision,
    status:'succeeded',candidateIds:[],attemptIds:[],usage:{...usage,observationScope:'preparation_only',inputTokens:0,outputTokens:0,cachedInputTokens:0,costUsd:0,provenance:'no_model_call'}};
  await repo.saveChunkCheckpoint(checkpoint,await meta(repo));assert.equal((await repo.getState()).stateRevision,state.stateRevision);
  repository.close();const reopened=new WorkspaceRepository({dataDir});t.after(()=>reopened.close());const other=await reopened.forScope(reopened.authenticate(credential.token),scope);
  assert.deepEqual(await other.getChunkCheckpoint(checkpoint.cacheKey),checkpoint);
  await assert.rejects(other.saveChunkCheckpoint({...checkpoint,status:'pending'},await meta(other)),errorIs('conflict'));
  await assert.rejects(other.saveChunkCheckpoint({...checkpoint,id:randomUUID(),cacheKey:sha256(Buffer.from('unknown')),status:'unknown',usage:{...usage,costUsd:0}},await meta(other)),errorIs('validation_failed'));
});

test('import admits raw bytes atomically, retries read original receipt, terminal snapshot persists across restart', async t => {
  const {repository,auth,credential,dataDir}=setup(t),repo=await repository.forScope(auth,scope),bytes=Buffer.from('完整原文 🧪');
  const request={protocolVersion:PROTOCOL_VERSION,scope,requestId:'import-1',expectedStateRevision:0,format:'text/plain',sourceSystem:'synthetic',formatVersion:'1',sessionId:null,eventId:'event-1',occurredAt:null};
  const first=repository.admitImport(auth,request,bytes),op=first.operationId;
  assert.deepEqual(Buffer.from((await repo.getBlob(first.value.source.id)).bytes),bytes);
  assert.equal((await repo.getImportResult(op)).operation.status,'queued');
  assert.equal(repository.admitImport(auth,{...request,expectedStateRevision:100},bytes).duplicate,true);
  assert.throws(()=>repository.admitImport(auth,request,Buffer.from('changed')),errorIs('conflict'));
  const text=bytes.toString(),parsed=(await repo.appendParsedRevisions([{sourceId:first.value.source.id,parserVersion:'test/1',normalizedTextHash:sha256(bytes),blocks:[{id:'b',text,rawStartByte:0,rawEndByte:bytes.length}],coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]}}],await meta(repo))).value[0];
  const input={parsed,occurrences:[],warnings:[],outcome:'complete',error:null};
  repository.settleImport(auth,scope,op,input);const settled=await repo.getImportResult(op);validateWire('ImportOperationResponse',settled);
  const rev=(await repo.getState()).stateRevision;
  repository.close();const reopened=new WorkspaceRepository({dataDir});t.after(()=>reopened.close());const other=await reopened.forScope(reopened.authenticate(credential.token),scope);
  assert.deepEqual(await other.getImportResult(op),settled);assert.equal((await other.getState()).stateRevision,rev);
  const replay=reopened.admitImport(reopened.authenticate(credential.token),request,bytes);assert.equal(replay.operationId,op);
});

test('import failure/cancellation retains raw original; unknown stops reconciliation without a false result', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope);
  const request={protocolVersion:PROTOCOL_VERSION,scope,requestId:'failed-import',expectedStateRevision:0,format:'text/plain',sourceSystem:'synthetic',formatVersion:'1',sessionId:null,eventId:'event',occurredAt:null};
  const first=repository.admitImport(auth,request,Buffer.from('不能丢的原件'));
  const error={code:'capability_unavailable',message:'解析器暂不可用。',nextAction:'配置支持的解析器。',retry:'after_input',operationId:first.operationId};
  repository.settleImport(auth,scope,first.operationId,{parsed:null,occurrences:[],warnings:[],outcome:'failed',error});
  const result=await repo.getImportResult(first.operationId);assert.equal(result.result.parsed,null);assert.equal(result.operation.status,'failed');
  assert.equal(Buffer.from((await repo.getBlob(first.value.source.id)).bytes).toString(),'不能丢的原件');
  const second=repository.admitImport(auth,{...request,requestId:'unknown-import'},Buffer.from('未知原件'));
  repository.importProgress(auth,scope,second.operationId,'unknown',{...error,retry:'lookup_operation',operationId:second.operationId});
  assert.equal((await repo.getImportResult(second.operationId)).result,null);
  assert.throws(()=>repository.importProgress(auth,scope,second.operationId,'running'),errorIs('conflict'));
});

test('snapshot and terminal pointer commit together, including an injected crash before commit', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),request={protocolVersion:PROTOCOL_VERSION,scope,requestId:'snapshot-crash',expectedStateRevision:0,format:'text/plain',sourceSystem:'synthetic',formatVersion:'1',sessionId:null,eventId:'event',occurredAt:null};
  const admission=repository.admitImport(auth,request,Buffer.from('raw'));
  const input={parsed:null,occurrences:[],warnings:[],outcome:'cancelled',error:null};
  repository.fault=({method})=>{if(method==='settle_import')throw new Error('snapshot-crash')};
  assert.throws(()=>repository.settleImport(auth,scope,admission.operationId,input),/snapshot-crash/);
  const pending=await repo.getImportResult(admission.operationId);assert.equal(pending.operation.status,'queued');assert.equal(pending.result,null);
  repository.fault=null;repository.settleImport(auth,scope,admission.operationId,input);
  assert.equal((await repo.getImportResult(admission.operationId)).result.outcome,'cancelled');
});

test('prepare preserves goal, distinguishes zero preparation from unknown host usage, and never executes', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),p=await prepare(repository,auth,repo);
  assert.equal(p.reply.value.run.status,'prepared');assert.deepEqual(p.reply.value.run.attemptIds,[]);
  assert.equal(p.reply.value.packet.goal,p.request.goal);assert.equal((await repo.getState()).stateRevision,0);
  const changed={...p.packet,goal:'偷改目标'};changed.contentHash=payloadHash(Object.fromEntries(Object.entries(changed).filter(([k])=>k!=='contentHash')));
  assert.throws(()=>repository.registerPrepared(auth,{...p.request,requestId:'different'},changed),errorIs('conflict'));
  assert.equal(repository.list(auth,scope,'attempt').length,0);
});

test('late host result appends after manual changes, preserves failure and never upgrades reported artifact', async t => {
  const {repository,auth}=setup(t),repo=await repository.forScope(auth,scope),input=await putText(repo),p=await prepare(repository,auth,repo);
  await repo.appendCandidates([candidate(input.span)],await meta(repo));
  const req={protocolVersion:PROTOCOL_VERSION,scope,requestId:'result-1',expectedStateRevision:p.request.expectedStateRevision,runId:p.reply.value.run.id,
    result:{eventId:'host-event-1',attemptId:'host-attempt',provider:'codex',summary:'工具失败，未完成。',
      artifacts:[{id:'artifact',name:'report.md',uri:'file:///untrusted/path',sha256:sha256(Buffer.from('fake')),byteLength:4,mediaType:'text/markdown',verification:'hash_verified'}],
      checks:[{id:'check',method:'host_claim',status:'passed',artifactIds:['artifact'],evidence:'host says passed',performedBy:'independent',recordedAt:new Date().toISOString()}],usage,supersedesResultId:null,occurredAt:null}};
  const first=repository.recordResult(auth,req);assert.equal(first.value.result.trust,'host_reported');assert.equal(first.value.result.artifacts[0].verification,'reported');assert.equal(first.value.result.usage.costUsd,null);
  assert.equal((await repo.getState()).pending.length,1);
  assert.equal(repository.recordResult(auth,req).duplicate,true);
  const sameEvent=repository.recordResult(auth,{...req,requestId:'new-req-same-event'});assert.equal(sameEvent.value.result.id,first.value.result.id);
  assert.throws(()=>repository.recordResult(auth,{...req,requestId:'changed-event',result:{...req.result,summary:'changed'}}),errorIs('conflict'));
  const second=repository.recordResult(auth,{...req,requestId:'result-2',result:{...req.result,eventId:'host-event-2',summary:'修订已提交，待核对。',supersedesResultId:first.value.result.id}});
  assert.equal(second.value.result.revision,2);assert.equal(repository.list(auth,scope,'result').length,2);
  const before=repository.list(auth,scope,'attempt').length;
  for(const item of repository.pendingOutbox(auth,scope))repository.acknowledgeOutbox(auth,scope,item.id);
  assert.equal(repository.pendingOutbox(auth,scope).length,0);assert.equal(repository.list(auth,scope,'attempt').length,before);
});
