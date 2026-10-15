import {payloadHash} from '../../packages/contracts/validate.mjs';
import {connectionPrice} from './model-pricing.mjs';
import {modelFailure} from './model-contract.mjs';
import {modelRequest} from './model-network.mjs';
import {probeUsage} from './model-service.mjs';

export const modelChoiceId=(connectionId,model)=>connectionId+'.'+payloadHash(model);
export function executionModelChoices(connections){return connections.filter(c=>c.enabled).flatMap(c=>c.models.filter(m=>m.capabilities.tools).map(m=>({id:modelChoiceId(c.id,m.id),label:c.name+' · '+m.name,provider:'synplex',efforts:['default',...m.capabilities.efforts],...(m.pricing?{pricing:connectionPrice(c.id,m),estimateLimits:{contextWindow:m.capabilities.contextWindow,maxOutputTokens:c.maxOutputTokens,maxCalls:24}}:{})})));}
export function executionModelSelection(connections,options){
  for(const c of connections.filter(c=>c.enabled))for(const m of c.models){if(options?.model===modelChoiceId(c.id,m.id)&&m.capabilities.tools&&(options.effort==='default'||m.capabilities.efforts.includes(options.effort)))return {connectionId:c.id,model:m.id,effort:options.effort==='default'?null:options.effort};}
  throw modelFailure('请选择可以执行任务的模型。','打开模型设置，核对所选型号和思考程度。','capability_unavailable');
}
function outputBound(body,binding){
 const requested=body.max_output_tokens??body.max_completion_tokens??body.max_tokens??binding.maxOutputTokens;
 if(!Number.isSafeInteger(requested)||requested<1)throw modelFailure('本次回复长度设置不正确。');
 return Math.min(requested,binding.maxOutputTokens);
}
function providerBody(grant,body){
  const b=grant.binding,stream=body.stream===true;
  if(body.model!==grant.virtualModel||!Array.isArray(b.protocol==='responses'?body.input:body.messages))throw modelFailure('本次模型请求与任务不一致。');
  const wanted=body.reasoning_effort??body.reasoning?.effort??null;
  if(wanted!==b.effort)throw modelFailure('本次思考程度与选择不一致。');
  const outputLimit=outputBound(body,b),value={...body,model:b.model};delete value.temperature;
  const allowed=b.protocol==='responses'?new Set(['model','input','max_output_tokens','stream','reasoning','tools','tool_choice','parallel_tool_calls','store','include','instructions','previous_response_id','text']):new Set(['model','messages','max_tokens','max_completion_tokens','stream','stream_options','reasoning_effort','tools','tool_choice','parallel_tool_calls','n','stop','response_format']);
  if(Object.keys(value).some(k=>!allowed.has(k))||value.n&&value.n!==1||value.previous_response_id)throw modelFailure('这次模型请求包含未开放的选项。');
  delete value.n;delete value.max_completion_tokens;delete value.max_tokens;delete value.max_output_tokens;
  value[b.protocol==='responses'?'max_output_tokens':'max_tokens']=outputLimit;
  if(b.protocol==='responses')value.store=false;
  if(stream&&b.protocol==='chat-completions')value.stream_options={include_usage:true};
  if(Buffer.byteLength(JSON.stringify(value))+outputLimit>b.capabilities.contextWindow)throw modelFailure('本次资料超过所选模型的容量。','请减少资料或选择容量更大的模型。','budget_exceeded');
  return value;
}
function evidence(bytes,stream){
  let usage=null,providerReceipt=null,completed=!stream;
  const values=stream?bytes.toString('utf8').replace(/\r\n/g,'\n').split('\n\n').flatMap(block=>{const s=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(s==='[DONE]'){completed=true;return [];}return s?[JSON.parse(s)]:[];}):[JSON.parse(bytes)];
  for(const v of values){if(v.id)providerReceipt=String(v.id).slice(0,200);if(v.usage)usage=probeUsage(v.usage);if(v.type==='response.completed'){completed=true;usage=probeUsage(v.response?.usage);providerReceipt=v.response?.id??providerReceipt;}if(v.error||['failed','incomplete'].includes(v.status)||['response.failed','response.incomplete','error'].includes(v.type))completed=false;}
  return {usage,providerReceipt,completed};
}
export class ModelRelay{
  #repository;#store;#transport;#active=new Map();#closed=false;
  constructor({repository,store,transport=modelRequest}){this.#repository=repository;this.#store=store;this.#transport=transport;}
  grant(auth,scope,{operationId,attemptId,options,endpoint}){
    const access=this.#repository.executionModelAccess(auth,scope),selection=executionModelSelection(access.models.list(),options),virtualModel=options.model;
    const old=this.#store.byOperation(operationId);
    if(old){if(old.attemptId!==attemptId||old.credentialId!==access.credentialId||payloadHash(old.selection)!==payloadHash(selection))throw modelFailure('原任务的模型连接不一致。');return this.#binding(old,endpoint);}
    const profile=access.models.acquire(selection,'execution:'+operationId,{tools:true});
    try{const grant=this.#store.grant({operationId,attemptId,credentialId:access.credentialId,scope,selection,binding:profile.binding,virtualModel,maxCalls:24});return this.#binding(grant,endpoint);}
    catch(error){access.models.release('execution:'+operationId);throw error;}
  }
  #binding(grant,endpoint){return {protocol:'synplex.execution-model/1',grantId:grant.id,endpoint,token:this.#store.token(grant.id),model:grant.virtualModel,effort:grant.binding.effort,apiMode:grant.binding.protocol,maxOutputTokens:grant.binding.maxOutputTokens,contextWindow:grant.binding.capabilities.contextWindow};}
  choices(auth,scope){return executionModelChoices(this.#repository.executionModelAccess(auth,scope).models.list());}
  validate(auth,scope,options){return executionModelSelection(this.#repository.executionModelAccess(auth,scope).models.list(),options);}
  async call(token,path,body,signal){
    if(this.#closed)throw modelFailure('模型连接正在关闭。');
    const grant=this.#store.authorize(token),{auth,models}=this.#repository.resumeExecutionModelAccess(grant.credentialId,grant.scope);
    const state=this.#repository.executionState(auth,grant.scope,grant.operationId);
    if(state.attempt.id!==grant.attemptId||state.operation.status!=='running')throw modelFailure('这项任务当前不能请求模型。','请核对原任务状态。','scope_denied');
    if(path!==(grant.binding.protocol==='responses'?'/responses':'/chat/completions'))throw modelFailure('本次连接方式与选择不一致。');
    const profile=models.acquire(grant.selection,'execution:'+grant.operationId,{tools:true});if(payloadHash(profile.binding)!==payloadHash(grant.binding))throw modelFailure('原模型连接已变化。');
    const request=providerBody(grant,body),reserved=this.#store.reserve(grant,request);
    if(!reserved.fresh)return {bytes:Buffer.from(reserved.response),contentType:reserved.value.contentType,replayed:true};
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort();
    let resolveDone;const done=new Promise(resolve=>{resolveDone=resolve;});this.#active.set(reserved.value.id,{controller,done});const chunks=[];let total=0;
    try{
      await this.#transport({endpoint:profile.endpoint,path,secret:profile.secret,body:request,signal:controller.signal,onChunk:bytes=>{total+=bytes.length;if(total>2*1024*1024)throw modelFailure('模型回复超过本次容量。');chunks.push(Buffer.from(bytes));}});
      const bytes=Buffer.concat(chunks),observed=evidence(bytes,request.stream===true);if(!observed.completed)throw modelFailure('原模型回复尚未完整返回。');
      const contentType=request.stream?'text/event-stream':'application/json';this.#store.finish(reserved.value.id,{status:'completed',...observed,response:bytes,contentType});return {bytes,contentType,replayed:false};
    }catch{let observed={};try{observed=evidence(Buffer.concat(chunks),request.stream===true);}catch{}this.#store.finish(reserved.value.id,{status:'unknown',...observed});throw modelFailure('原模型回复尚需核对，已有记录保留。','不会自动重试或更换模型。','conflict');}
    finally{signal?.removeEventListener('abort',abort);this.#active.delete(reserved.value.id);resolveDone();}
  }
  finish(auth,scope,operationId){const access=this.#repository.executionModelAccess(auth,scope),grant=this.#store.byOperation(operationId);if(grant&&grant.credentialId!==access.credentialId)throw modelFailure('没有这项任务的模型权限。');if(this.#store.complete(operationId))access.models.release('execution:'+operationId);}
  calls(auth,scope,operationId){this.#repository.executionState(auth,scope,operationId);return this.#store.calls(operationId);}
  review(auth,scope,operationId){
    const access=this.#repository.executionModelAccess(auth,scope),state=this.#repository.executionState(auth,scope,operationId),grant=this.#store.byOperation(operationId);
    this.#repository.checkExecutionModelOwner(auth,scope,grant?.credentialId??null);
    if(!['succeeded','failed','cancelled'].includes(state.operation.status))throw modelFailure('原任务还没有核对结束。','请先核对进度，不能解除仍在执行的连接。','conflict');
    const calls=this.#store.review(operationId);access.models.release('execution:'+operationId);return {calls};
  }
  usage(auth,scope,operationId){
    const calls=this.calls(auth,scope,operationId),selection=calls[0]?.selection;
    const sum=key=>calls.length&&calls.every(c=>Number.isSafeInteger(c.usage?.[key]))?calls.reduce((n,c)=>n+c.usage[key],0):null;
    const complete=calls.length>0&&calls.every(c=>c.status==='completed'&&Number.isSafeInteger(c.usage?.inputTokens)&&Number.isSafeInteger(c.usage?.outputTokens));
    return {observationScope:complete?'attempt':'host_unavailable',provider:selection?'connection:'+selection.connectionId:null,model:selection?.model??null,inputTokens:sum('inputTokens'),outputTokens:sum('outputTokens'),cachedInputTokens:sum('cachedInputTokens'),costUsd:null,pricingRevision:null,provenance:complete?'provider_receipt':'unknown'};
  }
  async close(){this.#closed=true;for(const value of this.#active.values())value.controller.abort();await Promise.allSettled([...this.#active.values()].map(v=>v.done));}
}
