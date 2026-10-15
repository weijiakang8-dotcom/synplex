import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,input,meta,scope} from '../ingestion/helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {noteExport} from '../../services/workspace/note-export.mjs';
import {saveVerifiedFile} from '../../public/file-save.js';
import {PROTOCOL_VERSION,payloadHash,sha256} from '../../packages/contracts/validate.mjs';

async function confirm(h,c){const request={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:c.id,reviewStatus:'confirmed'},grant=h.repository.issueReviewAuthorization(h.auth,request);return h.repository.review(h.auth,{...request,authorizationId:grant.authorizationId}).value;}

test('已确认记录先预览再保存：精确版本、原文指纹、修订阻塞、重启与撤权，不写外部笔记库',async t=>{
 const h=await setup(t),app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());
 const post=(path,body,token=h.credential.token)=>fetch(url+'/api/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:PROTOCOL_VERSION,scope,...body})});
 const imported=await importSource(h.repo,input('决定：保留原件。'),await meta(h.repo)),old=(await h.repo.getState()).pending[0];
 assert.equal((await post('ui_note_preview',{claimId:old.id})).status,409);await confirm(h,old);
 const initial=await (await post('ui_note_preview',{claimId:old.id})).json();
 const result=await post('ui_note_file',{claimId:old.id,expectedSelectionHash:initial.selectionHash});assert.equal(result.status,200);
 assert.equal(result.headers.get('Cache-Control'),'no-store');const bytes=Buffer.from(await result.arrayBuffer());assert.equal(sha256(bytes),initial.sha256);assert.equal(bytes.toString(),initial.text);assert.ok(initial.text.includes(imported.source.sha256));
 const agent=h.repository.createCredential({ownerId:'test-owner',actorId:'host',scope,kind:'agent',capabilities:['read_memory']});
 assert.equal((await post('ui_note_preview',{claimId:old.id},agent.token)).status,403);
 assert.equal((await post('ui_note_preview',{claimId:old.id,scope:{...scope,projectId:'other'}})).status,403);
 assert.equal((await post('ui_note_file',{claimId:old.id,expectedSelectionHash:initial.selectionHash,path:'/must-never-write'})).status,403);
 const draft=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:old.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',old.id)),draft:{title:'../../测试: <iframe>\nfilename',body:'保存原文：\n```\n<script>doNotRun()</script>\n```\n![[外部附件]]',type:'decision',condition:null},note:'防止原文被作为网页执行。'}).value;
 assert.equal((await post('ui_note_file',{claimId:old.id,expectedSelectionHash:initial.selectionHash})).status,409,'未审修改不能从旧预览保存');
 await confirm(h,draft);assert.equal((await post('ui_note_preview',{claimId:old.id})).status,409);
 const next=await (await post('ui_note_preview',{claimId:draft.id})).json();assert.doesNotMatch(next.name,/[\\/\r\n<>:]/);assert.ok(next.text.includes('````text\n'+draft.body+'\n````'));assert.ok(next.text.includes('&lt;iframe&gt;'));
 h.repository.updateSourceMetadata(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),sourceId:draft.evidence[0].sourceId,expectedMetadataRevision:h.repository.sourceMetadata(h.auth,scope,draft.evidence[0].sourceId).revision,metadata:{title:'已更正的原文名称',category:'项目资料',tags:[],locked:true}});
 assert.equal((await post('ui_note_file',{claimId:draft.id,expectedSelectionHash:next.selectionHash})).status,409,'出处变化必须重新预览');
 const fresh=await (await post('ui_note_preview',{claimId:draft.id})).json();assert.notEqual(fresh.selectionHash,next.selectionHash);assert.equal(h.repository.list(h.auth,scope,'attempt').length,0);assert.equal(h.repository.getBlob(h.auth,scope,imported.source.id).blob.sha256,imported.source.sha256);
 await app.close();await h.reopen();assert.equal(noteExport(h.repository,h.auth,scope,draft.id,fresh.selectionHash).sha256,fresh.sha256);
 h.repository.revokeCredential(h.credential.id);assert.throws(()=>noteExport(h.repository,h.auth,scope,draft.id,fresh.selectionHash),e=>e.code==='scope_denied');
});

test('浏览器保存先选位置再鉴别字节：取消不读取、错误不写、失败中止与下载兜底',async()=>{
 const bytes=new TextEncoder().encode('当前选定版本'),hash=sha256(bytes),events=[];
 const load=async()=>{events.push('load');return {bytes,sha256:hash};};
 const picker=async()=>{events.push('pick');return {createWritable:async()=>{events.push('open');return {write:async b=>{assert.deepEqual(b,bytes);events.push('write');},close:async()=>events.push('close')}}};};
 assert.equal((await saveVerifiedFile('记录.md',load,{picker})).status,'saved');assert.deepEqual(events,['pick','load','open','write','close']);
 events.length=0;assert.equal((await saveVerifiedFile('记录.md',load,{picker:async()=>{throw new DOMException('cancel','AbortError');}})).status,'cancelled');assert.deepEqual(events,[]);
 await assert.rejects(saveVerifiedFile('记录.md',async()=>({bytes,sha256:'0'.repeat(64)}),{picker}),/未通过核对/);assert.deepEqual(events,['pick']);
 let aborted=false;await assert.rejects(saveVerifiedFile('记录.md',load,{picker:async()=>({createWritable:async()=>({write:async()=>{throw Error('fixture disk full');},abort:async()=>{aborted=true;}})})}),/未完成/);assert.equal(aborted,true);
 let downloaded;assert.equal((await saveVerifiedFile('记录.md',load,{picker:null,download:(name,blob)=>{downloaded={name,blob};}})).status,'downloaded');assert.equal(downloaded.name,'记录.md');assert.equal(await downloaded.blob.text(),'当前选定版本');
});

test('项目介绍只导出作者明确勾选的当前记录：默认私人、不夹带原文、版本变动拒绝并保留原件',async t=>{
 const h=await setup(t),app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());
 const post=(path,body,token=h.credential.token)=>fetch(url+'/api/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:PROTOCOL_VERSION,scope,...body})});
 const imported=await importSource(h.repo,input('决定：保留原件。原文私密标记ONLY_SOURCE_SECRET <script>doNotRun()</script>'),await meta(h.repo));
 const original=(await h.repo.getState()).pending[0];await confirm(h,original);
 const selected=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:original.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',original.id)),draft:{title:'保留原件 <script>doNotRun()</script>',body:'只提取需要的正文，完整原件继续保留。',type:'decision',condition:'资料导入时'},note:'用清楚的文字表达，不把原文全文放进介绍。'}).value;
 await confirm(h,selected);
 const another=await importSource(h.repo,input('经验：另一条未选中的PRIVATE_NOT_SELECTED。'),await meta(h.repo));
 const other=(await h.repo.getState()).pending[0];await confirm(h,other);
 const selection={title:'项目介绍 <script>bad()</script>',claimIds:[selected.id],includeEvidence:false};
 const preview=await (await post('ui_project_preview',selection)).json();assert.equal(preview.count,1);assert.equal(preview.sections[0].title,'关键决定');
 assert.doesNotMatch(preview.html,/ONLY_SOURCE_SECRET|PRIVATE_NOT_SELECTED|<script>/);assert.match(preview.html,/&lt;script&gt;/);assert.match(preview.html,/Content-Security-Policy/);assert.match(preview.html,/default-src &#39;none&#39;/);
 assert.equal(preview.sections[0].items[0].evidence.length,0);assert.match(preview.html,/不会自动发布/);
 const file=await post('ui_project_file',{...selection,expectedSelectionHash:preview.selectionHash});assert.equal(file.status,200);assert.equal(file.headers.get('Cache-Control'),'no-store');assert.equal(sha256(Buffer.from(await file.arrayBuffer())),preview.sha256);
 const full=await (await post('ui_project_preview',{...selection,includeEvidence:true})).json();assert.match(full.html,/修改原因：/);assert.doesNotMatch(full.html,/ONLY_SOURCE_SECRET/);assert.equal(full.sections[0].items[0].evidence[0].quote,selected.evidence[0].quote);assert.match(full.html,/&lt;script&gt;/);assert.notEqual(full.selectionHash,preview.selectionHash);
 const agent=h.repository.createCredential({ownerId:'test-owner',actorId:'host',scope,kind:'agent',capabilities:['read_memory']});assert.equal((await post('ui_project_preview',selection,agent.token)).status,403);
 assert.equal((await post('ui_project_preview',{...selection,scope:{...scope,projectId:'other'}})).status,403);
 assert.equal((await post('ui_project_preview',{...selection,claimIds:[selected.id,selected.id]})).status,403);
 assert.equal((await post('ui_project_preview',{...selection,path:'/must-never-write'})).status,403);
 assert.equal((await post('ui_project_preview',{...selection,claimIds:[original.id]})).status,409);
 h.repository.updateSourceMetadata(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),sourceId:selected.evidence[0].sourceId,expectedMetadataRevision:h.repository.sourceMetadata(h.auth,scope,selected.evidence[0].sourceId).revision,metadata:{title:'更正原文名称',category:'项目',tags:[],locked:true}});
 assert.equal((await post('ui_project_file',{...selection,expectedSelectionHash:preview.selectionHash})).status,409);
 const next=await (await post('ui_project_preview',selection)).json();assert.notEqual(next.selectionHash,preview.selectionHash);
 const mutationCount=h.repository.list(h.auth,scope,'claim').length;
 await app.close();await h.reopen();const {projectExpression}=await import('../../services/workspace/project-expression.mjs');
 assert.equal(projectExpression(h.repository,h.auth,scope,{...selection,expectedSelectionHash:next.selectionHash}).sha256,next.sha256);
 assert.equal(h.repository.list(h.auth,scope,'claim').length,mutationCount);assert.equal(h.repository.list(h.auth,scope,'attempt').length,0);
 assert.equal(h.repository.getBlob(h.auth,scope,imported.source.id).blob.sha256,imported.source.sha256);assert.equal(h.repository.getBlob(h.auth,scope,another.source.id).blob.sha256,another.source.sha256);
 h.repository.revokeCredential(h.credential.id);assert.throws(()=>projectExpression(h.repository,h.auth,scope,selection),e=>e.code==='scope_denied');
});
