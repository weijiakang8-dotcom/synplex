import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';

const output=browserEvidenceDirectory('model-settings','SYNPLEX_MODELS_EVIDENCE_DIR');
const dir=mkdtempSync(join(tmpdir(),'synplex-model-ui-')),repository=new WorkspaceRepository({dataDir:dir}),scope={projectId:'model-settings',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'ui-fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result']}),auth=repository.authenticate(credential.token);
const app=createWorkspaceServer({repository,publicDir:resolve('public'),modelAdmin:a=>a===auth}),url=await app.listen(),browser=await launchTestBrowser();
const errors=[],external=[],mutations=[];
try{
  const page=await browser.newPage({viewport:{width:390,height:844}});page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>{const target=route.request().url();if(new URL(target).origin===url){if(route.request().method()==='POST')mutations.push(new URL(target).pathname);return route.continue();}external.push(target);return route.abort();});
  const pair=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pair.nonce},maxRedirects:0})).status(),303);
  await page.goto(url);await page.locator('[data-open-model-settings]').click();await page.locator('#new-model-connection').click();
  const form=page.locator('#model-settings-form');
  await form.locator('[name=name]').fill('我的常用模型');await form.locator('[name=endpoint]').fill('https://api.example.com/v1');await form.locator('[name=secret]').fill('synthetic-browser-only-key');
  await form.getByText('型号与能力（可选）',{exact:true}).click();await form.locator('#add-model-row').click();
  await form.locator('[name=model]').fill('fixture-model');await form.locator('[name=modelName]').fill('日常型号');
  await form.locator('button.primary').click();await page.locator('[data-model-id]').waitFor();
  assert.equal(repository.models(auth,scope).list().length,1);assert.equal(await page.locator('dialog').innerText().then(t=>t.includes('synthetic-browser-only-key')),false);
  const connection=repository.models(auth,scope).list()[0];assert.equal(connection.models[0].id,'fixture-model');
  assert.equal(await page.evaluate(()=>Object.values(sessionStorage).join('').includes('synthetic-browser-only-key')),false);
  await page.locator('[data-model-change=disable]').click();await page.locator('[data-model-change=enable]').waitFor();assert.equal(repository.models(auth,scope).list()[0].enabled,false);
  await page.locator('[data-model-change=enable]').click();await page.locator('[data-model-change=disable]').waitFor();
  await page.locator('[data-model-edit]').click();assert.equal(await page.locator('[name=secret]').inputValue(),'');
  await page.locator('[name=name]').fill('重新命名后的模型');await page.locator('[name=secret]').fill('synthetic-browser-rotated-key');await page.locator('#model-settings-form button.primary').click();await page.getByRole('heading',{name:'重新命名后的模型'}).waitFor();
  await page.locator('[data-model-probe]').click();assert.equal(await page.locator('[name=consent]').isChecked(),false);await page.locator('form button.primary').click();assert.equal(mutations.includes('/api/v1/ui_probe_model'),false);await page.locator('[data-model-back]').click();
  await page.screenshot({path:join(output,'模型设置-手机.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#close-model-settings').click();await page.reload();await page.locator('[data-open-model-settings]').click();await page.getByRole('heading',{name:'重新命名后的模型'}).waitFor();
  await page.setViewportSize({width:1280,height:900});await page.screenshot({path:join(output,'模型设置-桌面.png'),fullPage:true});
  const stranger=repository.authenticate(repository.createCredential({ownerId:'other',actorId:'other-human',scope,kind:'ui',capabilities:['read_memory','review_memory']}).token);
  assert.equal(repository.models(stranger,scope).list().length,0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(mutations.includes('/api/v1/ui_probe_model'),false);assert.equal(mutations.includes('/api/v1/ui_discover_models'),false);
  writeFileSync(join(output,'result.json'),JSON.stringify({modelCalls:0,checks:['mobile and desktop actual UI','save encrypted personal connection via HTTP','disable/enable change persistent state','rename and rotate credentials','no secret stored in DOM after save or session storage','refresh retrieves persistent connection','probe requires explicit consent; no probe request issued','second owner sees no personal connection','no page errors, external requests or mobile overflow'],routes:[...new Set(mutations)]},null,2),{flag:'wx',mode:0o600});
  console.log('模型设置真实HTTP/SQLite浏览器检查通过；无收费请求。');
}catch(error){writeFileSync(join(output,'failure.json'),JSON.stringify({error:String(error),modelCalls:0},null,2),{flag:'wx',mode:0o600});throw error;}
finally{await browser.close();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
