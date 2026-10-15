import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {setup,input,meta,scope} from '../ingestion/helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createExpressionLinks} from '../../services/workspace/expression-links.mjs';
import {assertDataFeatures} from '../../scripts/runtime/data-compatibility.mjs';
import {PROTOCOL_VERSION,payloadHash} from '../../packages/contracts/validate.mjs';

const wire=body=>({protocolVersion:PROTOCOL_VERSION,scope,...body});
async function confirm(h,c){const request=wire({...await meta(h.repo),claimId:c.id,reviewStatus:'confirmed'}),grant=h.repository.issueReviewAuthorization(h.auth,request);return h.repository.review(h.auth,{...request,authorizationId:grant.authorizationId}).value;}

test('作者完整预览→确认版本→受限查看→停止：原回执、改动阻断、撤权、重启/旧备份不复活原链接',async t=>{
 const h=await setup(t);let app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());
 const post=(path,body,token=h.credential.token)=>fetch(url+'/api/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(wire(body))});
 const imported=await importSource(h.repo,input('决定：保留原件 <script>neverRun()</script>'),await meta(h.repo));const chosen=await confirm(h,(await h.repo.getState()).pending[0]);
 await importSource(h.repo,input('决定：未选择的秘密NOT_SELECTED_SECRET'),await meta(h.repo));await confirm(h,(await h.repo.getState()).pending[0]);
 const selection={title:'作者的项目 <script>bad()</script>',claimIds:[chosen.id],includeEvidence:false};
 const preview=await (await post('ui_project_preview',selection)).json(),request={...selection,...await meta(h.repo),expectedSelectionHash:preview.selectionHash,approved:true};
 assert.equal((await post('ui_approve_expression',{...request,approved:false})).status,400);
 const agent=h.repository.createCredential({ownerId:'test-owner',actorId:'host',scope,kind:'agent',capabilities:['read_memory','write_memory']});
 assert.equal((await post('ui_approve_expression',request,agent.token)).status,403);
 let faulted=false;h.repository.fault=event=>{if(event.method==='approve_expression'&&!faulted){faulted=true;throw Error('fixture disk write failure');}};
 const faultResponse=await post('ui_approve_expression',request);assert.equal(faultResponse.status,409,await faultResponse.text());assert.equal(faulted,true);assert.equal(h.repository.recordCount(h.auth,scope,'project_expression_version'),0);h.repository.fault=null;
 const response=await post('ui_approve_expression',request);assert.equal(response.status,201);const version=await response.json();
 assert.equal((await (await post('ui_approve_expression',request)).json()).id,version.id);assert.equal(h.repository.recordCount(h.auth,scope,'project_expression_version'),1);
 const history=await (await post('ui_expression_versions',{})).json();assert.equal(history.versions.length,1);assert.equal(history.versions[0].status,'saved');assert.equal(history.complete,true);assert.doesNotMatch(JSON.stringify(history),/authorCredential|<html|NOT_SELECTED_SECRET/);
 assert.equal((await post('ui_expression_version',{versionId:version.id,scope:{...scope,projectId:'other'}})).status,403);
 assert.equal((await post('ui_expression_link',{versionId:version.id},agent.token)).status,403);
 const link=await (await post('ui_expression_link',{versionId:version.id})).json();assert.match(link.path,/^\/view\/[a-f0-9]{64}$/);
 const viewed=await fetch(url+link.path);assert.equal(viewed.status,200);assert.match(viewed.headers.get('Cache-Control'),/no-store/);assert.equal(viewed.headers.get('Referrer-Policy'),'no-referrer');assert.match(viewed.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
 const html=await viewed.text();assert.doesNotMatch(html,/<script>|NOT_SELECTED_SECRET|sourceId|authorCredential/);assert.match(html,/作者确认的版本/);assert.match(html,/已经看过、复制或另存的内容不能收回/);
 assert.equal((await fetch(url+link.path+'?extra=true')).status,410);
 assert.equal((await fetch(url+link.path,{method:'POST'})).status,410);
 assert.equal((await fetch(url+link.path,{headers:{Origin:'https://untrusted.example'}})).status,403);
 // Bound time without paid calls or waiting an hour. This uses the same real
 // repository/version, varying only the injected clock and HTTP response sink.
 let clock=0;const timed=createExpressionLinks(h.repository,{clock:()=>clock}),timedLink=timed.create(h.auth,wire({versionId:version.id}));let status;
 const sink={writeHead:s=>{status=s;},end:()=>{}};timed.handle({method:'GET'},sink,new URL(url+timedLink.path));assert.equal(status,200);clock=3600_000;timed.handle({method:'GET'},sink,new URL(url+timedLink.path));assert.equal(status,410);
 const oldRelease=join(h.dataDir,'old-release');mkdirSync(oldRelease);assert.throws(()=>assertDataFeatures(oldRelease,join(h.dataDir,'workspace.sqlite')),/不能完整理解/);
 mkdirSync(join(oldRelease,'migrations'));writeFileSync(join(oldRelease,'migrations/workspace-features.json'),JSON.stringify({format:'synplex.workspace-features/1',features:['project-expression-version/1']}));assert.doesNotThrow(()=>assertDataFeatures(oldRelease,join(h.dataDir,'workspace.sqlite')));
 const restoredDir=join(h.dataDir,'old-backup');mkdirSync(restoredDir);const db=new DatabaseSync(join(h.dataDir,'workspace.sqlite'),{readOnly:true});await backup(db,join(restoredDir,'workspace.sqlite'));db.close();
 const stopRequest={versionId:version.id,...await meta(h.repo)};assert.equal((await post('ui_stop_expression',stopRequest)).status,200);assert.equal((await post('ui_stop_expression',stopRequest)).status,200);
 assert.equal((await fetch(url+link.path)).status,410);assert.equal((await post('ui_expression_link',{versionId:version.id})).status,403);
 assert.equal((await (await post('ui_expression_version',{versionId:version.id})).json()).html,html,'停止查看不删除作者保存的版本');
 // Restoring even an older, pre-withdrawal backup cannot restore a link token.
 const restored=new WorkspaceRepository({dataDir:restoredDir}),restoredApp=createWorkspaceServer({repository:restored}),restoredUrl=await restoredApp.listen();
 try{assert.equal((await fetch(restoredUrl+link.path)).status,410);}finally{await restoredApp.close();restored.close();}
 const second=await (await post('ui_approve_expression',{...request,...await meta(h.repo)})).json();const nextLink=await (await post('ui_expression_link',{versionId:second.id})).json();
 const metadata=h.repository.sourceMetadata(h.auth,scope,imported.source.id);
 h.repository.updateSourceMetadata(h.auth,wire({...await meta(h.repo),sourceId:imported.source.id,expectedMetadataRevision:metadata.revision,metadata:{title:'原文名称更正',category:'项目',tags:[],locked:true}}));
 assert.equal((await fetch(url+nextLink.path)).status,410,'相关出处变化使旧链接失效');
 assert.equal((await (await post('ui_approve_expression',request)).json()).id,version.id,'内容变化后仍找回原回执，不能重复保存');
 assert.equal((await post('ui_expression_link',{versionId:second.id})).status,409);assert.equal((await post('ui_expression_version',{versionId:second.id})).status,200,'私人历史仍可读');
 const latest=await (await post('ui_project_preview',selection)).json(),third=await (await post('ui_approve_expression',{...request,...await meta(h.repo),expectedSelectionHash:latest.selectionHash})).json();
 const restartLink=await (await post('ui_expression_link',{versionId:third.id})).json();await app.close();await h.reopen();app=createWorkspaceServer({repository:h.repository});url=await app.listen();
 assert.equal((await fetch(url+restartLink.path)).status,410,'重启后原链接失效');assert.equal((await (await post('ui_expression_versions',{})).json()).versions.length,3);
 const afterRestart=await (await post('ui_expression_link',{versionId:third.id})).json();assert.equal((await fetch(url+afterRestart.path)).status,200);
 assert.equal(h.repository.recordCount(h.auth,scope,'attempt'),0);assert.equal(h.repository.getBlob(h.auth,scope,imported.source.id).blob.sha256,imported.source.sha256);
 h.repository.revokeCredential(h.credential.id);assert.equal((await fetch(url+afterRestart.path)).status,410);
});
