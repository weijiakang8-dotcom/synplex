// Exercise only the evaluated adapter delta on a fresh independent product.
// Existing installations and saved model connections are never opened here.
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {verifyRelease} from '../runtime/release.mjs';
import {inspectDatabase} from '../runtime/recovery.mjs';
const [previous,candidate,environment,pgBin,valkey,evidence]=process.argv.slice(2).map(p=>resolve(p));
for(const release of [previous,candidate])verifyRelease(release);
assert.equal(existsSync(evidence),false,'preserve prior or interrupted evidence');mkdirSync(evidence,{mode:0o700});
const ports=[];while(ports.length<4){const socket=createServer();await new Promise(yes=>socket.listen(0,'127.0.0.1',yes));const port=socket.address().port;await new Promise(yes=>socket.close(yes));if(!ports.includes(port))ports.push(port);}
const {installInstance}=await import(pathToFileURL(join(previous,'scripts/runtime/install-instance.mjs')));
const instance=join(evidence,'instance');await installInstance({directory:instance,environment,backend:join(previous,'vendor/agenthub/backend'),pgBin,valkey,ports});
const workspace=join(instance,'workspace'),engine=join(instance,'engine'),python=join(environment,'bin/python'),saved=readFileSync(join(engine,'engine-startup.json'),'utf8');
function run(script,args){const result=spawnSync(python,['-B',script,...args],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});writeFileSync(join(evidence,'commands.log'),(result.stdout||'')+(result.stderr||''),{flag:'a',mode:0o600});assert.equal(result.status,0,'offline migration/backup command');}
let before=null;await opened(previous);
const snapshot=join(evidence,'before');run(join(previous,'integrations/agenthub/engine_recovery.py'),['backup',engine,snapshot]);
const migrate=resolve('scripts/runtime/patch-recovery-adapter.py'),base=['--previous',previous,'--candidate',candidate,'--engine',engine,'--node',process.execPath];
run(migrate,[...base,'--snapshot',snapshot]);
assert.equal(JSON.parse(readFileSync(join(engine,'recovery-adapter-migration.json'))).status,'applied');
async function opened(release){
 const {settings}=await import(pathToFileURL(join(release,'scripts/runtime/workspace.mjs'))),{superviseProduct}=await import(pathToFileURL(join(release,'scripts/runtime/product.mjs')));
 const managed=await superviseProduct(settings({dataDir:workspace,port:ports[0]}),{openBrowser:false});
 try{for(let n=0;n<450&&managed.state.status!=='ready';n++){assert.ok(!['startup_failed','engine_exited','workspace_exited'].includes(managed.state.status));await new Promise(yes=>setTimeout(yes,100));}assert.equal(managed.state.status,'ready');assert.equal((await fetch(`http://127.0.0.1:${ports[0]}/health`)).status,200);}
 finally{await managed.close();}
 const actual=inspectDatabase(join(workspace,'workspace.sqlite'));if(before)assert.deepEqual(actual,before);else before=actual;
}
await opened(candidate);
const rollbackSnapshot=join(evidence,'before-rollback');run(join(candidate,'integrations/agenthub/engine_recovery.py'),['backup',engine,rollbackSnapshot]);
run(migrate,[...base,'--snapshot',rollbackSnapshot,'--rollback']);
assert.deepEqual(JSON.parse(readFileSync(join(engine,'engine-startup.json'),'utf8')),JSON.parse(saved));await opened(previous);
writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['two immutable verified releases and exact evaluated recovery and executable-path delta','fresh independent engine migrated offline without task dispatch','candidate full product actually starts and shuts down','offline adapter rollback restores original identity and full product starts','workspace logical fingerprint preserved'],ports,modelCalls:0,realModelConnections:0,inFlightMigrationVerified:false},null,2),{mode:0o600,flag:'wx'});
console.log('精确恢复适配迁移、完整启动、离线回退与原版本启动通过；模型调用0。');
