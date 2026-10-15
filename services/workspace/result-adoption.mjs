import {ProtocolError,PROTOCOL_VERSION,payloadHash} from '../../packages/contracts/validate.mjs';
const fail=(message,code='conflict')=>{throw new ProtocolError(code,message,'保留各版成果，查看步骤的最新进展后再选择。');};
export function validateResultAdoption(request){
 if(!request||Object.keys(request).sort().join(',')!=='expectedStateRevision,nodeId,note,planId,protocolVersion,requestId,resultId,scope,stepHash'||request.protocolVersion!==PROTOCOL_VERSION||
  !['planId','nodeId','resultId'].every(k=>typeof request[k]==='string'&&request[k].length>0&&request[k].length<=160)||
  typeof request.stepHash!=='string'||!/^[a-f0-9]{64}$/.test(request.stepHash)||typeof request.note!=='string'||!request.note.trim()||request.note.length>4000)
  fail('请选一版成果，并写清为什么重新选用。','validation_failed');
}
export function resultAdoption(plan,request,read){
 const node=plan.nodes.find(n=>n.id===request.nodeId);
 if(!node||node.executionHash!==request.stepHash)fail('步骤或成果已经更新，请重新选择。','stale_context');
 if(plan.nodes.some(n=>['queued','running','unknown'].includes(n.status)))fail('安排中仍有正在执行或结果待核对的任务，暂时不能换用成果。');
 if(['ready','prepared','needs_input','blocked_dependency','stale_input'].includes(node.status)||!node.resultId)fail('先处理当前步骤的说明或前置成果，再选择历史版本。');
 const result=read('result',request.resultId),attempt=result&&read('attempt',result.attemptId),link=attempt&&node.history.find(h=>h.runId===attempt.runId);
 if(!link||!result||node.resultId===result.id)fail('请选择这个步骤中另一版已保存的成果。');
 const run=read('run',attempt.runId);
 if(run?.mode!=='host_assist'&&!['succeeded','failed','cancelled'].includes(attempt.status))fail('所选版本的执行结果仍需核对。');
 if(payloadHash(link.inputRefs)!==payloadHash(node.inputRefs))fail('这版成果使用的前置资料已变化，不能当作当前步骤成果。');
 return {node,result,run,inputRefs:link.inputRefs};
}
