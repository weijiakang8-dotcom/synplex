import {fetchModelCatalog} from './model-catalog.mjs';
import {randomUUID} from 'node:crypto';
import {exactObject,modelFailure} from './model-contract.mjs';
import {modelRequest} from './model-network.mjs';

export const MODEL_SERVICE_TABLES=['model_probes'];
export class ModelService{
  #repository;#db;#transport;
  constructor(repository,db,{transport=modelRequest}={}){
    this.#repository=repository;this.#db=db;this.#transport=transport;
    db.exec('CREATE TABLE IF NOT EXISTS model_probes(id TEXT NOT NULL,owner_id TEXT NOT NULL,actor_id TEXT NOT NULL,selection_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,PRIMARY KEY(id,owner_id,actor_id));');
  }
  async call(auth,input,action,{admin=false}={}){
    exactObject(input,['protocolVersion','scope','requestId','id','revision','kind','config','secret','action','selection','consent','endpoint']);
    const vault=this.#repository.models(auth,input.scope);
    if(action==='list')return {connections:vault.list(),canManageBuiltin:admin};
    if(action==='save')return {connection:vault.save(input,admin)};
    if(action==='change')return vault.change(input,admin);
    if(action==='discover')return input.endpoint!==undefined?fetchModelCatalog(this.#transport,input):this.#discover(vault,input);
    if(action==='probe')return this.#probe(auth,vault,input);
    throw modelFailure('没有这项模型操作。');
  }
  async #discover(vault,input){
    const choice=vault.list().find(c=>c.id===input.selection?.connectionId);
    if(!choice)throw modelFailure('请先保存模型连接。');
    const hold=randomUUID(),profile=vault.acquire(input.selection,hold);
    try{
      return await fetchModelCatalog(this.#transport,profile);
    }finally{vault.release(hold);}
  }
  #probeRow(auth,id){return this.#db.prepare('SELECT * FROM model_probes WHERE id=? AND owner_id=? AND actor_id=?').get(id,auth.ownerId,auth.actorId);}
  async #probe(auth,vault,input){
    if(input.consent!==true||typeof input.requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(input.requestId))throw modelFailure('试用会向服务商发送一条请求，可能产生费用。','请确认后再开始试用。');
    const previous=this.#probeRow(auth,input.requestId),selection=JSON.stringify(input.selection);
    if(previous){if(previous.selection_json!==selection)throw modelFailure('试用内容已改变。','请查看原试用结果。','conflict');return previous.result_json?JSON.parse(previous.result_json):{status:previous.status,notice:'原请求已提交，结果尚需核对；没有再次发送。'};}
    const hold='probe:'+randomUUID(),profile=vault.acquire(input.selection,hold);
    // Commit intent before sending. A crash/unknown result never authorizes a retry.
    try{this.#db.prepare('INSERT INTO model_probes VALUES(?,?,?,?,?,NULL)').run(input.requestId,auth.ownerId,auth.actorId,selection,'unknown');}
    catch(error){vault.release(hold);throw error;}
    try{
      const body=profile.binding.protocol==='responses'?{model:profile.binding.model,input:'Reply OK.',max_output_tokens:16}:{model:profile.binding.model,messages:[{role:'user',content:'Reply OK.'}],max_tokens:16};
      if(profile.binding.effort!==null){if(profile.binding.protocol==='responses')body.reasoning={effort:profile.binding.effort};else body.reasoning_effort=profile.binding.effort;}
      const bytes=await this.#transport({endpoint:profile.endpoint,path:profile.binding.protocol==='responses'?'/responses':'/chat/completions',secret:profile.secret,body,timeoutMs:30000});
      const response=JSON.parse(bytes.toString('utf8'));
      if(!Array.isArray(response.choices)&&!Array.isArray(response.output))throw modelFailure('模型返回的回复格式不正确。');
      const result={status:'completed',model:profile.binding.model,connectionId:profile.binding.connectionId,usage:probeUsage(response.usage),costUsd:null,notice:'已收到模型回复。实际费用待服务商账单确认；本次未验证工具执行。'};
      this.#finish(auth,input.requestId,result);return result;
    }catch{
      const result={status:'unknown',costUsd:null,usage:null,notice:'未取得完整回复，是否计费尚需核对。请检查服务商记录；不会自动重试。'};
      this.#finish(auth,input.requestId,result);return result;
    }finally{vault.release(hold);}
  }
  #finish(auth,id,result){this.#db.prepare('UPDATE model_probes SET status=?,result_json=? WHERE id=? AND owner_id=? AND actor_id=?').run(result.status,JSON.stringify(result),id,auth.ownerId,auth.actorId);}
}
export function probeUsage(raw){
  if(!raw||typeof raw!=='object')return null;
  const n=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  return {inputTokens:n(raw.prompt_tokens??raw.input_tokens),outputTokens:n(raw.completion_tokens??raw.output_tokens),cachedInputTokens:n(raw.prompt_tokens_details?.cached_tokens??raw.input_tokens_details?.cached_tokens)};
}
