import {randomUUID} from 'node:crypto';
import {PROTOCOL_VERSION,ProtocolError,payloadHash,validateWire} from '../../packages/contracts/validate.mjs';
import {estimatePacketTokens} from '../../packages/context/index.mjs';
import {curationPrompt} from '../../packages/ingestion/event-curation.mjs';
import {modelFailure,exactObject,validateSelection} from './model-contract.mjs';
const presentation=(batch,request,conversation)=>({body:{id:batch.id,status:batch.status==='completed'?'completed':batch.status==='failed'?'needs_review':request?.status??'prepared',notice:['completed','failed'].includes(batch.status)?batch.notice:request?.notice??'整理请求尚未发送；原资料仍保留。',conversationId:conversation.id,inputCount:batch.claims.length,outputCount:batch.outputClaimIds.length}});
function batchBackground(repository,auth,scope,batch){
 const state=repository.revision(auth,scope);
 for(const claim of batch.claims)if(payloadHash(repository.read(auth,scope,'claim',claim.id))!==payloadHash(claim))throw modelFailure('原线索已变化，请按最新资料重新整理。','保留原记录和回复。','stale_context');
 // The exact batch text is already in the frozen user message. Do not retrieve
 // the whole project a second time: it costs tokens and can contaminate it.
 const packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope,...state,goal:'整理指定原文线索',constraints:[],acceptanceCriteria:['每条线索分配一次，保留关键约束和负结果'],facts:[],failures:[],lessons:[],candidates:[],conflicts:[],unknowns:['本次只整理消息中指定的原文，来源绑定由系统核对；不据此判断整个项目完成情况。'],evidence:[],selectedOccurrenceIds:[],coverage:'partial',budget:{maxInputTokens:64000,reservedTokens:512,estimatedTokens:0,estimatorVersion:'utf8-bytes-conservative/1'},createdAt:new Date().toISOString()};
 packet.budget.estimatedTokens=estimatePacketTokens(packet);packet.contentHash=payloadHash(packet);return validateWire('ContextPacket',packet);
}

function settleFailure(repository,auth,scope,batch,request){
 if(['failed','stopped'].includes(request?.status)&&batch.status==='prepared')return repository.failCuration(auth,scope,batch.id,request.notice+' 原回复与用量保留，没有重新发送。');
 return batch;
}

export function createCurationRoutes(repository,service){
 return async({path,auth,input})=>{
  const start=path==='/api/v1/ui_curate_start',state=path==='/api/v1/ui_curate_state';if(!start&&!state)return null;
  exactObject(input,start?['protocolVersion','scope','requestId','expectedStateRevision','selection']:['protocolVersion','scope','id']);
  if(auth.kind!=='ui'||input.protocolVersion!==PROTOCOL_VERSION)throw modelFailure('请在当前项目中整理资料。');
  let batch;
  if(start){
   const connection=repository.models(auth,input.scope).list().find(c=>c.id===input.selection?.connectionId);
   if(!connection)throw modelFailure('先添加或选择可用模型，再整理资料。');validateSelection(connection,input.selection);
   batch=repository.admitCuration(auth,input);
  }else batch=repository.curation(auth,input.scope,input.id);
  const chat=repository.chat(auth,input.scope),conversation=chat.create('curation-'+batch.id),requestId='curation-'+batch.id;
  // Only an explicit start may submit. Poll/reload/restart never resends a
  // request, even if a previous submission has an unknown outcome.
  let request=chat.request(conversation.id,requestId);
  if(start&&batch.status==='prepared'&&!request)request=await service.send(auth,{scope:input.scope,conversationId:conversation.id,requestId,content:batch.prompt??curationPrompt(batch.claims),selection:batch.selection,excludedClaimIds:[]},{background:batchBackground(repository,auth,input.scope,batch)});
  batch=settleFailure(repository,auth,input.scope,batch,request);
  if(request?.status==='completed'&&batch.status==='prepared'){
   try{batch=repository.finishCuration(auth,input.scope,batch.id,request.id);}
   catch(error){
    const notice=error instanceof ProtocolError?error.message:'整理结果尚未保存完整，请查看原回复，不要重新发送。';
    // Persist a definitive validation rejection; never replace an unknown
    // submission or a storage failure with an automatically retried call.
    if(error instanceof ProtocolError&&['conflict','validation_failed','stale_context'].includes(error.code))batch=repository.failCuration(auth,input.scope,batch.id,notice);
    return {body:{id:batch.id,status:'needs_review',notice,conversationId:conversation.id,inputCount:batch.claims.length,outputCount:0}};
   }
  }
  return presentation(batch,request,conversation);
 };
}
