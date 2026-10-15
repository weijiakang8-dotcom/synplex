import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {settings,supervise} from '../../scripts/runtime/workspace.mjs';
import {configureProduct,superviseProduct,productConfiguration,writeProductLauncher} from '../../scripts/runtime/product.mjs';
import {snapshotWorkspace,restoreWorkspace} from '../../scripts/runtime/recovery.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';

const python='/usr/bin/python3',pause=ms=>new Promise(yes=>setTimeout(yes,ms));
async function until(predicate,label){const deadline=Date.now()+15000;while(!predicate()&&Date.now()<deadline)await pause(20);assert.ok(predicate(),label);}
async function freePort(){const s=createServer();await new Promise(yes=>s.listen(0,'127.0.0.1',yes));const p=s.address().port;await new Promise(yes=>s.close(yes));return p;}
const write=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600});
const fakeEngine=`import json,signal,sys,time,socket,os
from pathlib import Path
assert os.environ.get('HOME')
root=Path(sys.argv[-1]);saved=json.loads((root/'engine-startup.json').read_text())
if sys.argv[1]=='check':sys.exit(0)
stopping=False
def stop(*args):
 global stopping
 stopping=True
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
print('fixture-private-value-never-relay',file=sys.stderr,flush=True)
sock=socket.socket();sock.bind(('127.0.0.1',saved['apiPort']));sock.listen()
(root/'fixture-started').write_text('owned')
try:
 if (root/'delay-ready').exists():
  while not stopping:time.sleep(.02)
 else:
  print(json.dumps({'format':'synplex.engine-ready/1','endpoint':'http://127.0.0.1:'+str(saved['apiPort']),'providerConfigured':False}),flush=True)
  while not stopping:time.sleep(.02)
finally:sock.close()
`;

test('引擎源码身份在启动与恢复写入前核对；同字节迁移可用，旧记录和改动不能悄悄启用',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-source-identity-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=spawnSync(python,['-I','-B',resolve('test/execution/engine-source-check.py'),resolve('integrations/agenthub'),dir],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/modelCalls=0/);
});

test('独立模型连接限制准确厂商、型号、私有密钥和目的地址，旧连接不变',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-provider-guards-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const result=spawnSync(python,['-I','-B',resolve('test/execution/provider-contracts.py'),resolve('integrations/agenthub'),dir],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/"modelCalls": 0/);
});

test('实际Mac入口保留失败退出码；仅升级可识别的本人启动文件，不覆盖其他入口',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-launcher-status-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const bin=join(dir,'bin');mkdirSync(bin);writeFileSync(join(bin,'node'),'#!/bin/zsh\nexit 42\n',{mode:0o700});
 for(const name of ['打开Synplex.command','检查工作台.command'])assert.equal(spawnSync('/bin/zsh',[resolve(name)],{input:'\n',env:{...process.env,PATH:bin},encoding:'utf8',timeout:10000}).status,42);
 const file=join(dir,'打开Synplex.command');writeProductLauncher(dir);const current=readFileSync(file,'utf8');
 writeFileSync(file,current.replace('synplexStatus=$?\n','').replace('[[ $synplexStatus -ne 0 ]]','[[ $? -ne 0 ]]').replace('exit "$synplexStatus"\n',''));writeProductLauncher(dir);assert.equal(readFileSync(file,'utf8'),current);writeProductLauncher(dir);
 writeFileSync(join(dir,'restore-incomplete.json'),'{}',{mode:0o600});const failed=spawnSync('/bin/zsh',[file],{input:'\n',encoding:'utf8',timeout:10000});assert.equal(failed.status,1);assert.match(failed.stderr,/恢复目录|启动检查/);assert.equal(existsSync(join(dir,'workspace.sqlite')),false);
 writeFileSync(file,'#!/bin/zsh\n# unrelated private launcher\n');assert.throws(()=>writeProductLauncher(dir),/未覆盖/);assert.match(readFileSync(file,'utf8'),/unrelated private/);
});

test('联合启动正常关闭、重复打开、执行环境故障、启动中取消和恢复停用都保留原资料与未知任务',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-product-')),dataDir=join(dir,'workspace'),engineRoot=join(dir,'engine');
 mkdirSync(dataDir,{mode:0o700});mkdirSync(engineRoot,{mode:0o700});mkdirSync(join(engineRoot,'engine'),{mode:0o700});
 const ports=[];while(ports.length<4){const port=await freePort();if(!ports.includes(port))ports.push(port);}
 const config=settings({dataDir,port:ports[0]}),events=[];let managed,web;
 t.after(async()=>{await managed?.close();await web?.close();rmSync(dir,{recursive:true,force:true});});
 web=await supervise(config,{openBrowser:false,onReady:e=>events.push(e)});await until(()=>events.length,'initial workspace');await web.close();
 const startup={format:'synplex.engine-startup/1',apiPort:ports[1],redisPort:ports[2],databasePort:ports[3],infrastructureId:'fixture-infrastructure',lockSha256:'fixture-lock',backend:'fixture-source',providerConfigured:false};
 write(join(engineRoot,'engine-startup.json'),startup);write(join(engineRoot,'engine/bootstrap.json'),{id:'fixture-engine',api_port:ports[1],redis_port:ports[2],workflow_id:'fixture-workflow'});
 const engineScript=join(dir,'fake_engine.py');writeFileSync(engineScript,fakeEngine);const status=[];
 // configureProduct uses the actual verifier. The fake environment is not an
 // installable product: write only this test's explicit fixture configuration.
 const identity={engineId:'fixture-engine',infrastructureId:startup.infrastructureId,lockSha256:startup.lockSha256,backend:startup.backend,providerConfigured:false,apiPort:ports[1],redisPort:ports[2],databasePort:ports[3],workflowId:'fixture-workflow'};
 const connection=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8'));
 write(join(dataDir,'product-start.json'),{format:'synplex.product-start/1',workspaceDataDir:realpathSync(dataDir),engineRoot,python,identity});
 const db=new DatabaseSync(join(dataDir,'workspace.sqlite')),partition=db.prepare('SELECT partition FROM scopes LIMIT 1').get().partition;
 const unknown={id:'retained-unknown',status:'unknown'};db.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,'operation',unknown.id,payloadHash(unknown),JSON.stringify(unknown));db.close();
 managed=await superviseProduct(config,{openBrowser:false,engineScript,onReady:e=>status.push(e)});await until(()=>managed.state.status==='ready','joint ready');
 const duplicate=await superviseProduct(config,{openBrowser:false,engineScript});assert.equal(duplicate.existing,true);await duplicate.close();assert.equal((await fetch(config.endpoint+'/health')).ok,true);
 assert.equal(status.some(e=>JSON.stringify(e).includes('fixture-private-value')),false);await managed.close();
 const sock=createServer();await new Promise(yes=>sock.listen(ports[1],'127.0.0.1',yes));
 try{await assert.rejects(superviseProduct(config,{openBrowser:false,engineScript}),/正在使用/);assert.equal(sock.listening,true);}finally{await new Promise(yes=>sock.close(yes));}
 managed=await superviseProduct(config,{openBrowser:false,engineScript,onReady:e=>status.push(e)});await until(()=>managed.state.status==='ready','ready before failure');
 process.kill(managed.enginePid,'SIGKILL');await managed.done;assert.equal(managed.state.status,'engine_exited');await assert.rejects(fetch(config.endpoint+'/health'));
 rmSync(join(engineRoot,'fixture-started'));writeFileSync(join(engineRoot,'delay-ready'),'fixture');
 managed=await superviseProduct(config,{openBrowser:false,engineScript,onReady:e=>status.push(e)});await until(()=>existsSync(join(engineRoot,'fixture-started')),'owned engine started');await managed.close();
 assert.equal(managed.state.status,'starting_engine');
 managed=await superviseProduct(config,{openBrowser:false,engineScript,engineStartupMs:100,onReady:e=>status.push(e)});await managed.done;assert.equal(managed.state.status,'startup_failed');
 const check=new DatabaseSync(join(dataDir,'workspace.sqlite'),{readOnly:true});assert.equal(JSON.parse(check.prepare("SELECT body_json FROM records WHERE id='retained-unknown'").get().body_json).status,'unknown');assert.equal(check.prepare("SELECT count(*) n FROM records WHERE kind='attempt'").get().n,0);check.close();
 const savedConfig=readFileSync(join(dataDir,'product-start.json'));write(join(engineRoot,'engine-startup.json'),{...startup,infrastructureId:'foreign'});assert.throws(()=>productConfiguration(config,{engineScript}),/已变化/);write(join(engineRoot,'engine-startup.json'),startup);
 const backup=join(dir,'backup'),restored=join(dir,'restored');await snapshotWorkspace(dataDir,backup);restoreWorkspace(backup,restored,{port:await freePort()});
 assert.equal(existsSync(join(restored,'product-start.json')),false);assert.deepEqual(readFileSync(join(restored,'product-start.before-recovery.json')),savedConfig);
 assert.equal(JSON.parse(readFileSync(join(restored,'recovery.json'))).executorsEnabled,false);
 await assert.rejects(configureProduct(settings({dataDir:restored}),{engineRoot,python}),/恢复后的工作台保持停用/);
 await assert.rejects(configureProduct(config,{engineRoot,python}),/执行环境检查未通过/,'No real environment is accepted from a fake fixture');
 assert.equal(connection.endpoint,config.endpoint);
});

test('真实引擎监督函数在数据库启动中收到退出信号，正常清理自己创建的子进程',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-early-stop-')),script=join(dir,'early.py');let child;
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 writeFileSync(script,`import os,signal,subprocess,sys,time
from pathlib import Path
sys.path.insert(0,sys.argv[1]);import engine_runtime as runtime
root=Path(sys.argv[2])
runtime.configuration=lambda root:({'valkey':'not-started'},{},{'api_port':12345,'redis_port':12346})
runtime.available=lambda port:None
class Owned:
 def __init__(self,infra):self.children=[]
 def start_database(self):
  self.child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);self.children.append(self.child)
  (root/'owned-pid').write_text(str(self.child.pid));time.sleep(1)
 def close(self):
  (root/'cleanup-started').write_text('stopping');time.sleep(.3)
  self.child.terminate();self.child.wait(timeout=5);(root/'cleaned').write_text('stopped')
runtime.OwnedInfrastructure=Owned
runtime.supervise(root)
`);
 child=spawn(python,['-B',script,resolve('integrations/agenthub'),dir],{stdio:['ignore','ignore','pipe']});child.stderr.resume();
 const done=new Promise(yes=>child.once('exit',(code,signal)=>yes({code,signal})));
 try{await until(()=>existsSync(join(dir,'owned-pid')),'database child created');child.kill('SIGTERM');await until(()=>existsSync(join(dir,'cleanup-started')),'cleanup started');child.kill('SIGTERM');const result=await done;assert.equal(result.code,0);assert.equal(existsSync(join(dir,'cleaned')),true);const pid=Number(readFileSync(join(dir,'owned-pid'),'utf8'));assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');}
 finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await done;}}
});
