// Operator-only bulk import through the same admission/parser/receipt path as the UI.
// Never opens another tenant, reviews claims, follows symlinks or modifies the library.
import {readdirSync,lstatSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join,relative,basename,extname} from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import {sha256,PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {noteIdentity,noteTitle,OBSIDIAN_SOURCE} from '../../public/obsidian-notes.js';
import {uploadFormat,DOCUMENT_FORMATS} from '../../public/document-formats.js';
import {acquireWorkspaceLease} from './workspace-lease.mjs';
const supported=new Set(['.md','.markdown','.txt',...Object.keys(DOCUMENT_FORMATS).map(x=>'.'+x)]);
// A literal credential must never silently enter searchable project context.
const secrets=/(?:-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{24,})\b|(?:api[_-]?key|password|密码|密钥)\s*[:=]\s*["']?[A-Za-z0-9_+\/-]{16,}["']?(?:\s|$))/i;
async function readMaterial(file){
 return new Promise((yes,no)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',"import{readFileSync}from'node:fs';process.stdout.write(readFileSync(process.argv[1]));",file],{stdio:['ignore','pipe','ignore']});
  let chunks=[],size=0,done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.stdout.destroy();child.kill('SIGKILL');child.unref();error?no(error):yes(value);};
  const timer=setTimeout(()=>finish(Error('library_read_timeout')),4000);
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>64*1024*1024)finish(Error('library_read_limit'));else chunks.push(chunk);});
  child.on('error',()=>finish(Error('library_read_failed')));child.on('close',code=>code===0?finish(null,Buffer.concat(chunks)):finish(Error('library_read_failed')));
 });
}
function scanLibrary(libraryDir,report){
 const paths=[];function walk(dir){for(const name of readdirSync(dir).sort()){const file=join(dir,name),path=relative(libraryDir,file).split('\\').join('/'),stat=lstatSync(file);if(name.startsWith('.')||['node_modules','__pycache__'].includes(name)||stat.isSymbolicLink()){report.excluded.push({path,reason:'设置、缓存或链接，未读取'});continue;}if(stat.isDirectory())walk(file);else if(stat.isFile())paths.push({file,path,size:stat.size});}}
  walk(libraryDir);paths.sort((a,b)=>Number(!a.path.startsWith('项目/'))-Number(!b.path.startsWith('项目/'))||a.path.localeCompare(b.path));return paths;
}
function eligibleMaterial(item,ext,report){
 let reason=null;
 if(!supported.has(ext))reason='附件格式暂不支持读取；原件保留在笔记库';
 else if(item.size>64*1024*1024||ext==='.md'&&item.size>2*1024*1024)reason='超过当前单篇限制，未截断原件';
 if(reason){report.excluded.push({path:item.path,reason});return false;}return true;
}
function updateImportedName({record,admission,repository,auth,scope,requestId,isNote,item,bytes}){
    if(record.sourceId&&!admission.duplicate){const previous=repository.sourceMetadata(auth,scope,record.sourceId);if(!previous.locked)repository.updateSourceMetadata(auth,{protocolVersion:PROTOCOL_VERSION,scope,requestId:'name:'+sha256(Buffer.from(requestId)),expectedStateRevision:repository.revision(auth,scope).stateRevision,sourceId:record.sourceId,expectedMetadataRevision:previous.revision,metadata:{title:isNote?noteTitle(item.path,bytes.toString('utf8')):basename(item.path),category:item.path.split('/').slice(0,6).slice(0,-1).map(x=>x.slice(0,40)).join('/'),tags:['Obsidian'],locked:false}});}
}
async function importMaterial({item,repository,auth,scope,vault,service,report,save}){
   const ext=extname(item.path).toLowerCase();if(!eligibleMaterial(item,ext,report))return;
   let bytes;try{bytes=await readMaterial(item.file);}catch{report.excluded.push({path:item.path,reason:'本机文件读取超时或不可用，已跳过继续其他资料；原件未修改'});save();return;}const digest=sha256(bytes);
   if(secrets.test(bytes.toString('utf8'))){report.excluded.push({path:item.path,sha256:digest,reason:'疑似含真实凭据，未放入检索或模型背景'});return;}
   const isNote=ext==='.md',identity=isNote?noteIdentity(vault,item.path):{vault,path:item.path};
   const requestId=(isNote?'obs:':'lib:')+sha256(Buffer.from(JSON.stringify({...identity,sha256:digest})));
   const format=isNote?{format:'text/markdown',sourceSystem:OBSIDIAN_SOURCE,formatVersion:'1'}:uploadFormat(item.path);
   const metadata={protocolVersion:PROTOCOL_VERSION,scope,requestId,expectedStateRevision:repository.revision(auth,scope).stateRevision,...format,sessionId:JSON.stringify(identity),eventId:requestId,occurredAt:null,sourceName:basename(item.path)};
   try{
    const admission=await service.import(auth,metadata,bytes);await service.idle();
    const result=await repository.importResult(auth,scope,admission.operationId);
    const record={path:item.path,sha256:digest,byteLength:bytes.length,operationId:admission.operationId,sourceId:result.result?.source.id??null,status:result.operation.status,outcome:result.result?.outcome??null,duplicate:admission.duplicate};report.items.push(record);
    updateImportedName({record,admission,repository,auth,scope,requestId,isNote,item,bytes});
    if(['unknown','queued','running'].includes(record.status)){save();throw Error('导入结果仍需核对，保留回执，未重复执行。');}
   }catch(error){if(report.items.at(-1)?.path!==item.path)report.items.push({path:item.path,sha256:digest,status:'failed',code:error.code??'operator_error'});save();if(report.items.at(-1)?.status==='unknown')throw error;}
}
export async function importLibrary({dataDir,libraryDir,vault=basename(libraryDir),scope,reportFile}){
 dataDir=resolve(dataDir);libraryDir=resolve(libraryDir);
 if(!reportFile||!scope)throw Error('请明确指定项目、笔记库和私有回执位置。');
 const lease=acquireWorkspaceLease(dataDir);let repository;
 const report={format:'synplex.library-import/1',startedAt:new Date().toISOString(),vault,scope,items:[],excluded:[],modelCalls:0};
 const save=()=>writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});
 try{
  const connection=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8'));
  repository=new WorkspaceRepository({dataDir});const root=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim());
  // Explicitly bind the selected existing project, never mint a foreign owner.
  const catalog=JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8')).entries;
  const entry=catalog.find(p=>JSON.stringify(p.scope)===JSON.stringify(scope));if(!entry)throw Error('项目不在这份工作台中，未导入。');
  const auth=repository.authenticate(readFileSync(entry.uiTokenFile,'utf8').trim());
  if(auth.ownerId!==root.ownerId||auth.actorId!==root.actorId)throw Error('项目归属不一致，未导入。');
  const service=new WorkspaceService({repository,modules:{ingestion}});
  const paths=scanLibrary(libraryDir,report);save();const start=performance.now();
  for(const item of paths){
   await importMaterial({item,repository,auth,scope,vault,service,report,save});
   if(report.items.length&&report.items.length%20===0){save();console.log(JSON.stringify({processed:report.items.length,ms:Math.round(performance.now()-start)}));}
  }
  report.finishedAt=new Date().toISOString();report.elapsedMs=Math.round(performance.now()-start);report.counts=Object.fromEntries(['source','claim','occurrence'].map(kind=>[kind,repository.recordCount(auth,scope,kind)]));save();return report;
 }finally{repository?.close();lease.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [dataDir,libraryDir,projectId,reportFile]=process.argv.slice(2);
 try{const result=await importLibrary({dataDir,libraryDir,scope:{projectId,versionId:null,branchId:null},reportFile});console.log(JSON.stringify({finished:true,items:result.items.length,excluded:result.excluded.length,counts:result.counts,elapsedMs:result.elapsedMs}));}catch(error){console.error(error.message);process.exitCode=1;}
}
