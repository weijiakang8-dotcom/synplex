import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,chmodSync,copyFileSync,renameSync,realpathSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,relative,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync,backup} from 'node:sqlite';
import {payloadHash,sha256,validateWire} from '../../packages/contracts/validate.mjs';
import {canonicalTarget} from './paths.mjs';
import {acquireWorkspaceLease,requireWorkspaceLease,WORKSPACE_LEASE_FILES} from './workspace-lease.mjs';
import {createInterface} from 'node:readline';

const excluded=new Set(['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm','supervisor.sqlite','supervisor.sqlite-wal','supervisor.sqlite-shm','打开Synplex.html','snapshot.json',...WORKSPACE_LEASE_FILES]);
const inside=(root,path)=>path.startsWith(root+sep);
const privateJSON=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)throw new Error('备份与连接资料必须仅本人可读。');return JSON.parse(readFileSync(file,'utf8'));};
export function listFiles(root,{exclude=false}={}){
 const files=[];const walk=(dir)=>{for(const name of readdirSync(dir).sort()){if(dir===root&&exclude&&excluded.has(name))continue;const file=join(dir,name),s=lstatSync(file);if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw new Error('资料中有替身或特殊文件，尚未备份；请保留原件并核对。');if(s.isDirectory())walk(file);else files.push({path:relative(root,file),sha256:sha256(readFileSync(file)),byteLength:s.size,executable:!!(s.mode&0o111)});}};walk(root);return files;
}
function foreignHolders(output,root,lease){
 const allowed=new Set(lease?WORKSPACE_LEASE_FILES.filter(name=>existsSync(join(root,name))).map(name=>{
  const stat=lstatSync(join(root,name),{bigint:true});return stat.dev.toString()+':'+stat.ino.toString();
 }):[]);
 let pid=null,file=null,occupied=false;
 const finish=()=>{if(file&&!(lease&&pid===process.pid&&allowed.has(file.device+':'+file.inode)))occupied=true;};
 for(const line of output.trim().split('\n').filter(Boolean)){
  if(/^p\d+$/.test(line)){finish();file=null;pid=Number(line.slice(1));}
  else if(/^f\S+$/.test(line)){finish();file={};}
  else if(/^D0x[0-9a-f]+$/i.test(line)&&file)file.device=BigInt(line.slice(1)).toString();
  else if(/^i\d+$/.test(line)&&file)file.inode=BigInt(line.slice(1)).toString();
  else throw Error('无法识别资料占用情况，未执行备份或恢复。');
 }
 finish();return occupied||!!output.trim()&&!file;
}
function unused(root,lease){
 if(lease)requireWorkspaceLease(lease,root);
 const deadline=Date.now()+2000;
 for(;;){
  // Compare actual device/inode identities. Under LC_ALL=C lsof escapes Chinese
  // names; textual path matching would mistake our own lock for a foreign file.
  const r=spawnSync('/usr/sbin/lsof',['-FpfiD','+D',root],{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});
  if(r.error||![0,1].includes(r.status)||r.stderr.trim())throw new Error('无法核对资料是否仍在使用，未执行备份或恢复。');
  if(!foreignHolders(r.stdout,root,lease))return;
  if(Date.now()>=deadline)throw new Error('资料仍在使用，请先正常关闭这份工作台；不会停止其他程序。');
  // Offline CLI only: briefly observe transient FileProvider readers, never
  // retry the backup/restore itself or send a signal to a reported process.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
 }
}
export function inspectDatabase(file){
 const db=new DatabaseSync(file,{readOnly:true});try{
  if(Object.values(db.prepare('PRAGMA integrity_check').get())[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('数据库校验失败。');
  const versions=db.prepare('SELECT version FROM schema_versions ORDER BY version').all().map(r=>r.version);if(versions.some(v=>v!==1)||!versions.length)throw new Error('资料版本与当前程序不兼容，不能强行恢复。');
  for(const r of db.prepare('SELECT payload_hash,body_json FROM records').iterate())if(payloadHash(JSON.parse(r.body_json))!==r.payload_hash)throw new Error('记录内容与指纹不符，不能当作有效备份。');
  for(const r of db.prepare('SELECT sha256,bytes FROM raw_blobs').iterate())if(sha256(r.bytes)!==r.sha256)throw new Error('原件或成果的指纹不符，不能当作有效备份。');
  const missing=db.prepare(`SELECT 1 FROM records r JOIN scopes s ON s.partition=r.partition LEFT JOIN raw_blobs b ON b.owner_id=s.owner_id AND b.sha256=json_extract(r.body_json,'$.sha256')
    WHERE r.kind IN ('source','artifact_file') AND (b.sha256 IS NULL OR length(b.bytes)!=json_extract(r.body_json,'$.byteLength')) LIMIT 1`).get();if(missing)throw new Error('备份缺少原件或成果，不能继续恢复。');
  const tables=['schema_versions','scopes','credentials','records','receipts','authorizations','outbox','quarantined_conflicts'];
  const digest=createHash('sha256');for(const name of tables){digest.update(name);for(const row of db.prepare('SELECT * FROM '+name+' ORDER BY rowid').iterate())digest.update(payloadHash({...row}));}
  digest.update('raw_blobs');for(const row of db.prepare('SELECT owner_id,sha256,length(bytes) byteLength FROM raw_blobs ORDER BY rowid').iterate())digest.update(payloadHash({...row}));const contentHash=digest.digest('hex');
  return {versions,contentHash,counts:db.prepare('SELECT kind,count(*) total FROM records GROUP BY kind ORDER BY kind').all().map(r=>({...r})),unresolved:db.prepare("SELECT count(*) n FROM records WHERE kind='operation' AND json_extract(body_json,'$.status') IN ('queued','running','unknown')").get().n};
 }finally{db.close();}
}
function copyFiles(source,target,files){for(const f of files){const to=join(target,f.path);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(join(source,f.path),to);chmodSync(to,f.executable?0o700:0o600);}}
function fresh(source,target){source=realpathSync(resolve(source));target=canonicalTarget(target);if(source===target||inside(source,target)||inside(target,source)||existsSync(target))throw new Error('请选择原目录之外一个全新的目标文件夹，不覆盖已有内容。');return {source,target};}
export async function snapshotWorkspace(source,target,{lease=null}={}){
 if(lease)return snapshotWorkspaceLocked(source,target,requireWorkspaceLease(lease,source));
 const owned=acquireWorkspaceLease(source);
 try{return await snapshotWorkspaceLocked(source,target,owned);}finally{owned.close();}
}
async function snapshotWorkspaceLocked(source,target,lease){
 const pathRoot=resolve(source);
 ({source,target}=fresh(source,target));privateJSON(join(source,'connection.json'));unused(source,lease);
 if(['snapshot.json','backup-incomplete.json','restore-incomplete.json'].some(name=>existsSync(join(source,name))))throw new Error('请选择已完成核对的工作台目录。');
 const before=listFiles(source,{exclude:true}),database=inspectDatabase(join(source,'workspace.sqlite'));
 mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);
 writeFileSync(join(target,'backup-incomplete.json'),'{}',{flag:'wx',mode:0o600});
 copyFiles(source,target,before);const db=new DatabaseSync(join(source,'workspace.sqlite'),{readOnly:true});try{await backup(db,join(target,'workspace.sqlite'));chmodSync(join(target,'workspace.sqlite'),0o600);}finally{db.close();}
 const targetDb=new DatabaseSync(join(target,'workspace.sqlite'));try{targetDb.exec('PRAGMA journal_mode=DELETE');}finally{targetDb.close();}
 unused(source,lease);if(payloadHash(before)!==payloadHash(listFiles(source,{exclude:true}))||payloadHash(database)!==payloadHash(inspectDatabase(join(source,'workspace.sqlite'))))throw new Error('备份期间原资料发生变化，目标仅为未完成候选，不可恢复。');
 const files=listFiles(target).filter(f=>f.path!=='backup-incomplete.json'),copied=inspectDatabase(join(target,'workspace.sqlite'));if(payloadHash(database)!==payloadHash(copied))throw new Error('备份核对不一致，保留原资料。');
 const manifest={format:'synplex.private-workspace-snapshot/1',createdAt:new Date().toISOString(),source,pathRoot,data:database,files,sourceFiles:before,engineIncluded:false,
  limitation:'此备份保全工作台、原件、成果、执行回执和本目录配置；不包含外部Python数据库或队列。恢复默认不启用执行工具。'};
 writeFileSync(join(target,'snapshot.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});unlinkSync(join(target,'backup-incomplete.json'));return manifest;
}
export function verifySnapshot(source){
 source=realpathSync(resolve(source));const m=privateJSON(join(source,'snapshot.json'));if(m.format!=='synplex.private-workspace-snapshot/1'||!Array.isArray(m.files))throw new Error('不是已核对的工作台备份。');
 const files=listFiles(source).filter(f=>f.path!=='snapshot.json');if(payloadHash(files)!==payloadHash(m.files))throw new Error('备份文件有缺失或变化，未恢复。');
 if(payloadHash(inspectDatabase(join(source,'workspace.sqlite')))!==payloadHash(m.data))throw new Error('备份数据核对不一致。');return m;
}
export function compareWorkspaceSource(source,manifest,{lease=null}={}){
 if(lease)return compareWorkspaceSourceLocked(source,manifest,requireWorkspaceLease(lease,source));
 const owned=acquireWorkspaceLease(source);
 try{return compareWorkspaceSourceLocked(source,manifest,owned);}finally{owned.close();}
}
function compareWorkspaceSourceLocked(source,manifest,lease){
 source=realpathSync(resolve(source));if(source!==manifest.source||!Array.isArray(manifest.sourceFiles))throw new Error('缺少原目录的备份核对信息，不能作为联合快照。');
 unused(source,lease);const files=listFiles(source,{exclude:true}),data=inspectDatabase(join(source,'workspace.sqlite'));unused(source,lease);
 const databaseUnchanged=payloadHash(data)===payloadHash(manifest.data),filesUnchanged=payloadHash(files)===payloadHash(manifest.sourceFiles);
 return {format:'synplex.workspace-source-comparison/1',databaseUnchanged,filesUnchanged,unchanged:databaseUnchanged&&filesUnchanged};
}
export function verifyWorkspaceSource(source,manifest,options){
 if(!compareWorkspaceSource(source,manifest,options).unchanged)throw new Error('联合备份期间原工作台发生变化，目标仅为未完成候选。');
 return {data:manifest.data,unchanged:true};
}
export function restoreWorkspace(source,target,{port}={}){
 ({source,target}=fresh(source,target));const manifest=verifySnapshot(source);unused(source);
 if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('恢复需要新的本机连接地址。');
 mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);writeFileSync(join(target,'restore-incomplete.json'),JSON.stringify({createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});copyFiles(source,target,manifest.files);
 const map=path=>{if(typeof path!=='string')throw new Error('连接路径无效。');path=resolve(path);const root=[manifest.source,manifest.pathRoot].find(root=>typeof root==='string'&&inside(root,path));if(!root)throw new Error('连接文件指向备份以外的位置，未启用恢复。');const suffix=relative(root,path);if(!manifest.files.some(f=>f.path===suffix))throw new Error('备份缺少对应连接文件。');return join(target,suffix);};
 const write=(name,value)=>writeFileSync(join(target,name),JSON.stringify(value,null,2),{mode:0o600});
 const connection=privateJSON(join(target,'connection.json'));validateWire('Scope',connection.scope);connection.endpoint=`http://127.0.0.1:${port}`;connection.uiTokenFile=map(connection.uiTokenFile);connection.agentTokenFile=map(connection.agentTokenFile);write('connection.json',connection);
 const catalog=join(target,'projects.json');if(existsSync(catalog)){const c=privateJSON(catalog);for(const p of c.entries)for(const key of ['uiTokenFile','agentTokenFile','dshTokenFile'])if(p[key])p[key]=map(p[key]);write('projects.json',c);}
 const executors=join(target,'executors.json');if(existsSync(executors))renameSync(executors,join(target,'executors.before-recovery.json'));
 const product=join(target,'product-start.json');if(existsSync(product))renameSync(product,join(target,'product-start.before-recovery.json'));
 write('recovery.json',{format:'synplex.safe-restoration/1',restoredAt:new Date().toISOString(),snapshot:source,unresolved:manifest.data.unresolved,executorsEnabled:false,
  nextAction:'可先查看资料与成果。原执行工具、外部数据库/队列和未知任务须按原身份核对，再由维护人员配置；不会自动重发。'});
 const data=inspectDatabase(join(target,'workspace.sqlite'));if(payloadHash(data)!==payloadHash(manifest.data))throw new Error('恢复数据不一致，未启用。');unlinkSync(join(target,'restore-incomplete.json'));return {dataDir:target,endpoint:connection.endpoint,executorsEnabled:false,data};
}
// A joint-engine operation retains this SAME SQLite lease across its PG dump
// and recheck. EOF/crash releases it in the kernel; no stale PID cleanup. The
// protocol has no execute/restore/enable operation and never loads an executor.
export async function guardWorkspace(source){
 const lease=acquireWorkspaceLease(source);
 const input=createInterface({input:process.stdin,crlfDelay:Infinity});
 try{
  unused(lease.root,lease);
  console.log(JSON.stringify({format:'synplex.workspace-maintenance/1',ready:true}));
  for await(const line of input){
   let response;
   try{
    if(line.length>16384)throw Error();
    const command=JSON.parse(line);
    if(!command||Object.keys(command).some(key=>!['action','target'].includes(key)))throw Error();
    lease.assert();let result;
    if(command.action==='backup'){await snapshotWorkspace(source,command.target,{lease});result={backedUp:true};}
    else if(command.action==='verify-source')result=verifyWorkspaceSource(lease.root,verifySnapshot(command.target),{lease});
    else if(command.action==='compare-source')result=compareWorkspaceSource(lease.root,verifySnapshot(command.target),{lease});
    else if(command.action==='check-unused'){unused(lease.root,lease);result={unused:true};}
    else if(command.action==='handoff-audit'||command.action==='handoff-prepare'){
     const module=await import('./handoff-workspace.mjs');
     const handler=command.action==='handoff-audit'?module.auditHandoffWorkspace:module.prepareHandoffWorkspace;
     result=handler(lease,command.target,{inspectDatabase,verifySnapshot,listFiles});
    }
    else throw Error();
    response={ok:true,result};
   }catch{response={ok:false,message:'资料维护核对未完成，请保留原资料和未完成候选；没有启用或重新执行任务。'};}
   console.log(JSON.stringify(response));
   if(!response.ok)break;
  }
 }finally{input.close();lease.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [action,source,target,port]=process.argv.slice(2);if(!source||!['verify','guard'].includes(action)&&!target)throw new Error('请指定原资料和全新的目标文件夹。');let result;
 if(action==='guard'){await guardWorkspace(source);process.exit(0);}
 if(action==='backup')result=await snapshotWorkspace(source,target);else if(action==='restore')result=restoreWorkspace(source,target,{port:Number(port)});else if(action==='verify')result=verifySnapshot(source);else if(action==='verify-source')result=verifyWorkspaceSource(source,verifySnapshot(target));else if(action==='compare-source')result=compareWorkspaceSource(source,verifySnapshot(target));else throw new Error('请选择 backup、restore、verify、verify-source 或 compare-source。');
 console.log(action==='compare-source'?JSON.stringify(result):action==='backup'?'工作台备份已核对。外部执行引擎未包含，备份中有私人连接资料，请妥善保管。':action==='restore'?'资料已恢复到新目录，执行工具尚未启用；原资料未改动。':'资料指纹与备份内容核对通过。');
 }catch(error){console.error(error.message);process.exitCode=1;}
}
