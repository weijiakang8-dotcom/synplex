// Offline, one-way materials -> fresh full instance migration. Old execution
// identities require the joint recovery protocol and are deliberately refused.
import {existsSync,readFileSync,writeFileSync,copyFileSync,chmodSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {verifySnapshot,restoreWorkspace,inspectDatabase} from '../scripts/runtime/recovery.mjs';
import {acquireWorkspaceLease} from '../scripts/runtime/workspace-lease.mjs';
import {requiredDataFeatures} from '../scripts/runtime/data-compatibility.mjs';
import {payloadHash} from '../packages/contracts/hash.mjs';

export function migrateMaterials(snapshot,root,{port=5200}={}){
 snapshot=resolve(snapshot);root=resolve(root);
 const target=join(root,'workspace'),receipt=join(root,'materials-migration.json');
 if(existsSync(receipt))throw Error('已有迁移记录，请核对原结果，不能重复迁移。');
 const manifest=verifySnapshot(snapshot);
 const forbidden=manifest.data.counts.some(r=>/^(execution_|remote_|task_|artifact)/.test(r.kind));
 if(manifest.data.unresolved||forbidden||['executors.json','product-start.json','recovery.json','handoff-pending.json','handoff-retired.json','accounts'].some(n=>existsSync(join(snapshot,n)))||requiredDataFeatures(join(snapshot,'workspace.sqlite')).length)throw Error('此工具仅迁移没有执行身份、账号或新能力数据的资料工作台；请使用联合恢复流程。');
 const lease=acquireWorkspaceLease(target);let bootstrap;
 try{
  const state=inspectDatabase(join(target,'workspace.sqlite'));
  if(state.counts.length||state.unresolved||requiredDataFeatures(join(target,'workspace.sqlite')).length)throw Error('目标工作台已有用户数据，未覆盖。');
  for(const name of ['product-start.json','executors.json'])if(!existsSync(join(target,name)))throw Error('请先完成独立完整后台安装，再离线迁移。');
  const product=JSON.parse(readFileSync(join(target,'product-start.json'),'utf8'));
  if(product.workspaceDataDir!==target||product.engineRoot!==join(root,'engine'))throw Error('目标完整后台不属于本资料目录。');
  const current=JSON.parse(readFileSync(join(target,'connection.json'),'utf8')),old=JSON.parse(readFileSync(join(snapshot,'connection.json'),'utf8'));
  if(payloadHash(current.scope)!==payloadHash(old.scope))throw Error('原项目范围与目标安装不一致，未迁移。');
  bootstrap=target+'.before-materials-'+randomUUID();
  writeFileSync(receipt,JSON.stringify({status:'prepared',snapshot,bootstrap,fingerprint:manifest.data.contentHash,modelCalls:0}),{flag:'wx',mode:0o600});
  renameSync(target,bootstrap);
 }finally{lease.close();}
 // On failure both original snapshot and pristine bootstrap remain. No
 // automatic startup, resubmission, deletion or downgrade is attempted.
 restoreWorkspace(snapshot,target,{port});
 for(const name of ['product-start.json','executors.json','打开Synplex.command']){
  if(!existsSync(join(bootstrap,name)))continue;
  copyFileSync(join(bootstrap,name),join(target,name));chmodSync(join(target,name),name.endsWith('.command')?0o700:0o600);
 }
 const recoveryFile=join(target,'recovery.json'),recovery=JSON.parse(readFileSync(recoveryFile,'utf8'));
 if(inspectDatabase(join(target,'workspace.sqlite')).contentHash!==manifest.data.contentHash)throw Error('迁移后数据不一致，执行保持停用。');
 writeFileSync(recoveryFile,JSON.stringify({...recovery,executorsEnabled:true,materialsOnlyMigration:receipt}),{mode:0o600});
 writeFileSync(receipt,JSON.stringify({status:'complete',snapshot,bootstrap,fingerprint:manifest.data.contentHash,modelCalls:0}),{mode:0o600});
 return {migrated:true,fingerprint:manifest.data.contentHash,bootstrap,modelCalls:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(migrateMaterials(process.argv[2],process.argv[3])));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
