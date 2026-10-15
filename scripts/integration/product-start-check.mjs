import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {settings,supervise} from '../runtime/workspace.mjs';
import {configureProduct,superviseProduct} from '../runtime/product.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {inspectDatabase} from '../runtime/recovery.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {DatabaseSync} from 'node:sqlite';

function databaseEvidence(file){
 const data=inspectDatabase(file),db=new DatabaseSync(file,{readOnly:true});
 try{
  const tables=['schema_versions','scopes','records','receipts','authorizations','outbox','quarantined_conflicts'];
  const businessHash=payloadHash(tables.map(name=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]).concat([['raw_blobs',db.prepare('SELECT owner_id,sha256,length(bytes) byteLength FROM raw_blobs ORDER BY rowid').all()]]));
  const credentials=db.prepare('SELECT * FROM credentials ORDER BY rowid').all().map(row=>({id:row.id,hash:payloadHash({...row}),actor:row.actor_id,kind:row.kind,capabilities:JSON.parse(row.capabilities_json)}));
  return {data,businessHash,credentials};
 }finally{db.close();}
}
function verifyData(before,after){
 assert.equal(after.businessHash,before.businessHash,'business data, receipts, original hashes and permissions');
 for(const credential of before.credentials)assert.deepEqual(after.credentials.find(c=>c.id===credential.id),credential);
 const added=after.credentials.filter(c=>!before.credentials.some(p=>p.id===c.id));assert.ok(added.length<=1,'at most one explicitly configured execution credential');
 for(const c of added){assert.equal(c.actor,'local-human');assert.equal(c.kind,'ui');assert.deepEqual([...c.capabilities].sort(),['execute','prepare_task','read_memory','record_result','review_memory','write_memory']);}
}

const [python,backend,pgBin,valkey,evidence]=process.argv.slice(2).map(p=>resolve(p));
const resume=process.argv.includes('--resume');if(!resume)mkdirSync(evidence,{mode:0o700});
const engineRoot=join(evidence,'engine'),dataDir=join(evidence,'workspace'),ports=[];
const freePort=async()=>{const s=createServer();await new Promise(yes=>s.listen(0,'127.0.0.1',yes));const p=s.address().port;await new Promise(yes=>s.close(yes));return p;};
while(ports.length<4){const p=await freePort();if(!ports.includes(p))ports.push(p);}
const script=`import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom engine_runtime import setup\nsetup(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[4]),Path(sys.argv[5]),api_port=int(sys.argv[6]),redis_port=int(sys.argv[7]),database_port=int(sys.argv[8]))\n`;
if(!resume){const setup=spawnSync(python,['-B','-c',script,resolve('integrations/agenthub'),engineRoot,backend,pgBin,valkey,...ports.slice(1).map(String)],{encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 writeFileSync(join(evidence,'setup.log'),setup.stdout+'\n'+setup.stderr,{mode:0o600});assert.equal(setup.status,0,'independent setup');mkdirSync(dataDir,{mode:0o700});
}else{
 assert.equal(existsSync(join(evidence,'result.json')),false,'A successful scenario must not be repeated');
 const saved=JSON.parse(readFileSync(join(engineRoot,'engine-startup.json'),'utf8')),connection=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8'));
 ports.splice(0,4,Number(new URL(connection.endpoint).port),saved.apiPort,saved.redisPort,saved.databasePort);
}
const config=settings({dataDir,port:ports[0]}),events=[];let web,product;
const ready=async predicate=>{const deadline=Date.now()+45000;while(!predicate()&&Date.now()<deadline)await new Promise(yes=>setTimeout(yes,50));assert.ok(predicate(),'service readiness');};
try{
 if(!resume){web=await supervise(config,{openBrowser:false,onReady:e=>events.push(e)});await ready(()=>events.length);assert.equal(events[0].error,undefined);await web.close();}
 const c=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8')),repository=new WorkspaceRepository({dataDir}),auth=repository.authenticate(readFileSync(c.uiTokenFile,'utf8').trim()),repo=await repository.forScope(auth,config.scope);
 const source=resume?repository.list(auth,config.scope,'source')[0]:(await repo.saveBlob({bytes:Buffer.from('真实联合启动，原件和账本不得改变。'),format:'text/plain'},{requestId:'product-start-source',expectedStateRevision:0})).value;repository.close();
 const identity=JSON.parse(readFileSync(join(engineRoot,'engine/bootstrap.json'),'utf8'));
 if(!resume)writeFileSync(join(dataDir,'executors.json'),JSON.stringify({synplex:{endpoint:`http://127.0.0.1:${ports[1]}`,workflowId:identity.workflow_id,tokenFile:join(engineRoot,'engine/access-token'),requireWorkerReceipt:true}}),{mode:0o600,flag:'wx'});
 await configureProduct(config,{python,engineRoot});const before=databaseEvidence(join(dataDir,'workspace.sqlite'));
 writeFileSync(join(evidence,'before-start.json'),JSON.stringify(before,null,2),{flag:'wx',mode:0o600});
 product=await superviseProduct(config,{openBrowser:false,onReady:e=>events.push(e)});await ready(()=>['ready','startup_failed'].includes(product.state.status));assert.equal(product.state.status,'ready');
 const token=readFileSync(join(engineRoot,'engine/access-token'),'utf8').trim(),headers={Authorization:'Bearer '+token};
 const response=await fetch(`http://127.0.0.1:${ports[1]}/api/workflows/${identity.workflow_id}`,{headers});assert.equal(response.status,200);assert.equal((await response.json()).id,identity.workflow_id);
 const checkScript=`import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom local_runner import private_read,database_connection\nimport psycopg\nd=private_read(Path(sys.argv[2])/'engine/bootstrap.json')\nassert d['model_mode']=='disabled'\nwith psycopg.connect(**database_connection(d,d['database'])) as db:\n assert db.execute('SELECT count(*) FROM executions').fetchone()[0]==0\nprint('disabled provider; executions=0; modelCalls=0')`;
 const engineCheck=spawnSync(python,['-B','-c',checkScript,resolve('integrations/agenthub'),engineRoot],{encoding:'utf8',timeout:15000});writeFileSync(join(evidence,'engine-check.log'),engineCheck.stdout+'\n'+engineCheck.stderr,{mode:0o600});assert.equal(engineCheck.status,0);
 const duplicate=await superviseProduct(config,{openBrowser:false});assert.equal(duplicate.existing,true);await duplicate.close();assert.equal((await fetch(config.endpoint+'/health')).ok,true);
 await product.close();const after=databaseEvidence(join(dataDir,'workspace.sqlite'));
 writeFileSync(join(evidence,'after-stop.json'),JSON.stringify(after,null,2),{flag:'wx',mode:0o600});verifyData(before,after);
 const reopened=new WorkspaceRepository({dataDir}),fresh=reopened.authenticate(readFileSync(c.uiTokenFile,'utf8').trim());assert.equal(reopened.getBlob(fresh,config.scope,source.id).blob.sha256,source.sha256);assert.equal(reopened.list(fresh,config.scope,'attempt').length,0);reopened.close();
 for(const port of ports){const s=createServer();await new Promise((yes,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',yes);});await new Promise(yes=>s.close(yes));}
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['actual independently installed environment verified','fresh private PostgreSQL and Valkey','one supervisor starts real engine and workspace','authenticated expected workflow identity','duplicate open does not own existing shutdown','owned API worker database queue and workspace all release their ports','business and original fingerprints retained; only configured local execution credential may be added','provider disabled, execution and workspace attempts zero'],databaseHash:after.businessHash,sourceSha256:source.sha256,ports,modelCalls:0,realModelVerified:false},null,2),{mode:0o600});console.log('真实联合启动、重复打开和受控关闭通过；四个端口释放，原件与业务指纹保全，模型调用0。');
}finally{await product?.close();await web?.close();}
