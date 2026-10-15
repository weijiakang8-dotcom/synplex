import {existsSync,lstatSync,realpathSync,mkdirSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {verifyRelease} from './release.mjs';
import {snapshotWorkspace,inspectDatabase,verifyWorkspaceSource,restoreWorkspace} from './recovery.mjs';
import {canonicalTarget} from './paths.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {assertDataFeatures} from './data-compatibility.mjs';

const invalid=message=>{throw new Error(message);};
const shellQuote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
function launcherFile(file,text,replace){
 if(!replace){writeFileSync(file,text,{mode:0o700,flag:'wx'});return;}
 const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.nlink!==1)invalid('启动文件身份异常，保留维护锁，请核对后再继续。');
 const temp=file+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o700);
 try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);
}
function writeLaunchers(root,bootstrap,replace=false){
 const command=action=>`node ${shellQuote(bootstrap)} ${action} "$PWD"`;
 const tail='\nsynplexStatus=$?\nif [[ $synplexStatus -ne 0 ]]; then read "synplexReply?请根据上方提示处理，按回车关闭。"; fi\nexit "$synplexStatus"\n';
 const head='#!/bin/zsh\ncd -- "${0:A:h}" || exit 1\n';
 launcherFile(join(root,'打开Synplex.command'),head+command('open')+tail,replace);
 launcherFile(join(root,'回退上一版.command'),head+command('rollback')+tail,replace);
 const choose='synplexCandidate=$(/usr/bin/osascript -e \'POSIX path of (choose folder with prompt "选择已核对的新版本文件夹")\') || exit 0\n';
 launcherFile(join(root,'升级工作台.command'),head+choose+command('upgrade')+' "$synplexCandidate"'+tail,replace);
}
function privateDirectory(path){
 const s=lstatSync(path);if(s.isSymbolicLink()||!s.isDirectory()||s.uid!==process.getuid()||s.mode&0o077)invalid('安装管理文件夹必须仅本人可读，且不能是替身。');return realpathSync(path);
}
function readPrivate(path){const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)invalid('安装记录不安全，请保留现有版本并核对。');return JSON.parse(readFileSync(path,'utf8'));}
function atomicJSON(file,value){
 const temp=file+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);
 try{writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temp,file);
 const directory=openSync(resolve(file,'..'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
function takeLock(root,kind){
 const path=join(root,'.upgrade-lock');mkdirSync(path,{mode:0o700});
 const owner={token:randomUUID(),pid:process.pid,kind,status:'active'};atomicJSON(join(path,'owner.json'),owner);return owner;
}
function releaseLock(root,owner){
 const path=join(root,'.upgrade-lock'),file=join(path,'owner.json');
 if(readPrivate(file).token!==owner.token)invalid('维护锁的身份发生变化，未解除保护。');
 unlinkSync(file);rmdirSync(path);
}
function ownerAlive(owner){try{process.kill(owner.pid,0);return true;}catch(error){return error.code!=='ESRCH';}}
function releaseIdentity(path){
 path=realpathSync(path);const manifest=verifyRelease(path);
 if(payloadHash(manifest.dataCompatibility??null)!==payloadHash({workspaceSchemaVersions:[1],engineUpgrade:'not_included'}))invalid('这份版本没有适用的数据兼容声明，不能升级或回退。');
 return {path,contentHash:manifest.contentHash,commit:manifest.commit,schemaVersions:manifest.dataCompatibility.workspaceSchemaVersions};
}
function checkIdentity(identity,dataDir){
 const actual=releaseIdentity(identity.path);if(payloadHash(actual)!==payloadHash(identity))invalid('版本文件或兼容声明已改变，未启动。');
 const data=inspectDatabase(join(dataDir,'workspace.sqlite'));
 if(data.versions.some(v=>!identity.schemaVersions.includes(v)))invalid('当前资料与这个版本不兼容，不能强行切换程序或倒退数据库。');
 assertDataFeatures(identity.path,join(dataDir,'workspace.sqlite'));
 if(existsSync(join(dataDir,'product-start.json'))&&!existsSync(join(identity.path,'scripts/runtime/open.mjs')))invalid('这份版本不能联合启动当前执行环境，未切换。请保留现有版本或先由维护人员核对启动方式。');
 return data;
}
function stateOf(root,{pending=false,verifyCurrent=true}={}){
 root=privateDirectory(root);
 if(!pending&&['upgrade-intent.json','.upgrade-lock','.reconcile-lock'].some(name=>existsSync(join(root,name))))invalid('正在启动或切换版本，或上次切换尚未核对。请先查看原窗口或运行版本核对，不重复操作。');
 const state=readPrivate(join(root,'installation.json'));
 if(state.format!=='synplex.workspace-installation/1'||typeof state.dataDir!=='string'||!state.current)invalid('安装记录不完整，原资料保留。');
 privateDirectory(state.dataDir);if(verifyCurrent)checkIdentity(state.current,state.dataDir);return {root,state};
}
function probe(identity,dataDir,reportFile){
 // Only an operator-reviewed local release is eligible. This is a doctor
 // command, not a sandbox for untrusted code and not a model capability test.
 const env={PATH:process.env.PATH,LANG:process.env.LANG??'en_US.UTF-8',TMPDIR:process.env.TMPDIR??'/tmp',SYNPLEX_WORKSPACE_DATA_DIR:dataDir,SYNPLEX_TEST_NO_MODELS:'1'};
 const r=spawnSync(process.execPath,[join(identity.path,'scripts/runtime/workspace.mjs'),'--check'],{cwd:identity.path,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 atomicJSON(reportFile,{releaseHash:identity.contentHash,checkedAt:new Date().toISOString(),exitCode:r.status,signal:r.signal,errorCode:r.error?.code??null,stagedDataOnly:true,externalEngineStarted:false});
 if(r.error||r.status!==0)invalid('新版本启动检查未通过，保留原版本。检查结果保留在本机维护记录，不启动执行引擎。');
}

export async function initializeInstallation(root,release,dataDir){
 root=canonicalTarget(root);release=realpathSync(release);dataDir=resolve(dataDir);const canonicalData=privateDirectory(dataDir);
 // Preserve the input spelling for snapshot connection-path mapping (/var on
 // macOS may canonically be /private/var); containment uses the real directory.
 if(existsSync(root)||[release,canonicalData].some(p=>root===p||root.startsWith(p+sep)||p.startsWith(root+sep)))invalid('请选择资料和程序之外全新的安装管理文件夹。');
 const current=releaseIdentity(release);checkIdentity(current,dataDir);
 mkdirSync(root,{recursive:true,mode:0o700});
 // An interrupted initial snapshot leaves no usable installation pointer.
 const backup=join(root,'initial-backup');const manifest=await snapshotWorkspace(dataDir,backup);
 const staged=restoreWorkspace(backup,join(root,'initial-probe'),{port:15997});probe(current,staged.dataDir,join(root,'initial-doctor.json'));
 if(payloadHash(inspectDatabase(join(staged.dataDir,'workspace.sqlite')))!==payloadHash(staged.data))invalid('启动检查改变了副本资料，未完成安装。');
 verifyWorkspaceSource(dataDir,manifest);
 const state={format:'synplex.workspace-installation/1',dataDir,current,previous:null,generation:1,createdAt:new Date().toISOString(),engineUpgradeIncluded:false};
 // Keep using the manager which actually performed these compatibility
 // checks. A rollback must not switch maintenance to unaware older code.
 writeLaunchers(root,fileURLToPath(import.meta.url));
 atomicJSON(join(root,'installation.json'),state);return state;
}

async function switchVersion(root,target,{rollback=false,fault=()=>{}}={}){
 let {state}=stateOf(root,{verifyCurrent:!rollback});root=realpathSync(root);
 const next=rollback?state.previous:releaseIdentity(target);
 if(!next)invalid('没有可回退的上一版。');
 if(next.contentHash===state.current.contentHash)invalid('已经使用这份版本，不重复切换。');
 checkIdentity(next,state.dataDir);
 const owner=takeLock(root,rollback?'rollback':'upgrade');
 const intentFile=join(root,'upgrade-intent.json'),id=randomUUID(),backup=join(root,'backup-'+id),history=join(root,'change-'+id+'.json');
 const before=state,after={...state,current:next,previous:state.current,generation:state.generation+1};
 let intent={id,kind:rollback?'rollback':'upgrade',before,after,backup,status:'preparing',createdAt:new Date().toISOString()};
 try{
  atomicJSON(intentFile,intent);const manifest=await snapshotWorkspace(state.dataDir,backup);
  const staged=restoreWorkspace(backup,join(root,'probe-'+id),{port:15997});probe(next,staged.dataDir,join(root,'doctor-'+id+'.json'));
  if(payloadHash(inspectDatabase(join(staged.dataDir,'workspace.sqlite')))!==payloadHash(staged.data))invalid('启动检查改变了副本资料，未切换版本。');
  checkIdentity(next,state.dataDir);verifyWorkspaceSource(state.dataDir,manifest);
  if(payloadHash(readPrivate(join(root,'installation.json')))!==payloadHash(before))invalid('安装记录已变化，未切换版本。');
  intent={...intent,status:'prepared',dataHash:manifest.data.contentHash};atomicJSON(intentFile,intent);fault('prepared');
  atomicJSON(join(root,'installation.json'),after);fault('switched');
  writeLaunchers(root,fileURLToPath(import.meta.url),true);
  atomicJSON(history,{...intent,status:'completed',completedAt:new Date().toISOString(),databaseRestored:false});unlinkSync(intentFile);releaseLock(root,owner);
  return {state:after,backup,databaseRestored:false};
 }catch(error){
  // Keep the exact intent and lock. A crash after rename must be reconciled,
  // not guessed from a thrown response or repeated against newer data.
  const file=join(root,'.upgrade-lock','owner.json');
  try{if(readPrivate(file).token===owner.token)atomicJSON(file,{...owner,status:'interrupted'});}catch{/* Preserve the original failure and any incomplete lock for inspection. */}
  throw error;
 }
}
export const upgradeInstallation=(root,target,options)=>switchVersion(root,target,options);
export const rollbackInstallation=(root,options)=>switchVersion(root,null,{...options,rollback:true});

export function reconcileUpgrade(root){
 const loaded=stateOf(root,{pending:true,verifyCurrent:false});root=loaded.root;const file=join(root,'upgrade-intent.json');
 const guard=join(root,'.reconcile-lock');mkdirSync(guard,{mode:0o700});
 try{
 const owner=readPrivate(join(root,'.upgrade-lock','owner.json'));
 if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.token!=='string')invalid('原维护锁的身份不完整，未解除保护。');
 if(owner.status==='active'&&ownerAlive(owner))invalid('原切换程序仍在运行，暂不核对或解除它的维护锁。');
 if(!existsSync(file))invalid('没有可核对的切换记录；若只剩锁定文件，请保留现场由维护人员检查，不自动删除。');
 const intent=readPrivate(file),state=readPrivate(join(root,'installation.json')),hash=payloadHash(state),before=hash===payloadHash(intent.before),after=hash===payloadHash(intent.after);
 if(!before&&!after)invalid('当前版本不属于这次切换的前后状态，未解除保护。');
 let reverted=false;
 try{checkIdentity(state.current,state.dataDir);}catch(error){
  if(!after)throw error;
  checkIdentity(intent.before.current,state.dataDir);
  atomicJSON(join(root,'installation.json'),{...intent.before,generation:state.generation+1});reverted=true;
 }
 const result={...intent,status:reverted?'previous_code_restored':after?'completed_after_interruption':'not_switched',reconciledAt:new Date().toISOString(),databaseRestored:false};
 writeLaunchers(root,fileURLToPath(import.meta.url),true);
 atomicJSON(join(root,'change-'+intent.id+'.json'),result);unlinkSync(file);releaseLock(root,owner);return result;
 }finally{rmdirSync(guard);}
}

export async function openInstallation(root,{openBrowser=true,onReady=()=>{}}={}){
 const {state}=stateOf(root),owner=takeLock(root,'opening');
 try{
  const current=stateOf(root,{pending:true}).state;
  if(payloadHash(current)!==payloadHash(state)||existsSync(join(root,'upgrade-intent.json')))invalid('版本记录已变化，尚未打开。请先核对原切换。');
  const runtime=await import(pathToFileURL(join(state.current.path,'scripts/runtime/workspace.mjs')).href);
  const entry=join(state.current.path,'scripts/runtime/open.mjs'),config=runtime.settings({dataDir:state.dataDir});
  if(existsSync(entry)){const launcher=await import(pathToFileURL(entry).href);return await launcher.openConfigured(config,{openBrowser,onReady});}
  return await runtime.supervise(config,{openBrowser,onReady});
 }finally{releaseLock(root,owner);}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [action,root,target,dataDir]=process.argv.slice(2);let result;
  if(action==='init')result=await initializeInstallation(root,target,dataDir);
  else if(action==='upgrade')result=await upgradeInstallation(root,target);
  else if(action==='rollback')result=await rollbackInstallation(root);
  else if(action==='reconcile')result=reconcileUpgrade(root);
  else if(action==='open'){const managed=await openInstallation(root,{onReady:r=>console.log(r.error||'工作台已就绪。')});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>managed.close());await managed.done;}
  else invalid('请选择 init、upgrade、rollback、reconcile 或 open。');
  if(result)console.log('版本记录已核对。没有恢复旧数据库、启动执行引擎或重新发送任务。');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
