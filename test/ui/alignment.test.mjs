import {PAGE_ACTIONS} from '../../public/workspace-pages.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as context from '../../packages/context/index.mjs';
import * as experience from '../../packages/experience/index.mjs';
import {FILE_ACTIONS} from '../../public/file-actions.js';
const protocolVersion='synplex.workspace/1.0.0',scope={projectId:'alignment',versionId:null,branchId:null};

test('分页、历史说明、重新核对与退出通过真实HTTP工作，保持权限与只读边界',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-align-')),repository=new WorkspaceRepository({dataDir:dir});
 const ui=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','prepare_task','review_memory','record_result']});
 const auth=repository.authenticate(ui.token),app=createWorkspaceServer({repository,modules:{ingestion,context,experience}}),url=await app.listen();
 t.after(async()=>{await app.close();repository.close();rmSync(dir,{recursive:true,force:true});});
 const launch=await app.createUiPairing(auth,scope),pair=await fetch(url+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:launch.nonce}),redirect:'manual'}),cookie=pair.headers.get('set-cookie').split(';')[0];
 const post=(route,body={})=>fetch(url+'/api/v1/'+route,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion,scope,...body})});
 const repo=await repository.forScope(auth,scope);
 for(let i=0;i<25;i++){
  const state=await repo.getState();
  await app.service.import(auth,{protocolVersion,scope,requestId:'import-'+i,expectedStateRevision:state.stateRevision,format:'text/markdown',sourceSystem:'user-markdown',formatVersion:'1',sessionId:null,eventId:'event-'+i,occurredAt:null},Buffer.from('决定：共同检索词，记录 '+i));
  await app.service.idle();
 }
 const first=await post('ui_find_evidence',{query:'共同检索词',limit:20,includeHistory:true,cursor:null});assert.equal(first.status,200);const page=await first.json();assert.equal(page.items.length,20);assert.ok(page.cursor);
 const second=await post('ui_find_evidence',{query:'共同检索词',limit:20,includeHistory:true,cursor:page.cursor});assert.equal(second.status,200);const end=await second.json();assert.equal(end.items.length,5);assert.equal(end.cursor,null);
 assert.equal(new Set([...page.items,...end.items].map(x=>x.occurrence.id)).size,25);
 assert.equal((await post('ui_find_evidence',{query:'其他词',limit:20,includeHistory:true,cursor:page.cursor})).status,409);
 assert.equal((await post('ui_find_evidence',{query:'共同检索词',limit:20,includeHistory:true,cursor:null,scope:{...scope,projectId:'foreign'}})).status,403);
 const claim=(await repo.getState()).pending[0];
 for(const reviewStatus of ['confirmed','rejected','confirmed']){
  const body={requestId:'review-'+reviewStatus+'-'+(await repo.getState()).stateRevision,expectedStateRevision:(await repo.getState()).stateRevision,claimId:claim.id,reviewStatus};
  const grant=await (await post('authorize_review',body)).json();assert.equal((await post('review_claim',{...body,authorizationId:grant.authorizationId})).status,200);
 }
 assert.equal(repository.list(auth,scope,'review').length,3);
 assert.equal((await post('ui_find_evidence',{query:'共同检索词',limit:20,includeHistory:true,cursor:page.cursor})).status,409,'背景变更使旧分页失效');
 const work=await (await post('prepare_task',{requestId:'work-old',expectedStateRevision:(await repo.getState()).stateRevision,goal:'旧任务完整目标',constraints:['只生成草稿'],acceptanceCriteria:['文字结果'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:24000})).json();
 assert.ok(work.run?.id);
 await post('prepare_task',{requestId:'work-new',expectedStateRevision:(await repo.getState()).stateRevision,goal:'新任务',constraints:[],acceptanceCriteria:['文字结果'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:24000});
 const before=repository.list(auth,scope,'operation').length;
 const detail=await post('ui_task_detail',{runId:work.run.id});assert.equal(detail.status,200);assert.equal((await detail.json()).packet.goal,'旧任务完整目标');
 assert.equal(repository.list(auth,scope,'operation').length,before,'查看旧说明不创建操作或执行');
 assert.equal((await post('ui_task_detail',{runId:work.run.id,scope:{...scope,projectId:'foreign'}})).status,403);
 assert.equal((await post('ui_task_detail',{runId:'missing'})).status,403);
 const logout=await post('ui_logout');assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await post('ui_history')).status,403);assert.equal((await repo.getState()).decisions.length,1,'退出不删除资料');
});

test('全部显式页面按钮具有处理分支；弹窗复用同一处理器',()=>{
 const code=readFileSync(new URL('../../public/app.js',import.meta.url),'utf8');
 const directory=new URL('../../public/',import.meta.url),templates=readdirSync(directory).filter(f=>f.endsWith('.js')).map(f=>readFileSync(new URL(f,directory),'utf8')).join('\n');
 const actions=[...new Set([...templates.matchAll(/data-action="([a-z-]+)"/g)].map(x=>x[1]))];
 const handler=code.slice(code.indexOf('async function loadOlderMaterials(button){'),code.indexOf("app.addEventListener('click',handleClick)"));
 const grouped=[...handler.matchAll(/\[([^\]]+)\]\.includes\(button\.dataset\.action\)/g)].flatMap(x=>[...x[1].matchAll(/'([a-z-]+)'/g)].map(m=>m[1]));
 for(const action of actions)assert.ok(handler.includes("button.dataset.action==='"+action+"'")||grouped.includes(action)||FILE_ACTIONS.includes(action)&&handler.includes('await fileActions.handle(button)')||PAGE_ACTIONS.includes(action)&&handler.includes('if(pageClick(e))return;')&&code.includes('pages.act(scope,button.dataset.action,button.dataset.id)'),'按钮缺少真正的点击处理分支：'+action);
 assert.match(code,/dialog.addEventListener\('click',handleClick\)/);
 assert.match(code,/\.\.\.state\.facts,\.\.\.state\.decisions/);
 assert.match(code,/data-action="more-evidence"/);
 assert.match(code,/data-action="task-description"/);
});
