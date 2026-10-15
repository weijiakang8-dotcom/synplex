import {payloadHash,sha256,ProtocolError} from '../../packages/contracts/validate.mjs';

const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
function matchesOriginal({record,intent,question,operationId,attemptId,targetKey,answer}){
 return record.attemptId===attemptId&&record.targetKey===targetKey&&
  question.operationId===operationId&&question.status==='answered'&&
  question.prompt.threadId===record.taskId&&intent.questionId===question.id&&
  uuid(record.taskId)&&uuid(question.prompt.remoteRequestId)&&
  typeof answer==='string'&&payloadHash({answer})===intent.answerHash;
}

// Read-only reconciliation of a saved answer; this function cannot POST or
// restart a turn. A persisted receipt is not evidence of graph completion.
export function inputDeliveryReader({load,request,targetKey}){
 return async function inspectInputDelivery({operationId,attemptId,question}){
  const record=load(operationId),intent=record?.answerIntents?.[question.prompt.remoteRequestId];
  if(!intent)return false; // Missing old journal is not proof of delivery.
  const answer=question.answers?.answer?.answers?.[0];
  if(!matchesOriginal({record,intent,question,operationId,attemptId,targetKey,answer}))throw mismatch();
  let receipt;
  try{receipt=await request('/api/synplex/executions/'+record.taskId+'/input-deliveries/'+question.prompt.remoteRequestId);}
  catch{return false;} // Older/offline engines leave the answer explicitly unconfirmed.
  if(receipt?.protocol!=='synplex.input-delivery/1'||receipt.executionId!==record.taskId||
    receipt.questionId!==question.prompt.remoteRequestId||receipt.answerSha256!==sha256(Buffer.from(answer))||
    !['queued','running','finished','unknown'].includes(receipt.deliveryState))throw mismatch();
  return true;
 };
}
function mismatch(){return new ProtocolError('conflict','补充内容的送达记录不一致。','答案和原任务仍保留；请核对原任务，不要重复发送。','lookup_operation');}
