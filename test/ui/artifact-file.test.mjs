import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../../packages/contracts/validate.mjs';
import { setup,scope } from '../ingestion/helpers.mjs';
import * as context from '../../packages/context/index.mjs';
import { WorkspaceService } from '../../services/workspace/service.mjs';
import { verifyArtifact } from '../../services/workspace/artifacts.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
const protocolVersion='synplex.workspace/1.0.0';
async function fixture(t){
 const h=await setup(t);
 h.credential=h.repository.createCredential({ownerId:'test-owner',actorId:'artifact-ui',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result']});
 h.auth=h.repository.authenticate(h.credential.token);h.repo=await h.repository.forScope(h.auth,scope);
 const service=new WorkspaceService({repository:h.repository,modules:{context}}),state=await h.repo.getState();
 const prepared=await service.call(h.auth,'prepare_task',{protocolVersion,scope,requestId:randomUUID(),expectedStateRevision:state.stateRevision,goal:'隔离成果回流验收',constraints:[],acceptanceCriteria:['核对原文件'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:4000});
 const bytes=Buffer.from('# 合成验收交付\n\n失败和未验证项不得隐藏。\n'),artifact={id:randomUUID(),name:'交付说明.md',uri:'https://untrusted.invalid/never-fetch',sha256:sha256(bytes),byteLength:bytes.length,mediaType:'text/markdown',verification:'reported'};
 const usage={observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'};
 const reply=await service.call(h.auth,'record_result',{protocolVersion,scope,requestId:randomUUID(),expectedStateRevision:state.stateRevision,runId:prepared.run.id,result:{eventId:randomUUID(),attemptId:randomUUID(),provider:'synthetic-host-fixture',summary:'文件待核对',artifacts:[artifact],checks:[],usage,supersedesResultId:null,occurredAt:null}});
 return Object.assign(h,{bytes,artifact,result:reply.result});
}
test('real bytes must match report; hash verification remains separate from immutable host report and business acceptance',async t=>{
 const h=await fixture(t),input={resultId:h.result.id,artifactId:h.artifact.id,bytes:h.bytes};
 assert.throws(()=>h.repository.artifactFile(h.auth,scope,h.result.id,h.artifact.id),e=>e.code==='capability_unavailable');
 assert.throws(()=>verifyArtifact(h.repository,h.auth,scope,{...input,bytes:Buffer.from('错文件')}),e=>e.code==='conflict');
 const saved=verifyArtifact(h.repository,h.auth,scope,input),again=verifyArtifact(h.repository,h.auth,scope,input);assert.deepEqual(again,saved);
 assert.equal(saved.method,'sha256_and_length');assert.deepEqual(h.repository.artifactFile(h.auth,scope,h.result.id,h.artifact.id).bytes,h.bytes);
 assert.deepEqual(h.repository.read(h.auth,scope,'result',h.result.id),h.result);assert.equal(h.result.trust,'host_reported');
 await h.reopen();assert.deepEqual(h.repository.artifactFile(h.auth,scope,h.result.id,h.artifact.id).bytes,h.bytes);
 assert.throws(()=>h.repository.artifactFile(h.auth,{...scope,projectId:'other'},h.result.id,h.artifact.id),e=>e.code==='scope_denied');
});
test('HTTP file selection and download preserve bytes; cross-Origin and actor forgery cannot verify files',async t=>{
 const h=await fixture(t),app=createWorkspaceServer({repository:h.repository}),endpoint=await app.listen();t.after(()=>app.close());
 const body={protocolVersion,scope,resultId:h.result.id,artifactId:h.artifact.id};
 const upload=()=>{const f=new FormData();f.set('metadata',JSON.stringify(body));f.set('source',new Blob([h.bytes]),h.artifact.name);return f;};
 const headers={Authorization:'Bearer '+h.credential.token};
 assert.equal((await fetch(endpoint+'/api/v1/ui_verify_artifact',{method:'POST',headers:{...headers,Origin:'https://malicious.invalid'},body:upload()})).status,403);
 assert.equal((await fetch(endpoint+'/api/v1/ui_verify_artifact',{method:'POST',headers,body:upload()})).status,200);
 const r=await fetch(endpoint+'/api/v1/artifact_file',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal(r.status,200);assert.deepEqual(Buffer.from(await r.arrayBuffer()),h.bytes);
 const bad=upload();bad.set('metadata',JSON.stringify({...body,actorId:'admin'}));
 assert.equal((await fetch(endpoint+'/api/v1/ui_verify_artifact',{method:'POST',headers,body:bad})).status,403);
});
test('business acceptance binds the original criteria and result, appends corrections and survives replay and restart',async t=>{
 const h=await fixture(t),request={protocolVersion,scope,resultId:h.result.id,status:'passed',note:'人工核对了正文与要求。',requestId:randomUUID(),expectedStateRevision:(await h.repo.getState()).stateRevision};
 assert.throws(()=>h.repository.reviewResult(h.auth,request),e=>e.code==='validation_failed','No passing review before original files return');
 verifyArtifact(h.repository,h.auth,scope,{resultId:h.result.id,artifactId:h.artifact.id,bytes:h.bytes});
 const first=h.repository.reviewResult(h.auth,request),replay=h.repository.reviewResult(h.auth,request);
 assert.equal(replay.value.id,first.value.id);assert.equal(replay.duplicate,true);assert.equal(first.value.resultHash,h.result.payloadHash);
 assert.deepEqual(first.value.acceptanceCriteria,['核对原文件']);
 assert.throws(()=>h.repository.reviewResult(h.auth,{...request,note:'篡改同一请求'}),e=>e.code==='conflict');
 const second=h.repository.reviewResult(h.auth,{...request,requestId:randomUUID(),expectedStateRevision:(await h.repo.getState()).stateRevision,status:'needs_revision',note:'复核发现正文遗漏，需补充。'});
 assert.equal(second.value.supersedesReviewId,first.value.id);assert.equal(h.repository.list(h.auth,scope,'result_review').length,2);
 assert.deepEqual(h.repository.read(h.auth,scope,'result',h.result.id),h.result,'Human review does not overwrite the host receipt');
 assert.equal(h.repository.state(h.auth,scope).lessons.length,0,'Review does not auto-create confirmed memories');
 await h.reopen();assert.equal(h.repository.list(h.auth,scope,'result_review').at(-1).status,'needs_revision');
 assert.throws(()=>h.repository.reviewResult(h.auth,{...request,scope:{...scope,projectId:'wrong'}}),e=>e.code==='scope_denied');
});
test('only an authorized UI can record business acceptance; HTTP rejects foreign Origin and forged attribution',async t=>{
 const h=await fixture(t),app=createWorkspaceServer({repository:h.repository}),endpoint=await app.listen();t.after(()=>app.close());
 const body={protocolVersion,scope,resultId:h.result.id,status:'needs_revision',note:'文件尚未接回，不能验收。',requestId:randomUUID(),expectedStateRevision:(await h.repo.getState()).stateRevision},headers={Authorization:'Bearer '+h.credential.token,'Content-Type':'application/json'};
 const post=(value,extra={})=>fetch(endpoint+'/api/v1/ui_review_result',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(value)});
 assert.equal((await post(body,{Origin:'https://malicious.invalid'})).status,403);
 assert.equal((await post({...body,actorId:'admin'})).status,400);
 const agent=h.repository.createCredential({ownerId:'test-owner',actorId:'host',scope,kind:'agent',capabilities:['read_memory','record_result']});
 assert.equal((await post(body,{Authorization:'Bearer '+agent.token})).status,403);
 assert.equal((await post(body)).status,200);
 const history=await fetch(endpoint+'/api/v1/ui_history',{method:'POST',headers,body:JSON.stringify({protocolVersion,scope})});
 const projection=await history.json();assert.equal(projection.resultReviews.length,1);assert.equal(projection.resultRequirements[h.result.id].goal,'隔离成果回流验收');
});

test('成果逐行变化保留真实行号与重复行，明确容量和提取边界，页面文字不执行',async()=>{
 const {textDifference}=await import('../../public/text-difference.js'),{comparisonContent,artifactComparisonForm}=await import('../../public/artifact-comparison.js');
 const esc=text=>String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
 const pairs=[['',''],['原来\n重复\n保留\n重复\n尾部','原来\n重复\n改过\n重复\n尾部'],['a\n','a'],['a\r\n','a\n'],['','新\n']];
 for(const [before,after]of pairs){const diff=textDifference(before,after);assert.equal(diff.status,'complete');assert.equal(diff.sameText,before===after);if(before!==after){assert.equal(diff.omittedUnchangedBefore,0);assert.equal(diff.omittedUnchangedAfter,0);assert.equal(diff.rows.filter(r=>r.kind!=='added').map(r=>r.text).join('\n'),before);assert.equal(diff.rows.filter(r=>r.kind!=='removed').map(r=>r.text).join('\n'),after);}}
 const large=Array.from({length:500},(_,i)=>String(i)),changed=[...large];changed[250]='发生变化';const bounded=textDifference(large.join('\n'),changed.join('\n'));assert.equal(bounded.added,1);assert.equal(bounded.removed,1);assert.equal(bounded.omittedUnchangedBefore,248);assert.equal(bounded.omittedUnchangedAfter,247);assert.equal(bounded.rows.find(r=>r.kind==='added').afterLine,251);
 assert.equal(textDifference('字'.repeat(90_000),'x').status,'limited');assert.equal(textDifference('x\n'.repeat(2100),'x\n'.repeat(2100)).status,'limited');
 assert.equal(textDifference(Array.from({length:1000},(_,i)=>'a'+i).join('\n'),Array.from({length:1000},(_,i)=>'b'+i).join('\n')).status,'limited');
 const before={sha256:'a',byteLength:1,status:'complete',text:'原文'},after={sha256:'b',byteLength:2,status:'extracted',text:'<script>alert(1)</script>'},html=comparisonContent(before,after,esc);
 assert.match(html,/只比较提取出的文字/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(comparisonContent(before,{...after,status:'unavailable'},esc),/没有将未读内容当作相同/);
 assert.match(comparisonContent(before,{...before,status:'unavailable'},esc),/内容完全相同/);assert.match(comparisonContent(before,{...after,text:'原文'},esc),/文字相同，但文件仍有变化/);
 const form=artifactComparisonForm({id:'current',artifacts:[{id:'current-file',name:'报告.md',saved:true}]},{id:'old',artifacts:[{id:'old-file',name:'报告.md',saved:true},{id:'old-file-two',name:'报告.md',saved:true}]},esc);
 assert.match(form,/name="beforeFile" required/);assert.match(form,/data-before="old"/);assert.doesNotMatch(form,/value="old-file" selected/,'多文件不靠相同名称猜配对');
});
