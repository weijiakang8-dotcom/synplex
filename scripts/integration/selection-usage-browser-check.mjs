import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {EventEmitter} from 'node:events';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createCodexExecutor} from '../../adapters/execution/codex.mjs';
import * as context from '../../packages/context/index.mjs';

const driver=process.env.SYNPLEX_BROWSER_DRIVER;
if(!driver)throw new Error('Provide an already installed browser driver; no installation is performed');
const {chromium}=await import(pathToFileURL(resolve(driver)).href);
const dataDir=mkdtempSync(join(tmpdir(),'synplex-selection-ui-')),scope={projectId:'ui-cost-fixture',versionId:null,branchId:null};
const repository=new WorkspaceRepository({dataDir});
const human=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']});
const host=repository.createCredential({ownerId:'fixture',actorId:'host',scope,capabilities:['read_memory','prepare_task']});
const uiTokenFile=join(dataDir,'ui'),agentTokenFile=join(dataDir,'host');writeFileSync(uiTokenFile,human.token,{mode:0o600});writeFileSync(agentTokenFile,host.token,{mode:0o600});
const auth=repository.authenticate(human.token),calls=[];
class Rpc extends EventEmitter{
 async connect(){} close(){}
 async call(method,p){calls.push({method,model:p.model,effort:p.effort,provider:p.modelProvider});
  if(method==='thread/start'){writeFileSync(join(p.cwd,'演示成果.md'),'# 演示成果\n浏览器合成验证，不是模型交付。');return {thread:{id:'fixture-thread'}};}
  if(method==='turn/start'){setTimeout(()=>{
   this.emit('notification',{method:'thread/tokenUsage/updated',params:{threadId:'fixture-thread',tokenUsage:{total:{inputTokens:2000,outputTokens:100,cachedInputTokens:1000}}}});
   this.emit('notification',{method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed'}}});
  },0);return {turn:{id:'fixture-turn'}};}
  throw new Error(method);
 }
}
const adapter=createCodexExecutor({binary:'/fixture/codex',home:dataDir,dataDir:join(dataDir,'runs'),model:'one',provider:'fixture',allowedModels:[{id:'one',label:'基础型号',efforts:['low']},{id:'two',label:'深入型号',efforts:['low','high']}],rpcFactory:()=>new Rpc()});
const execution=new ExecutionCoordinator({repository,adapters:{codex:adapter}});
const localProjects=new LocalProjects({repository,dataDir,connection:{scope,uiTokenFile,agentTokenFile},rootAuth:auth,allowExecution:true});
const app=createWorkspaceServer({repository,modules:{context},localProjects,execution,publicDir:resolve('public')});
const url=await app.listen(),browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const pair=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pair.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('nav [data-nav="task"]').click();
 await page.locator('[name="goal"]').fill('完成一份项目说明');await page.locator('[name="acceptance"]').fill('交付可下载的说明');
 await page.locator('[name="executor"]').selectOption('codex');await page.locator('[data-ai-action="select_model"]').selectOption('two');await page.locator('[data-ai-action="select_effort"]').selectOption('high');
 await page.locator('nav [data-nav="history"]').click();await page.locator('nav [data-nav="task"]').click();assert.equal(await page.locator('[name="model"]').inputValue(),'two');
 await page.reload();await page.locator('nav [data-nav="task"]').click();assert.equal(await page.locator('[name="model"]').inputValue(),'two');assert.equal(await page.locator('[name="effort"]').inputValue(),'high');
 await page.locator('#task-form button.primary').click();await page.locator('[data-action="start-execution"]').click();await execution.idle();
 await page.locator('[data-action="refresh"]').click();
 const completed=page.locator('#execution-panel > details');await completed.locator('summary').first().click();
 await page.locator('.usage-details > summary').click();assert.match(await page.locator('.usage-details').innerText(),/账单金额：未知/);
 await page.locator('.usage-details details > summary').click();const form=page.locator('.usage-form');await form.locator('[name="costUsd"]').fill('0.012');await form.locator('[name="receiptReference"]').fill('合成账单第一行');await form.locator('button').click();
 await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('账单核对已保存'));
 const ledger=repository.usageLedger(auth,scope);assert.equal(ledger.rows.length,1);assert.equal(ledger.rows[0].paidUsd,0.012);assert.equal(ledger.rows[0].usage.model,'two');
 assert.deepEqual(calls,[{method:'thread/start',model:'two',effort:undefined,provider:'fixture'},{method:'turn/start',model:'two',effort:'high',provider:undefined}]);
 assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const out=resolve('.runtime/implementation-baseline');mkdirSync(out,{recursive:true});writeFileSync(join(out,'selection-usage-browser.json'),JSON.stringify({checks:['model and effort survive page switching','UI selection to frozen packet to RPC','real synthetic artifact collected','unknown costs stay unknown','invoice UI to SQLite','390px no overflow','no page errors'],calls,modelCalls:0},null,2));
 process.stdout.write('型号选择与账单页面端到端检查通过，模型调用0。\n');
}finally{await browser.close();await execution.close();await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});}
