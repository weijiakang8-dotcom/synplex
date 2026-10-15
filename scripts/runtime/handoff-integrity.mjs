// Inspect graph links and the human entry BEFORE retiring a working original.
// SQLite foreign keys cannot validate references stored inside JSON records.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {sha256,validateWire,payloadHash} from '../../packages/contracts/validate.mjs';
import {readHandoffJSON} from './handoff-state.mjs';

const fail=()=>{throw Error('原任务关联记录或工作台入口不完整，不能停用原实例；请保留资料并核对。');};
function checkJobs(db){
 const get=(partition,kind,id)=>{const row=db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? AND id=?').get(partition,kind,id);return row?JSON.parse(row.body_json):null;};
 for(const row of db.prepare("SELECT partition,id,kind,body_json FROM records WHERE kind IN ('execution_job','import_job')").iterate()){
  const job=JSON.parse(row.body_json),op=get(row.partition,'operation',row.id);if(!op)fail();
  const {kind,...wire}=op;validateWire('Operation',wire);
  if(row.kind==='import_job')continue;
  const run=get(row.partition,'run',job.runId),attempt=get(row.partition,'attempt',job.attemptId),packet=get(row.partition,'context',job.packetId);
  if(!run||!attempt||!packet)fail();
  validateWire('Run',run);validateWire('Attempt',attempt);
  if(!['succeeded','failed','cancelled'].includes(op.status)||attempt.status!==op.status||attempt.runId!==run.id||!run.attemptIds.includes(attempt.id)||run.contextPacketId!==packet.id)fail();
  const {contentHash,...content}=packet;if(contentHash!==payloadHash(content))fail();
 }
}
function checkHumanEntry(db,dataDir){
 const connection=readHandoffJSON(join(dataDir,'connection.json')),token=readFileSync(connection.uiTokenFile,'utf8').trim();
 const row=db.prepare('SELECT c.*,s.scope_json,s.permission_revision current_revision FROM credentials c JOIN scopes s USING(partition) WHERE token_hash=?').get(sha256(Buffer.from(token)));
 if(!row||row.revoked||row.kind!=='ui'||row.permission_revision!==row.current_revision||payloadHash(JSON.parse(row.scope_json))!==payloadHash(connection.scope))fail();
 const caps=JSON.parse(row.capabilities_json);if(!['read_memory','review_memory'].every(cap=>caps.includes(cap)))fail();
}
export function verifyHandoffIntegrity(dataDir){
 const db=new DatabaseSync(join(dataDir,'workspace.sqlite'),{readOnly:true});
 try{checkJobs(db);checkHumanEntry(db,dataDir);}finally{db.close();}
 return {jobLinksChecked:true,humanEntryChecked:true};
}
