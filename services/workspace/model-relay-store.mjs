import {randomUUID,createHmac} from 'node:crypto';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {modelFailure} from './model-contract.mjs';
import {modelPrivateToken} from './model-vault.mjs';

export const RELAY_TABLES=['model_execution_grants','model_execution_calls'];
const decode=row=>row?JSON.parse(row.body_json):null;
export class ModelRelayStore{
  #db;#dir;
  constructor(db,dataDir){
    this.#db=db;this.#dir=dataDir;
    db.exec(`CREATE TABLE IF NOT EXISTS model_execution_grants(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL UNIQUE,body_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS model_execution_calls(id TEXT PRIMARY KEY,grant_id TEXT NOT NULL REFERENCES model_execution_grants(id),input_hash TEXT NOT NULL,status TEXT NOT NULL,body_json TEXT NOT NULL,response BLOB,UNIQUE(grant_id,input_hash));
      CREATE INDEX IF NOT EXISTS model_call_grant ON model_execution_calls(grant_id,status);`);
  }
  #transaction(fn){this.#db.exec('BEGIN IMMEDIATE');try{const value=fn();this.#db.exec('COMMIT');return value;}catch(error){this.#db.exec('ROLLBACK');throw error;}}
  token(id){return modelPrivateToken(this.#dir,'execution-grant:'+id);}
  grant(input){
    const old=decode(this.#db.prepare('SELECT body_json FROM model_execution_grants WHERE operation_id=?').get(input.operationId));
    if(old){const {id,createdAt,status,...original}=old;if(payloadHash(original)!==payloadHash(input))throw modelFailure('原任务的模型设置发生变化。','请核对原任务，不重新发送。','conflict');return old;}
    const value={...input,id:randomUUID(),createdAt:new Date().toISOString(),status:'active'},token=this.token(value.id);
    this.#db.prepare('INSERT INTO model_execution_grants VALUES(?,?,?,?)').run(value.id,value.operationId,payloadHash(token),JSON.stringify(value));return value;
  }
  byOperation(operationId){return decode(this.#db.prepare('SELECT body_json FROM model_execution_grants WHERE operation_id=?').get(operationId));}
  authorize(token){const value=decode(this.#db.prepare('SELECT body_json FROM model_execution_grants WHERE token_hash=?').get(payloadHash(token)));if(!value||value.status!=='active')throw modelFailure('本次模型连接已失效。','请核对原任务。','scope_denied');return value;}
  inputHash(grant,body){return createHmac('sha256',this.token(grant.id)).update(payloadHash(body)).digest('hex');}
  reserve(grant,body){
    return this.#transaction(()=>{
      const hash=this.inputHash(grant,body),old=this.#db.prepare('SELECT * FROM model_execution_calls WHERE grant_id=? AND input_hash=?').get(grant.id,hash);
      if(old){if(old.status==='completed')return {fresh:false,value:decode(old),response:old.response};throw modelFailure('原模型请求尚需核对。','已有内容保留，不会重新计费提交。','conflict');}
      if(this.#db.prepare("SELECT 1 FROM model_execution_calls WHERE grant_id=? AND status IN ('running','unknown')").get(grant.id))throw modelFailure('这个任务仍有模型请求需要核对。','请先查看原请求和服务商记录。','conflict');
      if(this.#db.prepare('SELECT count(*) n FROM model_execution_calls WHERE grant_id=?').get(grant.id).n>=grant.maxCalls)throw modelFailure('本次任务已达到模型请求上限。','请核对已有成果，再决定是否调整任务。','budget_exceeded');
      const value={id:randomUUID(),grantId:grant.id,operationId:grant.operationId,attemptId:grant.attemptId,selection:grant.selection,...(grant.binding.priceSnapshot?{priceSnapshot:grant.binding.priceSnapshot}:{}),status:'running',usage:null,costUsd:null,providerReceipt:null,startedAt:new Date().toISOString(),finishedAt:null};
      this.#db.prepare('INSERT INTO model_execution_calls VALUES(?,?,?,?,?,NULL)').run(value.id,grant.id,hash,'running',JSON.stringify(value));return {fresh:true,value};
    });
  }
  finish(id,{status,usage=null,providerReceipt=null,response=null,contentType=null}){
    this.#transaction(()=>{const row=this.#db.prepare('SELECT * FROM model_execution_calls WHERE id=?').get(id);if(!row||row.status!=='running')return;const value={...decode(row),status,usage,providerReceipt,contentType,finishedAt:new Date().toISOString()};this.#db.prepare('UPDATE model_execution_calls SET status=?,body_json=?,response=? WHERE id=?').run(status,JSON.stringify(value),response,id);});
  }
  complete(operationId){const grant=this.byOperation(operationId);if(!grant)return null;const pending=this.#db.prepare("SELECT 1 FROM model_execution_calls WHERE grant_id=? AND status IN ('running','unknown')").get(grant.id);if(pending)return null;grant.status='completed';this.#db.prepare('UPDATE model_execution_grants SET body_json=? WHERE id=?').run(JSON.stringify(grant),grant.id);return grant;}
  calls(operationId){const grant=this.byOperation(operationId);return grant?this.#db.prepare('SELECT body_json FROM model_execution_calls WHERE grant_id=? ORDER BY rowid').all(grant.id).map(decode):[];}
  accounting(partition){
    return this.#db.prepare("SELECT c.body_json FROM model_execution_calls c JOIN model_execution_grants g ON g.id=c.grant_id JOIN records a ON a.id=json_extract(g.body_json,'$.attemptId') AND a.kind='attempt' WHERE a.partition=? ORDER BY c.rowid").all(partition).map(decode);
  }
  review(operationId){
    return this.#transaction(()=>{
      const grant=this.byOperation(operationId);if(!grant)throw modelFailure('没有找到本次模型请求。');
      if(this.#db.prepare("SELECT 1 FROM model_execution_calls WHERE grant_id=? AND status='running'").get(grant.id))throw modelFailure('模型请求还没有结束。','请先停止并核对原任务。','conflict');
      for(const call of this.calls(operationId).filter(c=>c.status==='unknown')){
        const value={...call,status:'reviewed',reviewedAt:new Date().toISOString(),notice:'已保留原请求；结果和费用仍按服务商记录核对，原请求不会重发。'};
        this.#db.prepare("UPDATE model_execution_calls SET status='reviewed',body_json=? WHERE id=?").run(JSON.stringify(value),call.id);
      }
      grant.status='completed';this.#db.prepare('UPDATE model_execution_grants SET body_json=? WHERE id=?').run(JSON.stringify(grant),grant.id);
      return this.calls(operationId);
    });
  }
  interrupt(){for(const row of this.#db.prepare("SELECT * FROM model_execution_calls WHERE status='running'").all()){const value={...decode(row),status:'unknown',finishedAt:new Date().toISOString()};this.#db.prepare("UPDATE model_execution_calls SET status='unknown',body_json=? WHERE id=?").run(JSON.stringify(value),row.id);}}
}
