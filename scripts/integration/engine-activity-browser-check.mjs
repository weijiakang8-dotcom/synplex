import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createAgentHubExecutor} from '../../adapters/execution/agenthub.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';

// One deterministic engine task, real adapter/HTTP/SQLite/browser/file paths.
// No provider, Python worker, external side effect or autonomous model choice.
const output=browserEvidenceDirectory('engine-activity','SYNPLEX_ACTIVITY_EVIDENCE_DIR');
const directory=mkdtempSync(join(tmpdir(),'synplex-engine-activity-')),repository=new WorkspaceRepository({dataDir:join(directory,'workspace')}),scope={projectId:'activity-ui',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']}),auth=repository.authenticate(credential.token);
const workflowId=randomUUID(),taskId=randomUUID(),artifactId=randomUUID(),bytes=Buffer.from('# 项目报告\n步骤来自隔离夹具，模型质量未验收。');
const tokenFile=join(directory,'engine-token');writeFileSync(tokenFile,'fixture-private-token',{mode:0o600});
let submissions=0,activityReads=0,status='running',feed='good';const events=[];
const emit=event=>events.push({execution_id:taskId,event_id:randomUUID(),sequence:events.length+1,...event});
emit({event:'activity',phase:'plan',status:'started',description:'PRIVATE_INTERNAL_PROMPT'});
const engine=http.createServer(async(req,res)=>{
 assert.equal(req.headers.authorization,'Bearer fixture-private-token');const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='POST'){
  assert.equal(url.pathname,'/api/executions');submissions++;for await(const _ of req){}res.end(JSON.stringify({execution_id:taskId}));return;
 }
 if(url.pathname==='/api/workflows/'+workflowId){res.end(JSON.stringify({id:workflowId}));return;}
 if(url.pathname==='/api/executions/'+taskId+'/activity'){
  activityReads++;const after=Number(url.searchParams.get('after'));
  res.end(JSON.stringify({execution:{id:feed==='foreign'?randomUUID():taskId,workflow_id:workflowId},events:events.filter(e=>e.sequence>after),cursor:events.length,has_more:false}));return;
 }
 if(url.pathname==='/api/executions/'+taskId){res.end(JSON.stringify({id:taskId,workflow_id:workflowId,status,final_output:status==='completed'?'项目报告已生成，请检查文件。':null,checkpoint_data:{}}));return;}
 if(url.pathname==='/api/artifacts'){res.end(JSON.stringify(status==='completed'?[{id:artifactId,filename:'项目报告.md',size:bytes.length,sha256:sha256(bytes),format:'md'}]:[]));return;}
 if(url.pathname==='/api/artifacts/'+artifactId+'/download'){res.end(bytes);return;}
 res.writeHead(404);res.end();
});await new Promise(yes=>engine.listen(0,'127.0.0.1',yes));
const adapter=createAgentHubExecutor({endpoint:'http://127.0.0.1:'+engine.address().port,workflowId,tokenFile,dataDir:join(directory,'bridge'),pollMs:50});
const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter},timeoutMs:90000}),app=createWorkspaceServer({repository,modules:{context},execution,publicDir:resolve('public')}),url=await app.listen();
const browser=await launchTestBrowser();let page;
try{
 page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin===url)return route.continue();external.push(route.request().url());return route.abort();});
 const pair=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pair.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('nav [data-nav=task]').click();
 const form=page.locator('#task-form');await form.locator('[name=goal]').fill('整理一份项目报告');await form.locator('[name=acceptance]').fill('交付可下载的报告');await form.locator('[name=executor]').selectOption('synplex');
 await form.locator('button.primary').click();await page.locator('[data-action=start-execution]').click();
 const steps=page.locator('[data-ai-role=execution_activity]');await steps.waitFor();await page.waitForFunction(()=>document.querySelector('.execution-steps')?.textContent.includes('整理执行步骤'));
 await steps.locator('summary').click();await form.locator('[name=goal]').focus();
 const semantic=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');return availableOperations().find(x=>x.action==='view_execution_steps');});assert.equal(semantic?.state,'available');
 emit({event:'tool_call',tool_name:'export_document',params:{secret:'PRIVATE_TOOL_SECRET'}});
 await page.waitForFunction(()=>document.querySelector('.execution-steps')?.textContent.includes('生成文件'));assert.equal(await steps.evaluate(e=>e.open),true,'polling keeps the current expansion');
 await page.locator('nav [data-nav=results]').click();assert.equal(submissions,1);await page.locator('nav [data-nav=task]').click();assert.equal(await steps.evaluate(e=>e.open),true,'switching pages preserves the expansion');
 feed='foreign';emit({event:'tool_result',tool_name:'export_document',status:'success',result:'PRIVATE_RESULT'});
 await form.locator('[name=goal]').focus();await page.waitForFunction(()=>document.querySelector('.execution-steps')?.textContent.includes('具体进度暂时无法读取'));
 let op=repository.list(auth,scope,'operation').find(x=>x.kind==='execute_task');assert.equal(op.status,'running');assert.equal(repository.list(auth,scope,'execution_activity').filter(x=>x.source).length,2,'foreign snapshot never commits its event');
 await page.screenshot({path:join(output,'进度暂不可读-手机.png'),fullPage:true});feed='good';
 await page.waitForFunction(()=>document.querySelector('.execution-steps')?.textContent.includes('这一步已结束'),{},{timeout:20000});assert.equal(await steps.evaluate(e=>e.open),true);
 assert.doesNotMatch(await steps.innerText(),/正在整理执行步骤|正在生成文件/,'expanded starts are historical records, not simultaneous live work');
 assert.doesNotMatch(await page.locator('.execution-steps').innerText(),/正在生成文件/);
 assert.doesNotMatch(await page.locator('#execution-panel').innerText(),/PRIVATE_|export_document|tool_call/);assert.equal(submissions,1);
 await page.screenshot({path:join(output,'真实步骤已恢复-手机.png'),fullPage:true});
 emit({event:'execution_completed',description:'PRIVATE_FULL_OUTPUT'});status='completed';await execution.idle();
 await page.waitForFunction(()=>document.querySelector('#execution-panel > details > summary')?.textContent.includes('已结束'));
 await page.locator('#execution-panel > details > summary').click();await steps.waitFor();
 const record=page.locator('#execution-panel article');assert.doesNotMatch(await record.innerText(),/正在整理执行步骤|正在生成文件|PRIVATE_/);
 assert.match(await record.innerText(),/执行记录：生成文件/);assert.equal(submissions,1);
 const saved=repository.list(auth,scope,'execution_activity').filter(x=>x.source);assert.deepEqual(saved.map(x=>x.source.sequence),[1,2,3,4]);assert.equal(new Set(saved.map(x=>x.id)).size,4);
 const result=repository.list(auth,scope,'result')[0];assert.equal(repository.list(auth,scope,'result_review').length,0);assert.equal(repository.usageLedger(auth,scope).rows[0].paidUsd,null);
 await page.reload();await page.locator('nav [data-nav=results]').click();const card=page.locator(`[data-ai-id="result:${result.id}"]`);await card.waitFor();
 const receive=page.waitForEvent('download');await card.locator('[data-action=artifact-download]').click();const download=await receive;assert.deepEqual(readFileSync(await download.path()),bytes);
 assert.equal(repository.list(auth,scope,'attempt').length,1);assert.equal(submissions,1);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const ambiguous=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');availableOperations();return [...document.querySelectorAll('[data-ai-state=ambiguous]')].map(x=>x.dataset.aiId);});assert.deepEqual(ambiguous,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(output,'原任务成果-手机.png'),fullPage:true});
 writeFileSync(join(output,'result.json'),JSON.stringify({checks:['real adapter and authorized HTTP step feed to SQLite and mobile UI','fixed business labels; no private descriptions parameters or output','expanded step history survives polling and navigation','foreign progress page rejected; same cursor resumes after backoff','ended task has historical tense and no false human acceptance','reload and same-byte authenticated file download do not submit again','unknown usage remains unknown','no page errors external requests ambiguous controls or overflow'],sourceSequences:saved.map(x=>x.source.sequence),fixtureExecutions:submissions,activityReads,modelCalls:0,realProvider:false,streamingAnswerVerified:false},null,2));
 console.log('原任务进度、异常恢复和真实文件手机闭环通过，模型调用0。');
}catch(error){
 writeFileSync(join(output,'failure.json'),JSON.stringify({message:error.message,submissions,activityReads,status,events:events.length,modelCalls:0},null,2));await page?.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{await browser.close();await execution.close();await app.close();repository.close();await new Promise(yes=>engine.close(yes));rmSync(directory,{recursive:true,force:true});}
