// Install and start the actual complete product in a fresh private directory.
// No fake service, provider request, production volume or active host is used.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {installInstance} from '../runtime/install-instance.mjs';
import {superviseProduct} from '../runtime/product.mjs';
import {settings} from '../runtime/workspace.mjs';
import {inspectDatabase} from '../runtime/recovery.mjs';

const file=resolve(process.argv[2]),options=JSON.parse(readFileSync(file,'utf8'));
if(!process.argv.includes('--resume'))assert.equal(existsSync(options.directory),false,'Preserve prior installation and evidence');
else assert.equal(existsSync(join(options.directory,'install-receipt.json')),true);
let managed;
try{
 const installed=await installInstance(options),config=settings({dataDir:installed.dataDir,port:options.ports[0]});assert.equal(installed.modelCalls,0);
 assert.equal((await installInstance(options)).existing,true);
 managed=await superviseProduct(config,{openBrowser:false});
 for(let i=0;i<450&&managed.state.status!=='ready';i++){if(['startup_failed','engine_exited','workspace_exited'].includes(managed.state.status))throw Error(managed.state.status);await delay(100);}
 assert.equal(managed.state.status,'ready');
 const health=await fetch(config.endpoint+'/health');assert.equal(health.status,200);
 const home=await fetch(config.endpoint);assert.match(await home.text(),/把模糊问题变成有依据的结构化系统/);
 const connection=JSON.parse(readFileSync(join(config.dataDir,'connection.json'),'utf8')),token=readFileSync(connection.uiTokenFile,'utf8').trim();
 const launch=await fetch(config.endpoint+'/api/v1/ui_launch',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:connection.scope})}).then(r=>r.json());
 const paired=await fetch(config.endpoint+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:launch.nonce}),redirect:'manual'});assert.equal(paired.status,303);
 const bootstrap=await fetch(config.endpoint+'/api/v1/ui_bootstrap',{headers:{Cookie:paired.headers.get('set-cookie').split(';')[0]}}).then(r=>r.json());
 assert.equal(bootstrap.capabilities.chat,true);assert.equal(bootstrap.capabilities.execution,true);assert.equal(bootstrap.capabilities.executors[0].owner,'synplex');assert.equal(bootstrap.capabilities.executors[0].selectionChoices.length,0);
 const before=inspectDatabase(join(config.dataDir,'workspace.sqlite'));assert.equal(before.unresolved,0);
 await managed.close();managed=null;
 assert.deepEqual(inspectDatabase(join(config.dataDir,'workspace.sqlite')),before);
 writeFileSync(join(options.directory,'validation.json'),JSON.stringify({modelCalls:0,checks:['fresh complete install uses supplied independent environment','repeat install verifies without reinitializing','actual Postgres queue API worker and Node workspace start together','public landing and private bootstrap report chat and real engine','no model silently enabled before user saves a connection','supervised shutdown preserves logical data fingerprint'],containerVerified:false,hash:before.contentHash},null,2),{mode:0o600,flag:'wx'});
 console.log('完整产品从空目录安装和联合启动通过；正常关闭后数据一致。模型调用0，Linux容器尚未验证。');
}finally{await managed?.close();}
