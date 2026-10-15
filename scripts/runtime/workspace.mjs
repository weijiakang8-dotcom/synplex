import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {refreshUiLauncher} from '../../services/workspace/ui-launch.mjs';
import {validateWire} from '../../packages/contracts/validate.mjs';
import {verifyRelease} from './release.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const privateRead=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)throw new Error('连接资料需要仅本人可读的普通文件。');return JSON.parse(readFileSync(file,'utf8'));};
export function settings({dataDir=process.env.SYNPLEX_WORKSPACE_DATA_DIR??join(root,'.runtime/workspace'),port=process.env.SYNPLEX_WORKSPACE_PORT,scope=process.env.SYNPLEX_WORKSPACE_SCOPE}={}){
 dataDir=resolve(dataDir);if(['snapshot.json','backup-incomplete.json','restore-incomplete.json'].some(name=>existsSync(join(dataDir,name))))throw new Error('这是备份或未完成的恢复目录，请先完成恢复核对。');const connection=existsSync(join(dataDir,'connection.json'))?privateRead(join(dataDir,'connection.json')):null;
 const chosen=validateWire('Scope',scope?typeof scope==='string'?JSON.parse(scope):scope:connection?.scope??{projectId:'local-project',versionId:null,branchId:null});
 const number=Number(port??(connection?new URL(connection.endpoint).port:5200));
 if(!Number.isSafeInteger(number)||number<1024||number>65535||connection&&connection.endpoint!==`http://127.0.0.1:${number}`)throw new Error('连接地址与已有资料不一致，请先核对，不会修改原连接。');
 if(existsSync(dataDir)&&lstatSync(dataDir).isSymbolicLink())throw new Error('资料文件夹不能是替身。');
 return {dataDir,port:number,scope:chosen,endpoint:`http://127.0.0.1:${number}`};
}
export async function diagnose(config){
 const checks=[];const check=async(name,fn)=>{try{await fn();checks.push({name,status:'ready'});}catch{checks.push({name,status:'blocked'});}};
 await check('运行环境',()=>{const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||major===22&&minor<16||typeof DatabaseSync!=='function')throw new Error();});
 await check('资料读取依赖',async()=>{for(const name of ['ajv','ajv-formats','fflate','mammoth','xlsx','pdf-parse'])await import(name);});
 await check('已有资料',()=>{const file=join(config.dataDir,'workspace.sqlite');if(existsSync(file)){const db=new DatabaseSync(file,{readOnly:true});try{const r=db.prepare('PRAGMA quick_check').get();if(Object.values(r)[0]!=='ok')throw new Error();}finally{db.close();}}});
 await check('连接设置',()=>{settings(config);});
 await check('发行文件',()=>{if(existsSync(join(root,'release-incomplete.json')))throw new Error();if(existsSync(join(root,'release.json')))verifyRelease(root);});
 const executors=existsSync(join(config.dataDir,'executors.json'))?privateRead(join(config.dataDir,'executors.json')):null;
 return {ready:checks.every(c=>c.status==='ready'),checks,execution:executors?'有执行设置，尚未核验工具连接':'尚未连接执行工具；可先保存资料和准备任务',modelCalls:0};
}
async function available(port){const s=createServer();try{await new Promise((yes,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',yes);});}finally{if(s.listening)await new Promise(yes=>s.close(yes));}}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const wait=ms=>new Promise(yes=>setTimeout(yes,ms));

// Only this supervisor's ChildProcess handles are signalled. A saved PID never
// authorizes stopping another process, even if an old lock has been left behind.
export async function supervise(config,{openBrowser=true,restartLimit=2,serverFile=join(root,'services/workspace/server.mjs'),onReady=()=>{}}={}){
 const diagnostic=await diagnose(config);if(!diagnostic.ready)throw new Error('启动检查未通过，请先运行“检查工作台”查看需要补齐的项目。');
 // Reuse a running instance only after its scoped human credential succeeds.
 try{const file=await refreshUiLauncher(config.dataDir);if(openBrowser)spawn('/usr/bin/open',[file],{stdio:'ignore'});return {existing:true,launchFile:file,close:async()=>{},done:Promise.resolve()};}catch{/* An unavailable or unrelated service is never stopped. */}
 await available(config.port).catch(()=>{throw new Error('这个连接地址正在使用。不会停止原服务，请选择空闲地址或打开已有工作台。');});
 mkdirSync(config.dataDir,{recursive:true,mode:0o700});
 const lock=join(config.dataDir,'supervisor.sqlite');
 if(existsSync(lock)&&(lstatSync(lock).isSymbolicLink()||!lstatSync(lock).isFile()||lstatSync(lock).uid!==process.getuid()))throw new Error('启动记录异常，请保留资料并由维护人员核对。');
 const lockDb=new DatabaseSync(lock);chmodSync(lock,0o600);lockDb.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS supervisor (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,pid INTEGER NOT NULL); BEGIN IMMEDIATE;');
 const identity=randomUUID();try{
  const owner=lockDb.prepare('SELECT * FROM supervisor WHERE id=1').get();
  if(owner&&(!Number.isSafeInteger(owner.pid)||owner.pid<=0||alive(owner.pid)))throw new Error('已有启动程序尚未退出，请先查看原窗口；不会重复启动。');
  lockDb.prepare('INSERT INTO supervisor VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid').run(identity,process.pid);lockDb.exec('COMMIT');
 }catch(e){lockDb.exec('ROLLBACK');lockDb.close();throw e;}
 let child,stopping=false,restarts=0,resolveDone,released=false;const done=new Promise(yes=>resolveDone=yes);
 const release=()=>{if(released)return;released=true;lockDb.prepare('DELETE FROM supervisor WHERE id=1 AND owner=?').run(identity);lockDb.close();resolveDone();};
 async function launch(){
  const env={...process.env,SYNPLEX_WORKSPACE_DATA_DIR:config.dataDir,SYNPLEX_WORKSPACE_PORT:String(config.port),SYNPLEX_WORKSPACE_SCOPE:JSON.stringify(config.scope),SYNPLEX_WORKSPACE_SERVE_UI:'1'};
  child=spawn(process.execPath,[serverFile],{cwd:root,env,stdio:['ignore','pipe','pipe']});const owned=child;
  let ended=false,ready=false,buffer='';const startup=setTimeout(()=>{if(!ready&&!ended){onReady({error:'启动未及时完成，正在正常退出；资料保留。',restarts});owned.kill('SIGTERM');}},15000);
  owned.stdout.setEncoding('utf8');owned.stdout.on('data',chunk=>{buffer=(buffer+chunk).slice(-32768);if(!ready&&buffer.includes('"launchFile"')){ready=true;clearTimeout(startup);(async()=>{try{const file=await refreshUiLauncher(config.dataDir);onReady({launchFile:file,restarts});if(openBrowser&&restarts===0)spawn('/usr/bin/open',[file],{stdio:'ignore'});}catch{onReady({error:'入口暂未生成，请检查工作台。',restarts});}})();}});
  // Do not relay arbitrary adapter errors or credential-bearing subprocess text.
  owned.stderr.resume();
  const finish=async()=>{if(ended)return;ended=true;clearTimeout(startup);if(stopping){release();return;}if(restarts>=restartLimit){onReady({error:'工作台多次退出，已停止自动重启；资料保留，请运行启动检查。',restarts});release();return;}restarts++;await wait(300);if(stopping){release();return;}try{await available(config.port);await launch();}catch{onReady({error:'原连接地址已被占用，停止重启，未干预其他程序。',restarts});release();}};
  owned.once('error',finish);owned.once('exit',finish);
 }
 const close=async()=>{if(stopping)return done;stopping=true;if(child?.exitCode===null&&!child.killed)child.kill('SIGTERM');else release();return done;};
 try{await launch();}catch(error){release();throw error;}
 return {existing:false,done,close,get pid(){return child?.pid;}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const config=settings();if(process.argv.includes('--check')){const d=await diagnose(config);for(const c of d.checks)console.log(`${c.name}：${c.status==='ready'?'就绪':'需要处理'}`);console.log(d.execution);process.exitCode=d.ready?0:1;}
 else{const managed=await supervise(config,{openBrowser:!process.argv.includes('--no-open'),onReady:r=>console.log(r.error||'工作台已就绪。关闭此窗口会正常退出；已有任务不会重新执行。')});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>managed.close());await managed.done;}}
 catch(error){console.error(error.message);process.exitCode=1;}
}
