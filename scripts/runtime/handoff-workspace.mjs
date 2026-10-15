// Only called inside the existing offline maintenance lease. It prepares the
// already-defined executor/startup settings, never loads or runs an executor.
import {existsSync,readFileSync,writeFileSync,openSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {join,dirname,relative,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {requireWorkspaceLease} from './workspace-lease.mjs';
import {engineIdentity,writeProductLauncher,productLauncherScripts} from './product.mjs';
import {readHandoffJSON,validateHandoffProof,validateWorkspaceHandoff,HANDOFF_PENDING,HANDOFF_RETIRED} from './handoff-state.mjs';
import {verifyHandoffIntegrity} from './handoff-integrity.mjs';

const fail=()=>{throw Error('资料在备份后已有变化或仍有未完成工作，不能启用这个副本；请保留现有内容。');};
const equal=(a,b)=>payloadHash(a)===payloadHash(b);
function durableWrite(file,value){
 const temp=join(dirname(file),'.handoff-'+randomUUID());
 let fd;
 try{
  fd=openSync(temp,'wx',0o600);writeFileSync(fd,JSON.stringify(value,null,2));fsyncSync(fd);closeSync(fd);fd=undefined;
  renameSync(temp,file);fd=openSync(dirname(file),'r');fsyncSync(fd);
 }finally{if(fd!==undefined)closeSync(fd);if(existsSync(temp))unlinkSync(temp);}
}
function context(lease,intentPath,tools){
 const intent=readHandoffJSON(intentPath),proof=validateHandoffProof(intent.proof);
 if(resolve(intentPath)!==join(dirname(proof.target.workspace),'handoff-intent.json')||typeof intent.python!=='string'||!intent.python.startsWith('/'))fail();
 requireWorkspaceLease(lease,lease.root);
 if(![proof.source.workspace,proof.target.workspace].includes(lease.root))fail();
 const snapshot=join(proof.snapshot,'workspace'),manifest=tools.verifySnapshot(snapshot);
 if(manifest.source!==proof.source.workspace)fail();
 const state=tools.inspectDatabase(join(lease.root,'workspace.sqlite'));
 if(!equal(state,manifest.data)||state.unresolved)fail();
 verifyHandoffIntegrity(lease.root);
 return {intent,proof,snapshot,manifest,state};
}
function restoredSettings(c){
 const old=readHandoffJSON(join(c.snapshot,'executors.json'));
 if(Object.keys(old).join(',')!=='synplex')fail(); // Host installations are never remapped.
 const original=readHandoffJSON(join(c.proof.snapshot,'engine/engine/bootstrap.json'));
 if(old.synplex.endpoint!==`http://127.0.0.1:${original.api_port}`||old.synplex.workflowId!==original.workflow_id||old.synplex.tokenFile!==join(c.proof.source.engine,'engine/access-token'))fail();
 const identity=engineIdentity(c.proof.target.engine);
 const executors={synplex:{...old.synplex,endpoint:`http://127.0.0.1:${identity.apiPort}`,tokenFile:join(c.proof.target.engine,'engine/access-token')}};
 const product={format:'synplex.product-start/1',workspaceDataDir:c.proof.target.workspace,engineRoot:c.proof.target.engine,python:c.intent.python,identity};
 return {executors,product};
}
function mappedConnection(c,file){
 const value=readHandoffJSON(join(c.snapshot,file));
 const map=path=>{
  const root=[c.manifest.source,c.manifest.pathRoot].find(root=>path.startsWith(root+'/'));
  if(!root)fail();const suffix=relative(root,path);if(!c.manifest.files.some(f=>f.path===suffix))fail();
  return join(c.proof.target.workspace,suffix);
 };
 if(file==='connection.json'){
  const actual=readHandoffJSON(join(c.proof.target.workspace,file)),url=new URL(actual.endpoint);
  if(url.origin!==actual.endpoint||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash)fail();
  return {...value,endpoint:actual.endpoint,uiTokenFile:map(value.uiTokenFile),agentTokenFile:map(value.agentTokenFile)};
 }
 for(const entry of value.entries)for(const key of ['uiTokenFile','agentTokenFile','dshTokenFile'])if(entry[key])entry[key]=map(entry[key]);
 return value;
}
function checkRecoveryFlags(c){
 const root=c.proof.target.workspace,recovery=readHandoffJSON(join(root,'recovery.json'));
 if(recovery.format!=='synplex.safe-restoration/1'||resolve(recovery.snapshot)!==c.snapshot||![false,true].includes(recovery.executorsEnabled))fail();
 if(recovery.executorsEnabled&&!equal(recovery.handoff,c.proof))fail();
 if(existsSync(join(root,HANDOFF_PENDING))&&!equal(readHandoffJSON(join(root,HANDOFF_PENDING)),c.proof))fail();
}
function currentLauncher(root,file){
 return file.path==='打开Synplex.command'&&file.executable&&readFileSync(join(root,file.path),'utf8')===productLauncherScripts().script;
}
function checkRestoredFiles(c,tools,settings){
 const root=c.proof.target.workspace,expected=new Map();
 for(const file of c.manifest.files){
  if(file.path==='workspace.sqlite')continue;
  const name=({'executors.json':'executors.before-recovery.json','product-start.json':'product-start.before-recovery.json'})[file.path]??file.path;
  expected.set(name,file);
 }
 const additions=new Set(['recovery.json',HANDOFF_PENDING,'executors.json','product-start.json']);
 for(const file of tools.listFiles(root,{exclude:true})){
  if(additions.has(file.path))continue;
  if(currentLauncher(root,file)){expected.delete(file.path);continue;}
  const original=expected.get(file.path);if(!original)fail();
  if(['connection.json','projects.json'].includes(file.path)){
   if(!equal(readHandoffJSON(join(root,file.path)),mappedConnection(c,file.path)))fail();
  }else if(file.sha256!==original.sha256||file.byteLength!==original.byteLength||file.executable!==original.executable)fail();
  expected.delete(file.path);
 }
 if(expected.size)fail();
 checkRecoveryFlags(c);
 for(const [file,value] of [['executors.json',settings.executors],['product-start.json',settings.product]])if(existsSync(join(root,file))&&!equal(readHandoffJSON(join(root,file)),value))fail();
}
export function auditHandoffWorkspace(lease,intentPath,tools){
 const c=context(lease,intentPath,tools),settings=restoredSettings(c);
 if(lease.root===c.proof.source.workspace){
  if(existsSync(join(lease.root,HANDOFF_RETIRED))&&!equal(readHandoffJSON(join(lease.root,HANDOFF_RETIRED)),c.proof))fail();
  const files=tools.listFiles(lease.root,{exclude:true}).filter(f=>f.path!==HANDOFF_RETIRED);
  if(!equal(files,c.manifest.sourceFiles))fail();
 }else checkRestoredFiles(c,tools,settings);
 return {unchanged:true,unresolved:0,workspaceFingerprint:c.state.contentHash};
}
export function prepareHandoffWorkspace(lease,intentPath,tools){
 auditHandoffWorkspace(lease,intentPath,tools);
 const c=context(lease,intentPath,tools);validateWorkspaceHandoff(lease.root,c.proof,{complete:false});
 const settings=restoredSettings(c),recovery=readHandoffJSON(join(lease.root,'recovery.json'));
 // Pending is first, so a crash before the final joint receipt cannot expose
 // partially rewritten settings, even to a directly started server.
 durableWrite(join(lease.root,HANDOFF_PENDING),c.proof);
 durableWrite(join(lease.root,'executors.json'),settings.executors);
 durableWrite(join(lease.root,'product-start.json'),settings.product);
 writeProductLauncher(lease.root);
 const launcher=openSync(join(lease.root,'打开Synplex.command'),'r');try{fsyncSync(launcher);}finally{closeSync(launcher);}
 durableWrite(join(lease.root,'recovery.json'),{...recovery,executorsEnabled:true,handoff:c.proof,
  nextAction:'已核对并接管闲置实例。原记录保留；开始新任务前仍需明确操作，不会自动重做历史任务。'});
 return {prepared:true,workspaceFingerprint:c.state.contentHash,oldBindingsChanged:false};
}
