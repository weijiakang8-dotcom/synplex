import {sha256,ProtocolError} from '../../packages/contracts/validate.mjs';
import {validateQuestion} from '../../services/workspace/execution-question.mjs';

const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
const fail=()=>{throw new ProtocolError('conflict','操作确认记录需要核对。','保留当前任务，核对原操作；不要重新执行或重复确认。','lookup_operation');};
const decisionText=(hash,approved)=>JSON.stringify({approved,snapshotHash:hash});
function matchesDecision(record,intent,input,targetKey){
 const {operationId,attemptId,question}=input,choice=question.answers?.approval?.answers?.[0];
 return record.targetKey===targetKey&&record.attemptId===attemptId&&question.operationId===operationId&&question.status==='answered'&&
  question.prompt.threadId===record.taskId&&intent.questionId===question.id&&intent.snapshotHash===question.prompt.approval.snapshotHash&&
  choice===(intent.approved?'允许这次操作':'拒绝操作')&&intent.decisionHash===sha256(Buffer.from(decisionText(intent.snapshotHash,intent.approved)));
}
export function validApproval(value){
 return value&&/^[a-f0-9]{64}$/.test(value.snapshotHash)&&Array.isArray(value.operations)&&value.operations.length>0&&value.operations.length<=10&&
  value.operations.every(o=>typeof o.tool==='string'&&o.tool.length>0&&o.tool.length<=160&&o.params&&typeof o.params==='object'&&!Array.isArray(o.params))&&
  Buffer.byteLength(JSON.stringify(value.operations))<=32000;
}
export function operationApproval({request,save,targetKey}){
 async function pending(input,record){
  const value=await request('/api/synplex/executions/'+record.taskId+'/approval',{signal:input.signal});
  if(value.protocol!=='synplex.operation-approval/1'||value.executionId!==record.taskId||!uuid(value.requestId)||!validApproval(value))fail();
  if(record.approvalIntents?.[value.requestId])fail();
  return validateQuestion({remoteRequestId:value.requestId,threadId:record.taskId,turnId:value.requestId,itemId:value.snapshotHash,
   approval:{snapshotHash:value.snapshotHash,operations:value.operations},questions:[{id:'approval',header:'确认操作',
    question:'是否允许执行下面的操作？只确认本次列出的内容，拒绝后不会执行这些操作。',isSecret:false,isOther:false,
    options:[{label:'拒绝操作',description:'不执行列出的操作，已有资料和成果保留。'},{label:'允许这次操作',description:'仅允许本次列出的具体内容；改变后需要重新确认。'}]}]});
 }
 async function answer(input,record,prompt){
  if(!input.requestInput)fail();const reply=await input.requestInput(prompt);if(!reply)return;
  const choice=reply.answers.approval?.answers?.[0];if(!['拒绝操作','允许这次操作'].includes(choice))fail();
  const approved=choice==='允许这次操作',requestId=prompt.remoteRequestId,hash=prompt.approval.snapshotHash;
  record.approvalIntents={...record.approvalIntents,[requestId]:{questionId:reply.questionId,snapshotHash:hash,
   decisionHash:sha256(Buffer.from(decisionText(hash,approved))),approved,status:'unknown'}};
  save(input.operationId,record);
  const receipt=await request('/api/synplex/executions/'+record.taskId+'/approval',{body:{requestId,snapshotHash:hash,approved},signal:input.signal});
  if(receipt.requestId!==requestId||receipt.executionId!==record.taskId||receipt.status!=='resuming')fail();
  record.approvalIntents[requestId].status='sent';save(input.operationId,record);input.inputDelivered?.(reply.questionId);
 }
 async function inspect(input){
  const {record,question}=input;
  const intent=record?.approvalIntents?.[question.prompt.remoteRequestId];if(!intent)return false;
  if(!matchesDecision(record,intent,input,targetKey))fail();
  let receipt;try{receipt=await request('/api/synplex/executions/'+record.taskId+'/approval-deliveries/'+question.prompt.remoteRequestId);}catch{return false;}
  if(receipt.protocol!=='synplex.operation-decision/1'||receipt.executionId!==record.taskId||receipt.requestId!==question.prompt.remoteRequestId||
   receipt.decisionSha256!==intent.decisionHash||!['queued','running','finished','unknown'].includes(receipt.deliveryState))fail();
  return true;
 }
 return {pending,answer,inspect};
}
