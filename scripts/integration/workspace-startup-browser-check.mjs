import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';

const output=browserEvidenceDirectory('workspace-startup','SYNPLEX_STARTUP_EVIDENCE_DIR');
const dir=mkdtempSync(join(tmpdir(),'synplex-startup-')),repository=new WorkspaceRepository({dataDir:dir});
const scope={projectId:'startup-fixture',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory']});
const auth=repository.authenticate(credential.token),options={repository,publicDir:resolve('public'),publicLanding:true};
const app=createWorkspaceServer(options),other=createWorkspaceServer(options);
const url=await app.listen(),otherUrl=await other.listen(),browser=await launchTestBrowser();
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],writes=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{
  const request=route.request(),target=new URL(request.url());
  if(![url,otherUrl].includes(target.origin))throw Error('Unexpected external request');
  if(request.method()==='POST')writes.push(target.pathname);
  return route.continue();
 });
 async function pair(instance,endpoint){
  const pairing=await instance.createUiPairing(auth,scope);
  assert.equal((await page.request.post(endpoint+'/api/v1/ui_pair',{form:{pair:pairing.nonce},maxRedirects:0})).status(),303);
 }
 async function ready(){await page.locator('#workspace-main').waitFor();assert.equal(await page.locator('#connection-form').count(),0);}
 await pair(app,url);await page.goto(url+'/app');await ready();
 await pair(other,otherUrl);await page.goto(otherUrl+'/app');await ready();
 await page.goto(url+'/app');await ready();
 for(let i=0;i<2;i++){await page.reload();await ready();}
 async function fails(path,handle){
  await page.route(url+path,handle);await page.reload();
  await page.locator('[data-startup-retry]').waitFor();assert.equal(await page.locator('#connection-form').count(),0);
  await page.unroute(url+path,handle);await page.locator('[data-startup-retry]').click();await ready();
 }
 await fails('/api/v1/ui_bootstrap',route=>route.fulfill({status:502,json:{message:'fixture temporary service failure'}}));
 await fails('/api/v1/ui_bootstrap',route=>route.abort('connectionfailed'));
 await fails('/api/v1/ui_bootstrap',route=>route.fulfill({status:200,contentType:'text/plain',body:'not JSON'}));
 await fails('/api/v1/ui_history',route=>route.fulfill({status:403,json:{code:'scope_denied'}}));
 await fails('/api/v1/ui_history',route=>route.fulfill({status:503,json:{code:'capability_unavailable'}}));
 const anonymous=await browser.newPage();await anonymous.goto(url+'/app');
 // newPage shares a browser, but creates an independent browser context.
 await anonymous.locator('#connection-form').waitFor();await anonymous.close();
 assert.deepEqual(errors,[]);
 assert.ok(writes.every(path=>path==='/api/v1/ui_history'),'loading/retry must never replay a task, save settings or send a model request');
 await page.screenshot({path:join(output,'刷新恢复-桌面.png'),fullPage:true});
 writeFileSync(join(output,'result.json'),JSON.stringify({modelCalls:0,checks:['two instances stay connected in one cookie jar','two reloads retain authentication','502/network/invalid response show retry instead of pairing','authorized history failures preserve authentication','explicit retry only rereads saved state','anonymous context still requires one-time pairing'],unexpectedPageErrors:errors},null,2),{flag:'wx',mode:0o600});
 console.log('刷新与双实例登录隔离、故障提示及只读重试通过；模型调用0。');
}finally{await browser.close();await app.close();await other.close();repository.close();rmSync(dir,{recursive:true,force:true});}
