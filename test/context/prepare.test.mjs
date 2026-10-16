import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareContext } from '../../packages/context/index.mjs';
import {chatBackground} from '../../services/workspace/chat-service.mjs';
import {addSourceEvidence,addConversationEvidence} from '../../packages/context/retrieval.mjs';
import { importSource } from '../../packages/ingestion/index.mjs';
import { PROTOCOL_VERSION, payloadHash } from '../../packages/contracts/validate.mjs';
import { setup, input, meta, scope, wrap, errorIs } from '../ingestion/helpers.mjs';
const options={reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1'};
const request=async(repo,extra={})=>({protocolVersion:PROTOCOL_VERSION,scope,...await meta(repo),goal:'  保留失败过程并继续项目🧪  ',
  constraints:['不能重复已完成工作'],acceptanceCriteria:['提供有出处的说明'],mode:'host_assist',executor:'current_host',
  selectedOccurrenceIds:[],maxInputTokens:24000,...extra});

test('compound why questions retain causal evidence before generic status summaries within a tight allowance',async t=>{
 const h=await setup(t);
 const summary=await importSource(h.repo,input('状态概览：桌面版与移动版已经共享资料，任务成果可用，原件保留。'),await meta(h.repo));
 const reason=await importSource(h.repo,input('选择桌面版是为了离线整理大资料，移动版用于外出查看；两版共同保留出处，但不承诺自动同步。'),await meta(h.repo));
 const other=await importSource(h.repo,input('报表生成失败，原因是表格缺少日期。'),await meta(h.repo));
 const before=await h.repo.getState(),spans=before.pending;
 const hit=(source,title)=>({title,path:title+'.md',span:spans.find(c=>c.evidence[0].sourceId===source.source.id).evidence[0],evidenceRole:'原记录待核对'});
 let causal=false;
 const repo=wrap(h.repo,{retrieveContext:async({terms,occurrenceIds})=>{
  assert.deepEqual(occurrenceIds,[]);
  if(terms.includes('桌面')&&terms.includes('为何')){causal=true;return [hit(summary,'状态概览'),hit(reason,'版本取舍')];}
  return [hit(other,'报表失败'),hit(summary,'状态概览')];
 }});
 const packet={budget:{maxInputTokens:8000},evidence:[],unknowns:[],sourceReferences:[]};
 await addSourceEvidence(repo,packet,'整理实测概览，以及桌面版与移动版为何一起保留。',[],0,p=>p.evidence.length*1000,3000);
 assert.equal(causal,true);assert.equal(packet.evidence.length,1);
 assert.equal(packet.evidence[0].sourceId,reason.source.id);
 assert.ok(packet.sourceReferences.some(r=>r.title==='版本取舍'));
 assert.ok(packet.unknowns.some(s=>s.includes('保留触发条件和边界')));
 assert.deepEqual(await h.repo.getState(),before);
});

test('product introductions retrieve substantive prose; requested code and original metadata remain readable',async t=>{
 const h=await setup(t),text='---\ntype: plan\nstatus: active\ncreated: 2026-10-17\n---\n\n```json\n{"工作台":"项目经历","依据":"代码样例"}\n```\n\n工作台将项目经历与依据放在一起；用户核对成果后，才能决定是否交付。';
 const source=await importSource(h.repo,input(text,{format:'text/markdown',sourceSystem:'user-markdown',sessionId:'项目/测试/工作台介绍.md'}),await meta(h.repo));
 const before=await h.repo.getState(),make=()=>({budget:{maxInputTokens:24000},evidence:[],unknowns:[],sourceReferences:[]});
 const intro=make();await addSourceEvidence(h.repo,intro,'介绍工作台如何工作',[],512,()=>1000);
 assert.ok(intro.evidence.some(e=>e.quote.includes('用户核对成果后')));
 assert.equal(intro.evidence.some(e=>e.quote.includes('代码样例')),false);
 const code=make();await addSourceEvidence(h.repo,code,'工作台JSON代码样例',[],512,()=>1000);
 assert.ok(code.evidence.some(e=>e.quote.includes('代码样例')));
 assert.deepEqual(await h.repo.getState(),before);
 assert.deepEqual(Buffer.from((await h.repo.getBlob(source.source.id)).bytes),Buffer.from(text));
 // A tight allowance can fit either the header or the body, but not both.
 // It must carry the useful passage, never advertise a metadata-only source.
 const bounded=make(),estimate=p=>p.evidence.reduce((sum,e)=>sum+(e.quote.includes('type: plan')?2000:1000),0);
 await addSourceEvidence(h.repo,bounded,'介绍工作台如何工作',[],0,estimate,4500);
 assert.ok(bounded.evidence.some(e=>e.quote.includes('用户核对成果后')));
 assert.equal(bounded.evidence.some(e=>e.quote.includes('type: plan')),false);
 const chat=make(),header={...intro.evidence[0],quote:'---\ntype: note\ncreated: 2026-10-17\n---\n'};
 addConversationEvidence(chat,[header,...bounded.evidence],new Set(),0,estimate,4500);
 assert.ok(chat.evidence.some(e=>e.quote.includes('用户核对成果后')));
 const headerOnly=make();addConversationEvidence(headerOnly,[header],new Set(),0,estimate,4500);
 assert.deepEqual(headerOnly.evidence,[]);
 assert.ok(headerOnly.unknowns.some(s=>s.includes('尚不能作为本次依据')));
});

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

test('execution reserves tool headroom without discarding goals or modifying stored source records',async t=>{
  const h=await setup(t);
  for(let i=0;i<14;i++)await importSource(h.repo,input(`决定：复盘第${i}项需要保留失败和来源。`+'背景说明。'.repeat(100)),await meta(h.repo));
  const before=await h.repo.getState(),req=await request(h.repo,{goal:'复盘失败和来源',mode:'platform_owned',executor:'synplex',maxInputTokens:64000});
  const packet=await prepareContext(h.repo,req,options);
  assert.ok(packet.budget.estimatedTokens+packet.budget.reservedTokens<=24000);
  assert.equal(packet.budget.maxInputTokens,64000);assert.equal(packet.goal,req.goal);
  assert.deepEqual(packet.constraints,req.constraints);assert.deepEqual(packet.acceptanceCriteria,req.acceptanceCriteria);
  assert.ok(packet.unknowns.some(x=>x.includes('工具调用和核对保留容量')));
  assert.deepEqual(await h.repo.getState(),before);
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
  // Snapshot rechecks use revision-only reads; revoke at the end of the first
  // occurrence scan, rather than relying on repeated full state construction.
  const revoked=wrap(h.repo,{getRevision:async()=>{if(++count===2)h.repository.revokeCredential(h.credential.id);return h.repo.getRevision();}});
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

test('原文与近期实测不会被大量未确认摘要挤出背景，摘要仍保留且不自动确认为事实',async t=>{
 const h=await setup(t);
 const old=await importSource(h.repo,input('旧资料：项目复盘曾失败，尚未形成完整链路。'.repeat(120)),await meta(h.repo));
 const original=(await h.repo.getState()).pending[0];
 const claims=Array.from({length:12},(_,i)=>({...original,id:randomUUID(),title:`未确认摘要${i}`,body:'项目复盘实测失败，必须保留过去的限制。'.repeat(90),condition:'模型整理，等待核对',evidenceKind:'historical_tool_text'}));
 const fresh=await importSource(h.repo,input('实测记录：项目完整链路完成初稿和改稿，下载前后版本均有核对；费用未知，旧失败保留。'),await meta(h.repo));
 const newSpan=(await h.repo.getState()).pending.find(c=>c.evidence[0].sourceId===fresh.source.id).evidence[0];
 const sourceRepo=wrap(h.repo,{getContextState:async()=>({...await h.repo.getState(),pending:claims}),retrieveContext:async()=>[{span:newSpan,title:'最新实测记录',path:'项目/测试/最新实测记录.md',evidenceRole:'项目原始记录，仍需核对结论'}]});
 // A previously cited audit is valid history, but is not the new question's
 // best evidence. It must not consume capacity before fresh goal retrieval.
 const chatSpan=original.evidence[0];
 const before=await h.repo.getState(),packet=await prepareContext(sourceRepo,await request(h.repo,{goal:'项目复盘实测的完整链路与改稿',maxInputTokens:8000}),{...options,chatEvidence:[chatSpan]});
 assert.ok(packet.evidence.some(e=>e.sourceId===fresh.source.id));
 assert.ok(packet.sourceReferences.some(r=>r.sourceId===fresh.source.id&&r.title==='最新实测记录'));
 assert.equal(packet.facts.length,0);assert.equal(packet.lessons.length,0);
 assert.ok(packet.unknowns.some(x=>x.includes('未加入')));assert.deepEqual(await h.repo.getState(),before);
 assert.ok(packet.unknowns.some(x=>x.includes('原对话或前版成果的1段原文')));
 assert.ok(packet.budget.estimatedTokens+packet.budget.reservedTokens<=8000);
 assert.ok(old.source.id!==fresh.source.id);
});
