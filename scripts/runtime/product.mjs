import {existsSync,lstatSync,readFileSync,writeFileSync,chmodSync,realpathSync,renameSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {homedir,tmpdir} from 'node:os';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {refreshUiLauncher} from '../../services/workspace/ui-launch.mjs';
import {settings,diagnose,supervise} from './workspace.mjs';
import {canonicalTarget} from './paths.mjs';
import {acquireWorkspaceLease} from './workspace-lease.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const invalid=message=>{throw Error(message);};
function privateJSON(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)invalid('启动设置需要仅本人可读的普通文件。');return JSON.parse(readFileSync(path,'utf8'));}
const childEnv=()=>({PATH:process.env.PATH,HOME:homedir(),TMPDIR:tmpdir(),LANG:process.env.LANG??'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1'});
const runtimeScript=join(root,'integrations/agenthub/engine_runtime.py');
export function engineIdentity(engineRoot){
 const s=lstatSync(engineRoot);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)invalid('执行环境需要使用本人独立的资料文件夹。');
 const startup=privateJSON(join(engineRoot,'engine-startup.json')),data=privateJSON(join(engineRoot,'engine/bootstrap.json'));
 if(startup.format!=='synplex.engine-startup/1'||typeof data.id!=='string'||typeof startup.infrastructureId!=='string'||startup.apiPort!==data.api_port||startup.redisPort!==data.redis_port)invalid('执行环境的身份不一致，请保留原资料核对。');
 return {engineId:data.id,infrastructureId:startup.infrastructureId,lockSha256:startup.lockSha256,backend:startup.backend,providerConfigured:startup.providerConfigured,
  apiPort:startup.apiPort,redisPort:startup.redisPort,databasePort:startup.databasePort,workflowId:data.workflow_id};
}
function checkEngine(python,engineRoot,script=runtimeScript){
 if(existsSync(join(engineRoot,'recovery.json'))&&privateJSON(join(engineRoot,'recovery.json')).executorsEnabled!==true)invalid('恢复后的执行环境保持停用，请先核对原任务和队列。');
 const s=lstatSync(python);if(!s.isFile()&&!s.isSymbolicLink())invalid('没有找到明确的独立Python运行环境。');
 const r=spawnSync(python,['-B',script,'check','--root',engineRoot],{env:childEnv(),encoding:'utf8',timeout:30000,maxBuffer:65536});
 // Raw subprocess output may contain private paths or connection details.
 if(r.error||r.status!==0)invalid('执行环境检查未通过，请保留原资料并查看独立环境的检查结果。');
}
function checkWorkspaceBinding(config,engineRoot,identity,{requireToken=false}={}){
 const file=join(config.dataDir,'executors.json');if(!existsSync(file))return;
 const adapter=privateJSON(file).synplex;if(!adapter)return;
 const expected=join(engineRoot,'engine/access-token');
 if(adapter.endpoint!==`http://127.0.0.1:${identity.apiPort}`||adapter.workflowId!==identity.workflowId||typeof adapter.tokenFile!=='string'||canonicalTarget(adapter.tokenFile)!==canonicalTarget(expected))invalid('工作台连接的不是这份独立执行环境，未启动任何服务。');
 if(!existsSync(expected)&&!requireToken)return; // First API startup creates its private token before readiness.
 const s=lstatSync(expected);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)invalid('执行环境的连接资料不安全，未启动。');
}
export function productLauncherScripts(){
 const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
 // Resolve the data directory from the command's own location. A copied
 // backup must never open the original live data directory behind the user.
 const head='#!/bin/zsh\nexport SYNPLEX_WORKSPACE_DATA_DIR="${0:A:h}"\n'+quote(process.execPath)+' '+quote(join(root,'scripts/runtime/open.mjs'));
 const legacy=head+'\nif [[ $? -ne 0 ]]; then read "synplexReply?请根据上方提示处理，按回车关闭。"; fi\n';
 const script=head+'\nsynplexStatus=$?\nif [[ $synplexStatus -ne 0 ]]; then read "synplexReply?请根据上方提示处理，按回车关闭。"; fi\nexit "$synplexStatus"\n';
 return {legacy,script};
}
export function writeProductLauncher(dataDir){
 const file=join(dataDir,'打开Synplex.command'),{legacy,script}=productLauncherScripts();
 if(existsSync(file)){
  const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077||s.nlink!==1)invalid('已有不同的启动入口，未覆盖；请先核对原入口。');
  const current=readFileSync(file,'utf8');if(current===script)return;
  if(current!==legacy)invalid('已有不同的启动入口，未覆盖；请先核对原入口。');
  const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,script,{flag:'wx',mode:0o700});renameSync(temp,file);return;
 }
 writeFileSync(file,script,{flag:'wx',mode:0o700});
}
export async function configureProduct(config,{engineRoot,python}){
 config=settings(config);const lease=acquireWorkspaceLease(config.dataDir);
 try{return await configureProductLocked(config,{engineRoot,python});}finally{lease.close();}
}
async function configureProductLocked(config,{engineRoot,python}){
 if(typeof engineRoot!=='string'||typeof python!=='string')invalid('请明确填写独立执行环境和Python的位置。');
 config=settings(config);engineRoot=resolve(engineRoot);python=resolve(python);
 if(existsSync(join(config.dataDir,'recovery.json'))&&privateJSON(join(config.dataDir,'recovery.json')).executorsEnabled!==true)invalid('恢复后的工作台保持停用，请先核对原任务和连接身份。');
 if(!existsSync(join(config.dataDir,'connection.json')))invalid('先准备好这份工作台的本机连接，再建立联合启动入口。');
 if(!(await diagnose(config)).ready)invalid('工作台检查未通过，未更改启动设置。');
 const identity=engineIdentity(engineRoot);checkEngine(python,engineRoot);checkWorkspaceBinding(config,engineRoot,identity);
 const ports=[config.port,identity.apiPort,identity.redisPort,identity.databasePort];
 if(ports.some(p=>!Number.isSafeInteger(p)||p<1024||p>65535)||new Set(ports).size!==4)invalid('工作台与执行环境需要四个不同的本机连接地址。');
 const value={format:'synplex.product-start/1',workspaceDataDir:realpathSync(config.dataDir),engineRoot:realpathSync(engineRoot),python,identity};
 const file=join(config.dataDir,'product-start.json');
 if(existsSync(file)){if(payloadHash(privateJSON(file))!==payloadHash(value))invalid('已有另一份联合启动设置，请先核对，不能直接覆盖。');writeProductLauncher(config.dataDir);return value;}
 writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx',mode:0o600});writeProductLauncher(config.dataDir);return value;
}
export function productConfiguration(config,{engineScript=runtimeScript}={}){
 const value=privateJSON(join(config.dataDir,'product-start.json'));
 if(Object.keys(value).sort().join(',')!=='engineRoot,format,identity,python,workspaceDataDir'||value.format!=='synplex.product-start/1'||value.workspaceDataDir!==realpathSync(config.dataDir)||![value.python,value.engineRoot].every(p=>typeof p==='string'&&resolve(p)===p))invalid('联合启动设置不属于当前资料，请先核对原入口。');
 if(existsSync(join(config.dataDir,'recovery.json'))&&privateJSON(join(config.dataDir,'recovery.json')).executorsEnabled!==true)invalid('恢复后的执行环境保持停用，请先核对原任务和连接身份。');
 if(payloadHash(engineIdentity(value.engineRoot))!==payloadHash(value.identity))invalid('执行环境或模型连接已变化，请先由维护人员核对，未自动改用其他环境。');
 checkEngine(value.python,value.engineRoot,engineScript);checkWorkspaceBinding(config,value.engineRoot,value.identity);return value;
}
async function available(port){const socket=createServer();try{await new Promise((yes,no)=>{socket.once('error',no);socket.listen(port,'127.0.0.1',yes);});}finally{if(socket.listening)await new Promise(yes=>socket.close(yes));}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
function productLock(config,value){
 const path=join(config.dataDir,'supervisor.sqlite');
 if(existsSync(path)){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid())invalid('启动记录异常，未启动服务。');}
 const db=new DatabaseSync(path);chmodSync(path,0o600);db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS product_supervisor(id INTEGER PRIMARY KEY CHECK(id=1),token TEXT NOT NULL,pid INTEGER NOT NULL,config_hash TEXT NOT NULL); BEGIN IMMEDIATE;');
 try{
  const previous=db.prepare('SELECT * FROM product_supervisor WHERE id=1').get(),hash=payloadHash(value);
  if(previous&&(!Number.isSafeInteger(previous.pid)||previous.pid<=0||alive(previous.pid))){db.exec('ROLLBACK');db.close();if(previous.config_hash!==hash)invalid('另一个启动窗口正在使用不同设置，请先核对原窗口。');return null;}
  const token=randomUUID();db.prepare('INSERT INTO product_supervisor VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,config_hash=excluded.config_hash').run(token,process.pid,hash);db.exec('COMMIT');
  return ()=>{db.prepare('DELETE FROM product_supervisor WHERE id=1 AND token=?').run(token);db.close();};
 }catch(error){if(db.isOpen){db.exec('ROLLBACK');db.close();}throw error;}
}
function startEngine(value,script,timeoutMs){
 const child=spawn(value.python,['-B',script,'run','--root',value.engineRoot],{env:childEnv(),stdio:['ignore','pipe','pipe']});
 let ready=false,buffer='',rejectReady,resolveReady,settled=false;
 const readiness=new Promise((yes,no)=>{resolveReady=yes;rejectReady=no;});
 const timer=setTimeout(()=>rejectReady(Error('执行环境启动超时，请保留资料核对；没有重新发送任务。')),timeoutMs);
 const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);if(!ready)rejectReady(Error('执行环境未能启动，请查看本机检查结果；没有重新发送任务。'));};
 child.stderr.resume();child.stdout.setEncoding('utf8');
 child.stdout.on('data',chunk=>{buffer=(buffer+chunk).slice(-65536);const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){let event;try{event=JSON.parse(line);}catch{continue;}if(event.format==='synplex.engine-ready/1'&&event.endpoint===`http://127.0.0.1:${value.identity.apiPort}`&&event.providerConfigured===value.identity.providerConfigured){ready=true;clearTimeout(timer);resolveReady();}}});
 const done=new Promise(yes=>{child.once('error',()=>{finish();yes();});child.once('exit',()=>{finish();yes();});});
 return {child,readiness,done};
}
async function stopOwned(engine){
 if(!engine)return;
 if(engine.child.exitCode===null&&engine.child.signalCode===null&&!engine.child.killed)engine.child.kill('SIGTERM');
 // Do not kill a saved PID, force-stop a database or assume that SIGTERM means exit.
 await engine.done;
}
export async function superviseProduct(config,{openBrowser=true,onReady=()=>{},engineScript=runtimeScript,engineStartupMs=35000}={}){
 const value=productConfiguration(config,{engineScript});
 if(!(await diagnose(config)).ready)invalid('工作台检查未通过，请先查看需要处理的项目。');
 const release=productLock(config,value);
 if(!release){let file;try{file=await refreshUiLauncher(config.dataDir);}catch{invalid('已有启动窗口正在准备服务，请查看原窗口，不要重复启动。');}if(openBrowser)spawn('/usr/bin/open',[file],{stdio:'ignore'});return {existing:true,done:Promise.resolve(),close:async()=>{}};}
 try{for(const port of [config.port,value.identity.apiPort,value.identity.redisPort,value.identity.databasePort])await available(port);}catch{release();invalid('需要的连接地址正在使用。请查看原窗口，不会关闭或接管其他服务。');}
 let engine,workspace,stopping=false,resolveDone;
 const done=new Promise(yes=>resolveDone=yes),state={status:'starting_engine'};
 const report=(status,message)=>{state.status=status;onReady({stage:status,...(message?{error:message}:{})});};
 const close=async()=>{stopping=true;await workspace?.close();await stopOwned(engine);return done;};
 const launch=async()=>{
  try{
   engine=startEngine(value,engineScript,engineStartupMs);await engine.readiness;if(stopping)return;
   checkWorkspaceBinding(config,value.engineRoot,value.identity,{requireToken:true});
   workspace=await supervise(config,{openBrowser,onReady:event=>{if(event.error)report('workspace_error',event.error);else{state.status='ready';onReady({...event,stage:'ready'});}}});
   if(workspace.existing)invalid('工作台已由另一个窗口打开，请使用原入口；本次执行环境会正常退出。');
   if(stopping)return;
   const first=await Promise.race([engine.done.then(()=> 'engine'),workspace.done.then(()=> 'workspace')]);
   if(!stopping)report(first+'_exited',first==='engine'?'执行环境已退出，工作台会正常关闭。原任务保留，请先核对，不会自动重做。':'工作台已退出，独立执行环境会正常关闭；原任务不会自动重做。');
  }catch{if(!stopping)report('startup_failed','联合启动未完成，请检查原资料、连接地址和独立环境；没有重新发送任务。');}
  finally{await workspace?.close();await stopOwned(engine);release();resolveDone();}
 };
 void launch();return {existing:false,done,close,state,get enginePid(){return engine?.child.pid;},get workspacePid(){return workspace?.pid;}};
}
