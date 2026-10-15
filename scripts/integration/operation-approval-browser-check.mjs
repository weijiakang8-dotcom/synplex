import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import * as context from '../../packages/context/index.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';
import {checkWorkspaceLayout} from './layout-browser-check.mjs';
const {chromium}=await import(pathToFileURL(resolve(process.env.SYNPLEX_BROWSER_DRIVER)).href);
const evidence=resolve(process.env.SYNPLEX_APPROVAL_EVIDENCE_DIR??'.runtime/implementation-baseline/operation-approval-browser-r1');mkdirSync(evidence,{mode:0o700});
const directory=mkdtempSync(join(tmpdir(),'synplex-approval-ui-')),repository=new WorkspaceRepository({dataDir:directory}),scope={projectId:'approval-ui',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']}),auth=repository.authenticate(credential.token);
let executions=0,effects=0,choices=[];
const adapter={mode:'platform_owned',async execute(input){
 executions++;
 if(input.packet.taskInputs?.some(x=>x.role==='previous_version')){
  assert.match(input.packet.goal,/不发送邮件/);assert.match(input.packet.taskInputs.at(-1).summary,/拒绝/);
  const bytes=Buffer.from('# 项目报告\n只生成文件，不发送邮件。'),artifact={id:'report',name:'项目报告.md',uri:'synplex-artifact:report',sha256:sha256(bytes),byteLength:bytes.length,mediaType:'text/markdown',verification:'reported'};
  return {status:'succeeded',result:{eventId:input.operationId,attemptId:input.attemptId,provider:'fixture',summary:'已按新要求生成本地文件，没有发送邮件。',artifacts:[artifact],checks:[],usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null},files:[{artifactId:'report',bytes}]};
 }
 const prompt={remoteRequestId:randomUUID(),threadId:randomUUID(),turnId:randomUUID(),itemId:'a'.repeat(64),
  approval:{snapshotHash:'a'.repeat(64),operations:[{tool:'send_email',params:{to:'fixture@synplex.invalid',subject:'确认后的项目报告',body:'<script>globalThis.approvalExecuted=true</script>\n只作隔离测试，不发邮件。'}}]},
  questions:[{id:'approval',header:'确认操作',question:'是否允许执行下面的操作？只确认本次列出的内容，拒绝后不会执行这些操作。',isSecret:false,isOther:false,
   options:[{label:'拒绝操作',description:'不执行列出的操作，已有资料和成果保留。'},{label:'允许这次操作',description:'只执行列出的操作。'}]}]};
 const answer=await input.requestInput(prompt);if(!answer)throw Error('Fixture approval was not answered');
 const selected=answer.answers.approval.answers[0];choices.push(selected);if(selected==='允许这次操作')effects++;
 input.inputDelivered(answer.questionId);
 return {status:selected==='允许这次操作'?'succeeded':'failed',result:{eventId:input.operationId,attemptId:input.attemptId,provider:'fixture',
  summary:selected==='允许这次操作'?'隔离操作标记完成，没有发送邮件。':'你已拒绝操作，没有发送邮件。',artifacts:[],checks:[],
  usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null}};
}};
const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter}}),app=createWorkspaceServer({repository,modules:{context},execution,publicDir:resolve('public')}),url=await app.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
let page;
try{
 page=await browser.newPage({viewport:{width:390,height:844}});const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin===url)return route.continue();external.push(route.request().url());return route.abort();});
 const pairing=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pairing.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('nav [data-nav=task]').click();
 const form=page.locator('#task-form');await form.locator('[name=goal]').fill('准备项目报告，发送前让我确认');await form.locator('[name=acceptance]').fill('操作内容需要我逐次确认');await form.locator('[name=executor]').selectOption('synplex');
 await form.locator('button.primary').click();await page.locator('[data-action=start-execution]').click();
 const approval=page.locator('.question-form');await approval.waitFor();assert.equal(effects,0);assert.equal(await approval.locator('input:checked').count(),0);
 assert.match(await approval.innerText(),/发送邮件/);assert.match(await approval.innerText(),/收件人/);assert.match(await approval.innerText(),/固定|确认后的项目报告/);
 assert.match(await approval.locator('button.primary').innerText(),/提交选择/);assert.equal(await approval.locator('input[type=text]').count(),0);
 assert.equal(await page.evaluate(()=>globalThis.approvalExecuted),undefined);assert.match(await approval.locator('..').innerText(),/等待确认/);
 await page.reload();await approval.waitFor();assert.equal(effects,0);assert.equal(executions,1);assert.equal(await approval.locator('input:checked').count(),0);
 const layout=process.env.SYNPLEX_LAYOUT_CHECK==='1'?await checkWorkspaceLayout(page,evidence):null;
 assert.equal(executions,1);assert.equal(effects,0);
 await page.screenshot({path:join(evidence,'操作确认-手机.png'),fullPage:true});
 await approval.locator('input[value="拒绝操作"]').check();await approval.locator('button.primary').click();await execution.idle();
 assert.deepEqual(choices,['拒绝操作']);assert.equal(effects,0);assert.equal(executions,1);assert.equal(repository.list(auth,scope,'result').length,1);
 await page.reload();await page.locator('#task-form').waitFor();assert.equal(executions,1);assert.equal(effects,0);
 const questions=repository.list(auth,scope,'execution_question');assert.equal(questions.length,1);assert.equal(questions[0].answers.approval.answers[0],'拒绝操作');assert.equal(questions[0].delivery,'sent');
 const rejected=repository.list(auth,scope,'result')[0];assert.equal(repository.list(auth,scope,'attempt')[0].status,'failed');
 await page.locator('nav [data-nav=results]').click();
 const card=page.locator(`[data-ai-id="result:${rejected.id}"]`),revision=card.locator('.result-revision-form');
 await revision.locator('..').locator('summary').click();await revision.locator('textarea').fill('不发送邮件，仅生成可下载的项目报告，保留原资料。');
 await revision.locator('button').click();await page.locator('[data-action=start-execution]').waitFor();
 assert.equal(executions,1,'Preparing changed requirements must not restart the rejected operation');assert.equal(effects,0);
 await page.reload();await page.locator('[data-action=start-execution]').waitFor();assert.equal(executions,1);
 const started=page.waitForResponse(r=>r.url()===url+'/api/v1/execute_task');
 await page.locator('[data-action=start-execution]').click();assert.equal((await started).status(),202);await execution.idle();
 const all=repository.list(auth,scope,'result');assert.equal(all.length,2);assert.equal(executions,2);assert.equal(effects,0);assert.deepEqual(choices,['拒绝操作']);
 const changed=all.find(r=>r.id!==rejected.id);assert.equal(repository.artifactFile(auth,scope,changed.id,'report').bytes.toString(),'# 项目报告\n只生成文件，不发送邮件。');
 assert.equal(repository.resultVersions(auth,scope,changed.id).versionCount,2);assert.equal(repository.usageLedger(auth,scope).rows.length,2);assert.equal(repository.list(auth,scope,'result_review').length,0);
 await page.reload();await page.locator('#task-form').waitFor();assert.equal(executions,2);assert.equal(repository.list(auth,scope,'execution_question').length,1);
 await page.locator('nav [data-nav=results]').click();await page.locator(`[data-ai-id="result:${changed.id}"]`).waitFor();
 await page.screenshot({path:join(evidence,'修改后成果-手机.png'),fullPage:true});
 const ambiguous=await page.evaluate(async()=>{const {annotateActions}=await import('/semantic-actions.js');annotateActions();return [...document.querySelectorAll('[data-ai-state=ambiguous]')].map(e=>e.dataset.aiId);});assert.deepEqual(ambiguous,[]);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['full frozen operation shown as escaped text','no selection/default approval or freeform authorization','reload keeps the same pending question without executing','explicit rejection records choice and produces no effect','changed requirements prepare without execution and survive reload','explicit continuation creates a real file, preserves the rejection and both usage entries','final reload never repeats either task','no page errors, ambiguity, external requests or mobile overflow'],layout,fixtureExecutions:executions,effects,modelCalls:0,realProvider:false},null,2));console.log('操作确认与修改后继续的真实手机页面通过；模型调用0。');
}catch(error){writeFileSync(join(evidence,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,executions,effects,choices,modelCalls:0},null,2));if(page)await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});throw error;
}finally{
 await browser.close();
 for(const job of repository.list(auth,scope,'execution_job')){
  const operation=repository.operation(auth,scope,job.id);
  if(['queued','running','unknown'].includes(operation.status))await execution.cancel(auth,scope,operation.id);
 }
 await execution.close();await app.close();repository.close();rmSync(directory,{recursive:true,force:true});
}
