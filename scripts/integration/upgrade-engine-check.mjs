import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {inspectDatabase} from '../runtime/recovery.mjs';
import {initializeInstallation,upgradeInstallation,rollbackInstallation,openInstallation} from '../runtime/upgrade.mjs';
import {verifyRelease} from '../runtime/release.mjs';

// Real independent PostgreSQL/queue/API/worker lifecycle. No saved model
// credentials, no workflow submissions, no existing user's installation.
const [first,second,incompatible,environment,pgBin,valkey,evidence]=process.argv.slice(2).map(p=>resolve(p));
for(const path of [first,second,incompatible])verifyRelease(path);
assert.equal(existsSync(evidence),false,'never repeat a completed or interrupted fixture');mkdirSync(evidence,{mode:0o700});
const ports=[];
while(ports.length<4){const socket=createServer();await new Promise(yes=>socket.listen(0,'127.0.0.1',yes));const port=socket.address().port;await new Promise(yes=>socket.close(yes));if(!ports.includes(port))ports.push(port);}
const instance=join(evidence,'instance'),installation=join(evidence,'installation');
const {installInstance}=await import(pathToFileURL(join(first,'scripts/runtime/install-instance.mjs')).href);
await installInstance({directory:instance,environment,backend:join(first,'vendor/agenthub/backend'),pgBin,valkey,ports});
const dataDir=join(instance,'workspace'),engineRoot=join(instance,'engine');
const connection=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8'));
const pointers=()=>readFileSync(join(installation,'installation.json'),'utf8');
let managed;
async function opened(){
 const events=[];managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});
 const deadline=Date.now()+45000;
 while(!events.length&&Date.now()<deadline)await new Promise(yes=>setTimeout(yes,40));
 assert.ok(events.length,'readiness received');assert.equal(events[0].error,undefined);
 assert.equal((await fetch(connection.endpoint+'/health')).status,200);
 // Read-only live engine proof, beyond a workspace-only health check.
 const check=`import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom local_runner import private_read,database_connection\nimport psycopg,redis\nd=private_read(Path(sys.argv[2])/'engine/bootstrap.json')\nwith psycopg.connect(**database_connection(d,d['database'])) as db:\n assert db.execute('SELECT count(*) FROM executions').fetchone()[0]==0\nr=redis.Redis(host='127.0.0.1',port=d['redis_port'],password=d['redis_password'])\nassert r.ping();assert r.llen('synplex-isolated')==0;r.close()\nprint('live independent engine; executions=0; modelCalls=0')`;
 const result=spawnSync(join(environment,'bin/python'),['-B','-c',check,join(first,'integrations/agenthub'),engineRoot],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,'live PostgreSQL and queue checks');
 await managed.close();managed=null;
}
async function save(text){
 const repository=new WorkspaceRepository({dataDir});
 try{const auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim()),scope=await repository.forScope(auth,connection.scope);
  return (await scope.saveBlob({bytes:Buffer.from(text),format:'text/plain'},{requestId:randomUUID(),expectedStateRevision:(await scope.getState()).stateRevision})).value;
 }finally{repository.close();}
}
try{
 const original=await save('程序升级前的原文件不能丢失。');await initializeInstallation(installation,first,dataDir);await opened();
 const beforePointer=pointers(),before=inspectDatabase(join(dataDir,'workspace.sqlite'));
 await assert.rejects(upgradeInstallation(installation,incompatible),/执行环境不兼容/);
 assert.equal(pointers(),beforePointer);assert.equal(existsSync(join(installation,'.upgrade-lock')),false);assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),before);
 await upgradeInstallation(installation,second);await opened();
 const later=await save('新版新增的资料在回退程序后仍需保留。'),latest=inspectDatabase(join(dataDir,'workspace.sqlite'));
 await rollbackInstallation(installation);await opened();assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),latest);
 const repository=new WorkspaceRepository({dataDir});
 try{const auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim());
  for(const blob of [original,later])assert.equal(repository.getBlob(auth,connection.scope,blob.id).blob.sha256,blob.sha256);
  assert.equal(repository.list(auth,connection.scope,'attempt').length,0);
 }finally{repository.close();}
 assert.equal(JSON.parse(pointers()).current.path,first);
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['real independently installed database, queue, API and worker','incompatible engine adapter rejected before pointer/lock/data change','compatible packaged version starts full product after upgrade','rollback restarts full product with original and newer files intact','business fingerprint preserved by code rollback','no task submitted or replayed'],ports,originalSha256:original.sha256,laterSha256:later.sha256,beforeHash:before.contentHash,latestHash:latest.contentHash,modelCalls:0,engineMigrationVerified:false,inFlightRecoveryVerified:false},null,2),{flag:'wx',mode:0o600});
 console.log('完整独立产品兼容升级／回退通过；不同执行适配程序在切换前拒绝，原件与新增资料保留，模型调用0。');
}finally{await managed?.close();}
