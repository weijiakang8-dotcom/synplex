import {engineTenantId} from '../../packages/execution/tenant-identity.mjs';
import {existsSync,lstatSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProtocolError,payloadHash} from '../../packages/contracts/validate.mjs';
import {createModelConnectionExecutor} from './model-connections.mjs';
const fail=()=>{throw new ProtocolError('capability_unavailable','这个账号的执行服务暂时无法连接。','请保留原任务，由维护人员核对账号的执行连接；不会借用其他账号。','after_input');};
const privateText=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid())fail();return readFileSync(file,'utf8');};
function save(file,value){const temporary=file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,value,{mode:0o600,flag:'wx'});renameSync(temporary,file);}
// Tenant provisioning remains behind the trusted workspace's operator token.
// Every resulting delegate uses a distinct AgentHub organization and workflow.
export function createTenantAgentHubExecutor({legacyOwnerId='local-owner',...config}){
 const root=config.dataDir,bindings=join(root,'tenant-bindings'),pending=new Map();mkdirSync(bindings,{recursive:true,mode:0o700});
 function operationFile(id){if(typeof id!=='string'||!/^[a-f0-9-]{36}$/i.test(id))fail();return join(bindings,id+'.json');}
 function ownerFor(input){
  const file=input.operationId?operationFile(input.operationId):null,saved=file&&existsSync(file)?JSON.parse(privateText(file)):null,owner=input.authorization?.auth?.ownerId;
  if(saved&&(saved.operationId!==input.operationId||typeof saved.ownerId!=='string'||owner&&owner!==saved.ownerId))fail();
  return owner??saved?.ownerId??legacyOwnerId;
 }
 async function tenantConfig(ownerId){
  if(ownerId===legacyOwnerId)return config;
  const id=engineTenantId(ownerId),dir=join(root,'tenants',id),tokenFile=join(dir,'access-token'),file=join(dir,'identity.json');mkdirSync(dir,{recursive:true,mode:0o700});
  async function token(){
   if(existsSync(tokenFile)){
    const current=privateText(tokenFile);let expires=0;try{expires=JSON.parse(Buffer.from(current.split('.')[1],'base64url')).exp*1000;}catch{}
    if(expires>Date.now()+120000)return current;
   }
   if(!pending.has(id))pending.set(id,provision().finally(()=>pending.delete(id)));return pending.get(id);
  }
  async function provision(){
   const response=await fetch(config.endpoint+'/api/synplex/tenants/'+id,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+privateText(config.tokenFile).trim()},signal:AbortSignal.timeout(15000)});
   if(!response.ok){await response.body?.cancel();fail();}
   const raw=await response.text();if(raw.length>16384)fail();const value=JSON.parse(raw),keys=['organization_id','user_id','workflow_id','agent_id'];
   if(value.protocol!=='synplex.engine-tenant/1'||value.tenant_id!==id||keys.some(key=>typeof value[key]!=='string'||!/^[a-f0-9-]{36}$/i.test(value[key]))||typeof value.token!=='string'||value.token.length>8192)fail();
   const record={ownerId,tenantId:id,...Object.fromEntries(keys.map(key=>[key,value[key]]))};
   if(existsSync(file)&&payloadHash(JSON.parse(privateText(file)))!==payloadHash(record))fail();
   save(file,JSON.stringify(record));save(tokenFile,value.token);return value.token;
  }
  await token();const record=JSON.parse(privateText(file));if(record.ownerId!==ownerId||record.tenantId!==id)fail();
  return {...config,dataDir:dir,workflowId:record.workflow_id,tokenFile,tokenProvider:token};
 }
 async function delegate(input,{remember=false}={}){
  const ownerId=ownerFor(input);if(remember){const file=operationFile(input.operationId);if(!existsSync(file))save(file,JSON.stringify({ownerId,operationId:input.operationId}));}
  return createModelConnectionExecutor(await tenantConfig(ownerId));
 }
 const base=createModelConnectionExecutor(config);
 const wrapped={mode:'platform_owned',fileInputs:true,sourceFiles:true,getSelectionChoices:base.getSelectionChoices,validateSelection:base.validateSelection};
 for(const method of ['preflight','execute','lookup','inspectSubmission','inspectInputDelivery','inspectPendingInput','resumeObservation','cancel'])wrapped[method]=async input=>(await delegate(input,{remember:method==='execute'}))[method](input);
 return wrapped;
}
