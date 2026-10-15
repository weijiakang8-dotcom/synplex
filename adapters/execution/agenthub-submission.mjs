import {ProtocolError} from '../../packages/contracts/validate.mjs';

export const SUBMISSION_PROTOCOL='synplex.execution-submission/1';
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=()=>{throw new ProtocolError('conflict','还不能确认这次任务是否已经收到。','保留原任务，稍后核对；不会再次发送。','lookup_operation');};
export function submissionIdentity(operationId,attemptId,packetHash,payloadHash){
 if(!uuid(operationId)||!uuid(attemptId)||!hash(packetHash)||!hash(payloadHash))fail();
 return {operation_id:operationId,attempt_id:attemptId,packet_hash:packetHash,payload_hash:payloadHash};
}
export function submissionInspector({request,targetKey}){
 return async function inspectSubmission({operationId,attemptId,remoteSubmission}){
  const source=remoteSubmission;
  if(source?.id!==operationId||source.attemptId!==attemptId||source.taskId!==null||source.binding?.targetKey!==targetKey)fail();
  const expected=submissionIdentity(operationId,attemptId,source.binding.packetHash,source.binding.payloadHash);
  const query=new URLSearchParams({attempt_id:attemptId,packet_hash:expected.packet_hash,payload_hash:expected.payload_hash});
  let result;try{result=await request('/api/synplex/submissions/'+operationId+'?'+query);}catch{fail();}
  if(result?.protocol!==SUBMISSION_PROTOCOL||!uuid(result.execution_id)||Object.entries(expected).some(([key,value])=>result[key]!==value))fail();
  return {taskId:result.execution_id};
 };
}
