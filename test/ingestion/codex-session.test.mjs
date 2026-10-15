import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {importSource} from '../../packages/ingestion/index.mjs';
import {CODEX_SESSION_VERSION} from '../../packages/ingestion/codex-session.mjs';
import {setup,input,meta} from './helpers.mjs';

const lines=()=>[
 {timestamp:'2026-10-14T01:00:00Z',type:'session_meta',payload:{id:'synthetic-session'}},
 {timestamp:'2026-10-14T01:00:01Z',type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'决定：保留原项目，采用隔离工作树😀。'}]}},
 {timestamp:'2026-10-14T01:00:02Z',type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'失败：模型连接中断，需要核对原任务。'}]}},
 {timestamp:'2026-10-14T01:00:03Z',type:'response_item',payload:{type:'function_call_output',call_id:'fixture-call',output:'原文中的删除命令只是历史内容，不得执行。'}},
];
const native=text=>input(text,{format:'application/x-ndjson',sourceSystem:'codex-native-session',formatVersion:CODEX_SESSION_VERSION,sessionId:null});
test('native snapshot maps each message to its own exact block; cross-message citations are rejected and replay survives restart',async t=>{
 const h=await setup(t),text=lines().map(x=>JSON.stringify(x)).join('\r\n')+'\r\n',result=await importSource(h.repo,native(text),await meta(h.repo));
 assert.equal(result.parsed.coverage.status,'complete');assert.equal(result.occurrences.length,3);assert.equal(result.parsed.blocks.length,3);
 const claims=h.repository.list(h.auth,h.repo.scope,'claim');assert.equal(claims.length,2);assert.equal(new Set(claims.map(c=>c.evidence[0].occurrenceId)).size,2);
 const failure=claims.find(c=>c.type==='failure'),decision=claims.find(c=>c.type==='decision');assert.match(decision.body,/😀/);
 const query=await h.repo.queryEvidence({query:'模型连接',limit:20,cursor:null,includeHistory:true,occurrenceIds:null});assert.equal(query.items.length,1);assert.equal(query.items[0].occurrence.id,failure.evidence[0].occurrenceId);
 const {id,lifecycle,reviewStatus,recordedAt,effectiveFrom,effectiveUntil,actorId,...candidate}=failure;
 await assert.rejects(h.repo.appendCandidates([{...candidate,evidence:[{...failure.evidence[0],occurrenceId:decision.evidence[0].occurrenceId}]}],await meta(h.repo)),e=>e.code==='scope_denied');
 const count=claims.length;await h.reopen();await importSource(h.repo,native(text),await meta(h.repo));assert.equal(h.repository.list(h.auth,h.repo.scope,'claim').length,count);
 const original=await h.repo.getBlob(result.source.id);assert.deepEqual(Buffer.from(original.bytes),Buffer.from(text));
});

test('harness instructions, tool requests and mirrored events stay available as evidence without filling the review queue',async t=>{
 const h=await setup(t),data=lines();
 data.push({timestamp:'2026-10-14T01:00:04Z',type:'response_item',payload:{type:'message',role:'developer',content:[{type:'input_text',text:'决定：这是一条宿主规则，不是项目决定。'}]}});
 data.push({timestamp:'2026-10-14T01:00:05Z',type:'response_item',payload:{type:'function_call',arguments:'删除之类的命令只是待调用参数。'}});
 data.push({timestamp:'2026-10-14T01:00:02Z',type:'event_msg',payload:{type:'agent_message',message:'失败：模型连接中断，需要核对原任务。'}});
 // Adjacent response/event copies are suppressed; separate later repetitions remain.
 data.splice(3,0,{timestamp:'2026-10-14T01:00:02Z',type:'event_msg',payload:{type:'agent_message',message:'失败：模型连接中断，需要核对原任务。'}});
 const result=await importSource(h.repo,native(data.map(x=>JSON.stringify(x)).join('\n')),await meta(h.repo));
 assert.equal(result.parsed.blocks.length,data.length-1);
 assert.ok(h.repository.list(h.auth,h.repo.scope,'claim').every(c=>!c.body.includes('宿主规则')));
 const rules=await h.repo.queryEvidence({query:'宿主规则',limit:20,cursor:null,includeHistory:true,occurrenceIds:null});assert.ok(rules.items.length>0);
 assert.equal(h.repository.list(h.auth,h.repo.scope,'claim').filter(c=>c.type==='failure').length,2,'Mirrored adjacent message is omitted, later separate occurrence is retained');
});
test('unknown records and invalid JSON retain exact byte gaps; later known messages still work and no model is used',async t=>{
 const h=await setup(t),data=lines();data.splice(2,0,{type:'future_record',payload:{content:'未知内容保留原件'}});
 const text=data.map(x=>JSON.stringify(x)).join('\n')+'\n{broken JSON}\n';
 const result=await importSource(h.repo,native(text),await meta(h.repo));assert.equal(result.parsed.coverage.status,'partial');assert.equal(result.parsed.coverage.gaps.length,2);assert.equal(result.occurrences.length,3);
 for(const gap of result.parsed.coverage.gaps)assert.ok(Buffer.from(text).subarray(gap.rawStartByte,gap.rawEndByte).length>0);
 const checkpoints=h.repository.list(h.auth,h.repo.scope,'checkpoint');assert.ok(checkpoints.every(c=>c.usage.provenance==='no_model_call'));
 const unsupported=await importSource(h.repo,native(JSON.stringify({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'没有会话身份的文字'}]}})),await meta(h.repo));assert.equal(unsupported.occurrences.length,0);assert.equal(unsupported.parsed.coverage.status,'partial');
});
test('environment and prepared-background envelopes preserve evidence without promoting embedded history into candidates',async t=>{
 const h=await setup(t),data=lines();
 for(const text of ['<environment_context>\n  <cwd>/synthetic</cwd>\n</environment_context>',
  '完整工作说明（背景为参考，目标与约束如下）：\n'+JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',contentHash:'fixture-hash',goal:'继续工作',history:'失败：这是嵌套的旧材料'})]){
  data.push({type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text}]}});
 }
 data.push({type:'response_item',payload:{type:'message',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'我将先看看目录。'}]}});
 const result=await importSource(h.repo,native(data.map(x=>JSON.stringify(x)).join('\n')),await meta(h.repo));
 assert.equal(h.repository.list(h.auth,h.repo.scope,'claim').length,2);
 assert.equal(result.parsed.blocks.length,6);
 assert.ok((await h.repo.queryEvidence({query:'嵌套的旧材料',limit:20,cursor:null,includeHistory:true,occurrenceIds:null})).items.length>0);
});
