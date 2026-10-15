import {existsSync,readFileSync,lstatSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {payloadHash} from '../../packages/contracts/hash.mjs';

const records=Object.freeze({task_followup:'task-followup/1',task_result_selection:'task-result-selection/1',project_expression_version:'project-expression-version/1',project_expression_stop:'project-expression-version/1'});
export function releaseFeatures(root){
 const file=join(root,'migrations/workspace-features.json');if(!existsSync(file))return [];
 if(lstatSync(file).isSymbolicLink()||!lstatSync(file).isFile())throw new Error('版本的资料能力声明不是普通文件。');
 const v=JSON.parse(readFileSync(file,'utf8'));
 if(Object.keys(v).sort().join(',')!=='features,format'||v.format!=='synplex.workspace-features/1'||!Array.isArray(v.features)||v.features.length>64||new Set(v.features).size!==v.features.length||v.features.some(x=>typeof x!=='string'||!(/^[a-z][a-z0-9-]*\/[1-9][0-9]*$/).test(x)))throw new Error('版本的资料能力声明无效。');
 return [...v.features].sort();
}
export function verifyFeatureDeclaration(root,manifest){
 if(payloadHash(manifest.workspaceFeatures??[])!==payloadHash(releaseFeatures(root)))throw new Error('版本的资料能力声明与实际文件不一致，不能启动。');
}
export function requiredDataFeatures(database){
 const stat=lstatSync(database);if(stat.isSymbolicLink()||!stat.isFile())throw new Error('资料数据库不安全，不能检查版本兼容性。');
 const db=new DatabaseSync(database,{readOnly:true});
 try{
  // A schema version alone cannot express whether a program understands the
  // semantics of appended record kinds. This is read-only and does not parse
  // user documents or change the logical data fingerprint.
  const found=db.prepare('SELECT DISTINCT kind FROM records WHERE kind IN (SELECT value FROM json_each(?))').all(JSON.stringify(Object.keys(records)));
  const features=found.map(r=>records[r.kind]);
  // Control records live beside SQLite. Even an incomplete or malformed
  // witness requires a program that understands the fail-closed protocol;
  // never remove or parse it as ordinary user material to permit rollback.
  for(const name of ['handoff-pending.json','handoff-retired.json']){
   try{lstatSync(join(dirname(database),name));features.push('idle-product-handoff/1');}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(db.prepare("SELECT 1 FROM records WHERE kind='context' AND json_type(body_json,'$.chatReference') IS NOT NULL LIMIT 1").get())features.push('chat-task-reference/1');
  if(db.prepare("SELECT 1 FROM records WHERE kind='execution_question' AND json_type(body_json,'$.prompt.approval') IS NOT NULL LIMIT 1").get())features.push('operation-approval/1');
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_connections'").get()&&db.prepare("SELECT 1 FROM model_connections WHERE EXISTS (SELECT 1 FROM json_each(config_json,'$.models') WHERE json_type(value,'$.pricing')='object') LIMIT 1").get())features.push('model-price-snapshots/1');
  for(const [table,feature] of [['model_connections','model-connections/1'],['chat_conversations','chat-continuity/1'],['model_execution_grants','execution-model-connections/1']]){
   if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)&&db.prepare('SELECT 1 FROM '+table+' LIMIT 1').get())features.push(feature);
  }
  return [...new Set(features)].sort();
 }finally{db.close();}
}
export function assertDataFeatures(release,database){
 const available=new Set(releaseFeatures(release)),missing=requiredDataFeatures(database).filter(x=>!available.has(x));
 if(missing.length)throw new Error('这个版本不能完整理解现有资料或恢复接续记录，已保留当前版本。请选择兼容的新版本；不能通过删除记录来回退。');
}
