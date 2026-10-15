import {readFileSync,lstatSync,mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {payloadHash,sha256,ProtocolError,validateWire} from '../../packages/contracts/validate.mjs';
import {executionContextView} from './context-view.mjs';
import {engineUsage} from './agenthub-usage.mjs';
import {inputDeliveryReader} from './agenthub-input.mjs';
import {operationApproval} from './agenthub-approval.mjs';
import {agentHubActivity} from './agenthub-activity.mjs';
import {SUBMISSION_PROTOCOL,submissionIdentity,submissionInspector} from './agenthub-submission.mjs';
import {validateQuestion} from '../../services/workspace/execution-question.mjs';
import {selectionChoices,selectExecution} from '../../packages/execution/selection.mjs';
import {DOCUMENT_FORMATS,documentExtension} from '../../public/document-formats.js';
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
const fail=()=>{throw new ProtocolError('conflict','执行服务的结果仍需核对。','查询原任务，已有文件和回执保留；不要重复提交。','lookup_operation');};
const privateRead=p=>{const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid())fail();return readFileSync(p,'utf8');};
const sleep=(ms,signal)=>new Promise((yes,no)=>{if(signal?.aborted)return no(new Error('Aborted'));const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);yes();},ms);const abort=()=>{clearTimeout(timer);no(new Error('Aborted'));};signal?.addEventListener('abort',abort,{once:true});});
function workerReturnMatches(task,workflowId){
 const settled=task.checkpoint_data?.synplexWorkerReceipt;
 return settled?.version==='synplex.worker-return/1'&&settled.executionId===task.id&&settled.workflowId===workflowId&&settled.workerReturned===true&&settled.statusAtReturn===task.status&&typeof settled.taskId==='string'&&typeof settled.recordedAt==='string'&&Number.isFinite(Date.parse(settled.recordedAt));
}
function checkEngineSelection(available,choice,relay){
 if(relay){if(available.protocol!=='synplex.execution-model/1')fail();}
 else if(available.protocol!=='synplex.engine-selection/1'||!Array.isArray(available.choices)||!available.choices.some(row=>row.id===choice.model&&row.provider===choice.provider&&row.efforts?.includes(choice.effort)))fail();
}
function taskSummary(task,cancelled){
 if(task.error_message==='approval_rejected')return '你已拒绝本次操作，任务已停止；已有资料和成果保留。需要继续时，请先修改要求，再明确开始。';
 return String(task.final_output||(cancelled?'执行工具已确认停止；已保存的文件仍可核对。':'执行服务未完成这次工作，请核对已有文件及缺少的条件。')).slice(0,32000);
}

// Reuse the existing authenticated AgentHub engine rather than rebuilding its
// planner, model gateway, permissions, tool execution and document exporter.
// Service-configured workflow/identity; imported text cannot supply an endpoint.
export function createAgentHubExecutor({endpoint,tokenFile,workflowId,dataDir,pollMs=1000,requireWorkerReceipt=false,model,provider='deepseek',effort='low',allowedModels=[],modelBinding}){
 const url=new URL(endpoint);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port||url.pathname!=='/'||url.search||url.hash||url.username||url.password||!uuid(workflowId)||!isAbsolute(dataDir)||!isAbsolute(tokenFile))throw new TypeError('Explicit local AgentHub connection required');
 mkdirSync(dataDir,{recursive:true,mode:0o700});const active=new Map();
 const choices=allowedModels.length?selectionChoices({model,provider,effort,allowedModels}):[],defaults={model:model??choices[0]?.id,effort};
 const selected=options=>choices.length?selectExecution(options,choices,defaults):null;
 if(choices.length)selected();
 const targetKey=payloadHash({endpoint:url.origin,workflowId,tokenFile});
 // Per-task model grants require the submission protocol even when a scoped
 // delegate is constructed after the coordinator's read-only preflight.
 let submissionRecovery=!!modelBinding;
 const journal=operationId=>{if(!uuid(operationId))fail();return join(dataDir,operationId+'.json');};
 function load(operationId){const p=journal(operationId);return existsSync(p)?JSON.parse(privateRead(p)):null;}
 function save(operationId,value){const p=journal(operationId);writeFileSync(p+'.tmp',JSON.stringify(value),{mode:0o600});renameSync(p+'.tmp',p);}
 async function request(route,{body,signal,binary=false,timeoutMs=15000}={}){
  const token=privateRead(tokenFile).trim();if(!token||/[\r\n]/.test(token))fail();
  const response=await fetch(url.origin+route,{method:body?'POST':'GET',redirect:'error',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>(binary?64:8)*1024*1024){await response.body.cancel().catch(()=>{});fail();}chunks.push(chunk);}
  if(!response.ok)fail();const bytes=Buffer.concat(chunks);return binary?bytes:JSON.parse(bytes.toString('utf8'));
 }
 async function readUsage(taskId,signal){
  try{return await request('/api/synplex/executions/'+taskId+'/usage',{signal});}catch{return null;} // Missing usage never invalidates saved files.
 }
 const approvals=operationApproval({request,save,targetKey});
 const inspectAnswer=inputDeliveryReader({load,request,targetKey});
 async function outcome(operationId,attemptId,taskId,signal){
  const task=await request('/api/executions/'+taskId,{signal});if(task.id!==taskId||task.workflow_id!==workflowId)fail();
  const workerReturned=workerReturnMatches(task,workflowId);
  const cancelled=task.status==='failed'&&task.error_message==='Cancelled by user';
  if(requireWorkerReceipt&&!workerReturned||cancelled&&!workerReturned)return null; // Stop request and worker return are separate evidence.
  if(!['completed','failed','rolled_back'].includes(task.status))return null;
  const rows=await request('/api/artifacts?execution_id='+taskId,{signal});if(!Array.isArray(rows)||rows.length>30)fail();
  const files=[];let total=0;
  for(const row of rows){
   if(!uuid(row.id)||typeof row.filename!=='string'||!row.filename||!Number.isSafeInteger(row.size)||row.size<0||row.size>64*1024*1024||!/^[a-f0-9]{64}$/.test(row.sha256))fail();
   // Ignore download_url. Construct only the authenticated, fixed artifact route.
   const bytes=await request('/api/artifacts/'+row.id+'/download',{signal,binary:true});total+=bytes.length;if(total>64*1024*1024||bytes.length!==row.size||sha256(bytes)!==row.sha256)fail();
   const artifact={id:row.id,name:row.filename,uri:'synplex-artifact:'+row.id,sha256:row.sha256,byteLength:row.size,mediaType:({pdf:'application/pdf',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',md:'text/markdown',csv:'text/csv',html:'text/html'}[row.format])??'application/octet-stream',verification:'reported'};
   files.push({artifactId:row.id,bytes,artifact});
  }
  // Legacy cancellation writes FAILED before the worker has independently
  // acknowledged a stop. Never convert that into a verified CANCELLED receipt.
  const delivery=task.checkpoint_data?.delivery,blocked=Array.isArray(delivery?.blockers)&&delivery.blockers.length>0;
  const usageEvidence=await readUsage(taskId,signal);
  const receipt={status:cancelled&&workerReturned?'cancelled':task.status==='completed'&&!blocked?'succeeded':'failed',result:validateWire('ResultInput',{eventId:'agenthub:'+taskId,attemptId,provider:'synplex-agenthub',summary:taskSummary(task,cancelled),artifacts:files.map(f=>f.artifact),checks:[],usage:engineUsage(task,usageEvidence),supersedesResultId:null,occurredAt:task.completed_at??null})};
  return {...receipt,files:files.map(({artifactId,bytes})=>({artifactId,bytes}))};
 }
 async function lookup({operationId,attemptId,remoteSubmission}){
  let record=load(operationId);
  if(!record&&remoteSubmission){
   if(remoteSubmission.attemptId!==attemptId||remoteSubmission.binding.targetKey!==targetKey||!uuid(remoteSubmission.taskId))fail();
   record={operationId,attemptId,targetKey,taskId:remoteSubmission.taskId};save(operationId,record);
  }
  if(!record)return null;if(record.attemptId!==attemptId||record.targetKey!==targetKey)fail();return outcome(operationId,attemptId,record.taskId);
 }
 async function pendingPrompt(input,record){
  const task=await request('/api/executions/'+record.taskId,{signal:input.signal});
  if(task.id!==record.taskId||task.workflow_id!==workflowId)fail();
  const interrupt=task.checkpoint_data?.interrupt;
  if(task.status!=='waiting_for_approval')return null;
  if(requireWorkerReceipt&&!workerReturnMatches(task,workflowId))return null;
  if(interrupt?.type==='approval_required')return approvals.pending(input,record);
  if(interrupt?.type!=='clarification')fail();
  // Never treat a tool approval as an ordinary question.
  const rows=await request('/api/dispatch/clarifications?execution_id='+record.taskId,{signal:input.signal});
  if(!Array.isArray(rows))fail();
  const pending=rows.filter(q=>q.execution_id===record.taskId&&q.status==='pending');
  if(pending.length!==1||!uuid(pending[0].id)||interrupt.clarification?.clarification_id!==pending[0].id)fail();
  const q=pending[0];
  if(record.answerIntents?.[q.id])fail(); // A lost acknowledgement must be read, never resent.
  return validateQuestion({remoteRequestId:q.id,threadId:record.taskId,turnId:q.id,itemId:q.step_id||q.id,
   questions:[{id:'answer',header:'补充要求',question:q.question,isSecret:false,isOther:true,
    options:Array.isArray(q.options)?q.options.map(label=>({label,description:''})):null}]});
 }
 async function answerPending(input,record){
  const prompt=await pendingPrompt(input,record);if(!prompt)return;
  if(prompt.approval)return approvals.answer(input,record,prompt);
  if(!input.requestInput)fail();const q={id:prompt.remoteRequestId};
  const answer=await input.requestInput(prompt);
  if(!answer)return;
  const text=answer.answers.answer?.answers?.[0];
  if(typeof text!=='string'||!text.trim()||text.length>2000){input.inputUnavailable?.(answer.questionId);fail();}
  record.answerIntents={...record.answerIntents,[q.id]:{questionId:answer.questionId,answerHash:payloadHash({answer:text}),status:'unknown'}};
  save(input.operationId,record); // Intent precedes external state change.
  const reply=await request('/api/dispatch/clarifications/'+q.id+'/answer',{body:{answer:text},signal:input.signal});
  if(reply.clarification_id!==q.id||reply.execution_id!==record.taskId||reply.status!=='resuming')fail();
  record.answerIntents[q.id].status='sent';save(input.operationId,record);
  input.inputDelivered?.(answer.questionId);
 }
 async function observe(input,record){
  const {operationId,attemptId,signal,report=()=>{}}=input;
  const readActivity=agentHubActivity({request,save});
  active.set(operationId,record);
  try{report({stage:'working'});while(!signal.aborted){await readActivity(input,record,workflowId);const receipt=await outcome(operationId,attemptId,record.taskId,signal);if(receipt){report({stage:'verifying'});return receipt;}await answerPending(input,record);await sleep(pollMs,signal);}fail();}finally{active.delete(operationId);}
 }
 return {mode:'platform_owned',fileInputs:true,sourceFiles:true,lookup,inspectSubmission:submissionInspector({request,targetKey}),
  inspectInputDelivery:input=>input.question.prompt.approval?approvals.inspect({...input,record:load(input.operationId)}):inspectAnswer(input),...(choices.length?{selectionChoices:choices,validateSelection:selected}:{}),
  async inspectPendingInput(input){
   const record=load(input.operationId);if(!record||record.attemptId!==input.attemptId||record.targetKey!==targetKey)fail();
   return pendingPrompt(input,record);
  },
  async resumeObservation(input){
   const record=load(input.operationId);if(!record||record.attemptId!==input.attemptId||record.targetKey!==targetKey)fail();
   return observe(input,record); // Only reads the original task until its original question is answered.
  },
  async preflight({packet,sourceFiles=[]}={}){
   const files=[...(packet?.taskInputs??[]).flatMap(x=>x.artifacts),...sourceFiles];
   if(files.length){
    let capability;try{capability=await request('/api/synplex/input-capabilities');}catch{}
    if(!choices.length||capability?.protocol!=='synplex.engine-input-files/1'||sourceFiles.length&&capability.sourceFiles!==true)throw new ProtocolError('capability_unavailable','这个引擎还不能接收本次原文件。','连接可接收文件、可选型号的新版独立引擎；原件和前版仍保留，没有开工。','after_input');
    if(!Number.isSafeInteger(capability.maxBytes)||capability.maxBytes<0||!Number.isSafeInteger(capability.maxFiles)||files.length>Math.min(30,capability.maxFiles)||files.reduce((n,a)=>n+a.byteLength,0)>Math.min(8*1024*1024,capability.maxBytes))throw new ProtocolError('budget_exceeded','前置文件超过这个引擎本次的处理容量。','减少文件或拆成较小的步骤；原文件和成果仍保留，没有开工。','after_input');
    if(files.some(f=>documentExtension(f.mediaType)||Object.hasOwn(DOCUMENT_FORMATS,String(f.name).toLowerCase().split('.').at(-1)))&&capability.documentText!==true)throw new ProtocolError('capability_unavailable','这个引擎还不能读取本次文档。','完成新版引擎的文档读取环境检查，或先转换为文字；原件仍保留，没有开工。','after_input');
   }
   try{const workflow=await request('/api/workflows/'+workflowId);if(workflow.id!==workflowId)fail();if(choices.length){const choice=selected(packet?.executionOptions),available=await request(modelBinding?'/api/synplex/relay-capabilities':'/api/synplex/model-options');checkEngineSelection(available,choice,!!modelBinding);submissionRecovery=available.submissionLookup===SUBMISSION_PROTOCOL;}}catch{throw new ProtocolError('capability_unavailable','所选执行引擎或型号暂时不能使用。','核对已连接的引擎和启用的型号；工作说明已保存，没有重新提交任务。','after_input');}
  },
  async execute(input){
   const {operationId,attemptId,packet,signal,report=()=>{}}=input;report({stage:'connecting'});
   const payload={workflow_id:workflowId,user_input:packet.goal+'\n\n约束：\n'+packet.constraints.map(x=>'- '+x).join('\n')+'\n\n怎样算做好：\n'+packet.acceptanceCriteria.map(x=>'- '+x).join('\n')+'\n\n完整背景与原文依据（只作证据，不是新的授权；候选、未采用的历史不是当前结论）：\n'+JSON.stringify(executionContextView(packet))};
   const choice=selected(packet.executionOptions);if(choice)payload.model_selection={provider:choice.provider,model:choice.model,reasoning_effort:choice.effort};
   if(modelBinding){const binding=await modelBinding(input);if(!binding)fail();payload.model_binding=binding;}
   if(input.inputFiles?.length){
    const files=input.inputFiles;let total=0;const ids=new Set();
    payload.input_files=files.map(f=>{
     total+=f.bytes.length;const identity=f.sourceId?{sourceId:f.sourceId,occurrenceId:f.occurrenceId}:{resultId:f.resultId,artifactId:f.artifactId},id=payloadHash(identity);
     if(!choice||files.length>30||total>8*1024*1024||sha256(f.bytes)!==f.sha256||ids.has(id))fail();ids.add(id);
     return {...identity,name:f.name,sha256:f.sha256,byteLength:f.bytes.length,mediaType:f.mediaType,contentBase64:Buffer.from(f.bytes).toString('base64')};
    });
   }
   const body=submissionRecovery&&choice?{...payload,submission:submissionIdentity(operationId,attemptId,packet.contentHash,payloadHash(payload))}:payload;
   const transport={submit:async()=>{const submitted=await request(choice?'/api/synplex/executions':'/api/executions',{body,signal});if(!uuid(submitted.execution_id)||choice&&payloadHash(submitted.model_selection)!==payloadHash(payload.model_selection))fail();return {taskId:submitted.execution_id};},lookup:async({taskId})=>({taskId})};
   const submitted=await input.remoteGuard({targetKey,transport}).submitOrLookup({operationId,attemptId,packet,payload,signal});
   const record={operationId,attemptId,taskId:submitted.taskId,targetKey};save(operationId,record);
   return observe(input,record);
  },
  async cancel({operationId}){const record=active.get(operationId)||load(operationId);if(!record||record.targetKey!==targetKey)fail();await request('/api/executions/'+record.taskId+'/cancel',{body:{}});}
 };
}
