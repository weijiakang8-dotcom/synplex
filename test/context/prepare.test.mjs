import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareContext } from '../../packages/context/index.mjs';
import {chatBackground} from '../../services/workspace/chat-service.mjs';
import { importSource } from '../../packages/ingestion/index.mjs';
import { PROTOCOL_VERSION, payloadHash } from '../../packages/contracts/validate.mjs';
import { setup, input, meta, scope, wrap, errorIs } from '../ingestion/helpers.mjs';
const options={reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1'};
const request=async(repo,extra={})=>({protocolVersion:PROTOCOL_VERSION,scope,...await meta(repo),goal:'  保留失败过程并继续项目🧪  ',
  constraints:['不能重复已完成工作'],acceptanceCriteria:['提供有出处的说明'],mode:'host_assist',executor:'current_host',
  selectedOccurrenceIds:[],maxInputTokens:24000,...extra});

test('selected sources and late rejected history cannot silently become current facts',async t=>{
  const h=await setup(t),a=await importSource(h.repo,input('旧方案失败，不能再次采用。'),await meta(h.repo));
  const b=await importSource(h.repo,input('另一个方向决定采用。'),await meta(h.repo));
  const rejected=(await h.repo.getState()).pending.find(c=>c.evidence[0].occurrenceId===a.occurrences[0].id);
  const review={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:rejected.id,reviewStatus:'rejected'};
  const {authorizationId}=h.repository.issueReviewAuthorization(h.auth,review);h.repository.review(h.auth,{...review,authorizationId});
  const req=await request(h.repo,{selectedOccurrenceIds:[a.occurrences[0].id]}),packet=await prepareContext(h.repo,req,options);
  assert.deepEqual(packet.facts,[]);assert.deepEqual(packet.candidates,[]);
  assert.ok(packet.evidence.some(e=>e.occurrenceId===a.occurrences[0].id));
  assert.ok(packet.unknowns.some(x=>x.includes(rejected.id)&&x.includes('rejected')));
  assert.equal(packet.evidence.some(e=>e.occurrenceId===b.occurrences[0].id),false);
  assert.equal(packet.goal,req.goal);assert.deepEqual(packet.constraints,req.constraints);
  const {contentHash,...content}=packet;assert.equal(contentHash,payloadHash(content));
});

test('too-small budgets reject rather than truncate goals, constraints or confirmed facts',async t=>{
  const h=await setup(t),req=await request(h.repo,{goal:'必须逐字保留的目标'.repeat(100),maxInputTokens:1000});
  const before=await h.repo.getState();
  await assert.rejects(prepareContext(h.repo,req,options),errorIs('budget_exceeded'));
  assert.equal(req.goal,'必须逐字保留的目标'.repeat(100));assert.deepEqual(await h.repo.getState(),before);
  assert.equal(h.repository.list(h.auth,scope,'context').length,0);
});

test('optional long material is omitted whole with an explicit coverage gap and no writes',async t=>{
  const h=await setup(t);await importSource(h.repo,input('旧方案失败。'+ '保留原始内容🧪'.repeat(2000)),await meta(h.repo));
  const before=await h.repo.getState(),req=await request(h.repo,{maxInputTokens:8000});
  const packet=await prepareContext(h.repo,req,options);
  assert.equal(packet.coverage,'partial');assert.ok(packet.unknowns.some(x=>x.includes('未加入')));
  assert.ok(packet.budget.estimatedTokens+packet.budget.reservedTokens<=packet.budget.maxInputTokens);
  for(const c of packet.candidates)assert.deepEqual(c,before.pending.find(original=>original.id===c.id));
  assert.deepEqual(await h.repo.getState(),before);
});

test('scope, selected source, revision and end-of-read revocation are rechecked',async t=>{
  const h=await setup(t),req=await request(h.repo);
  await assert.rejects(prepareContext(h.repo,{...req,selectedOccurrenceIds:['foreign']},options),errorIs('scope_denied'));
  await assert.rejects(prepareContext(h.repo,{...req,scope:{...scope,versionId:null}},options),errorIs('validation_failed'));
  await assert.rejects(prepareContext(h.repo,{...req,expectedStateRevision:999},options),errorIs('stale_context'));
  let count=0;
  const revoked=wrap(h.repo,{getState:async()=>{if(++count===3)h.repository.revokeCredential(h.credential.id);return h.repo.getState();}});
  await assert.rejects(prepareContext(revoked,req,options),errorIs('scope_denied'));
});

test('task relevance omits unrelated confirmed facts whole, keeps decisions and failures, and never deletes history',async t=>{
 const h=await setup(t);
 for(const [type,body] of [['fact','Python脚本的导出格式为CSV。'],['fact','禁止上传客户资料。'],['fact','民宿房间有阳台。'.repeat(1000)],['decision','所有外发资料都要先核对。'],['failure','自动付款曾出现风险，不能重复执行。'],['lesson','Python脚本应检查编码。']]){
  const imported=await importSource(h.repo,input(body),await meta(h.repo));
  const evidence=(await h.repo.getState()).pending.find(c=>c.evidence[0]?.sourceId===imported.source.id).evidence;
  const claim=(await h.repo.appendCandidates([{type,title:'合成核对记录',body,evidenceKind:'user_statement',evidence,occurredAt:null,supersedes:[],condition:type==='lesson'?'导出Python数据时适用':null}],await meta(h.repo))).value[0];
  const req={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:claim.id,reviewStatus:'confirmed'};
  const {authorizationId}=h.repository.issueReviewAuthorization(h.auth,req);h.repository.review(h.auth,{...req,authorizationId});
 }
 const before=await h.repo.getState(),packet=await prepareContext(h.repo,await request(h.repo,{goal:'编写Python导出脚本',constraints:['不外发'],acceptanceCriteria:['交付CSV'],maxInputTokens:10000}),options);
 assert.ok(packet.budget.estimatedTokens+packet.budget.reservedTokens<=10000);
 assert.equal(packet.candidates.some(c=>c.body.includes('阳台')),false);
 assert.equal(packet.facts.length,3);assert.equal(packet.failures.length,1);assert.equal(packet.lessons.length,1);
 assert.ok(packet.unknowns.some(x=>x.includes('1条未匹配')));assert.equal(packet.coverage,'partial');
 assert.equal(packet.facts.some(c=>c.body.includes('阳台')),false);assert.deepEqual(await h.repo.getState(),before);
 assert.deepEqual(packet.lessons[0].condition,'导出Python数据时适用');
 const tight=await prepareContext(h.repo,await request(h.repo,{goal:'编写Python导出脚本',constraints:['不外发'],acceptanceCriteria:['交付CSV'],maxInputTokens:9000}),options);
 assert.ok(tight.budget.estimatedTokens+tight.budget.reservedTokens<=9000);
 assert.deepEqual(tight.facts,packet.facts);assert.deepEqual(tight.failures,packet.failures);
 const selected=before.facts.find(c=>c.body.includes('Python')).evidence[0].occurrenceId;
 const explicit=await prepareContext(h.repo,await request(h.repo,{goal:'编写Python',selectedOccurrenceIds:[selected],maxInputTokens:8000}),options);
 assert.ok(explicit.facts.some(c=>c.body.includes('禁止上传')));assert.equal(explicit.failures.length,1);assert.ok(explicit.facts.some(c=>c.type==='decision'));
 assert.deepEqual(await h.repo.getState(),before);
});

test('explicit turning-point reasons and old evidence enter the next task as history, never as current facts',async t=>{
 const h=await setup(t),imported=await importSource(h.repo,input('决定：项目先使用全部记录作为背景。'),await meta(h.repo));
 const first=(await h.repo.getState()).pending.find(c=>c.evidence[0].sourceId===imported.source.id);
 const confirm=async claim=>{const review={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:claim.id,reviewStatus:'confirmed'};const grant=h.repository.issueReviewAuthorization(h.auth,review);h.repository.review(h.auth,{...review,authorizationId:grant.authorizationId});};
 await confirm(first);
 const old=h.repository.claimDetail(h.auth,scope,first.id).claim;
 const edited=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:old.id,expectedClaimHash:payloadHash(old),draft:{title:'筛选相关背景',body:'决定：项目改为只带相关背景，原记录保留。',type:'decision',condition:'个人项目继续工作时'},note:'全量会话太长，关键决定被无关资料淹没。'}).value;
 await confirm(edited);
 const before=await h.repo.getState(),packet=await prepareContext(h.repo,await request(h.repo,{goal:'继续项目，说明为什么筛选背景'}),options);
 assert.ok(packet.unknowns.some(x=>x.includes('全量会话太长，关键决定被无关资料淹没。')&&x.includes(old.id)&&x.includes(edited.id)));
 assert.equal(packet.facts.some(c=>c.id===old.id),false);assert.ok(packet.facts.some(c=>c.id===edited.id));
 assert.ok(packet.evidence.some(e=>e.sourceId===old.evidence[0].sourceId));assert.deepEqual(await h.repo.getState(),before);
 const tight=await prepareContext(h.repo,await request(h.repo,{goal:'继续项目',maxInputTokens:8000}),options);assert.ok(tight.budget.estimatedTokens+tight.budget.reservedTokens<=8000);
 const chatInput={scope,requestId:'history-chat',content:'继续项目，为什么筛选背景',excludedClaimIds:[]};
 const chat=await chatBackground(h.repository,h.auth,chatInput,24000);assert.ok(chat.unknowns.some(x=>x.includes('全量会话太长，关键决定被无关资料淹没。')));assert.ok(chat.evidence.some(e=>e.sourceId===old.evidence[0].sourceId));
 const excluded=await chatBackground(h.repository,h.auth,{...chatInput,excludedClaimIds:[edited.id]},24000);assert.equal(excluded.facts.some(c=>c.id===edited.id),false);assert.equal(excluded.unknowns.some(x=>x.includes('全量会话太长，关键决定被无关资料淹没。')),false);assert.deepEqual(await h.repo.getState(),before);
});
