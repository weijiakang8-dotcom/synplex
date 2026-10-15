import {ProtocolError,payloadHash} from '../contracts/validate.mjs';

const fail=message=>{throw new ProtocolError('validation_failed',message,'检查步骤、前置步骤和交付要求后再保存。');};
const text=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail(`${label}不完整或过长。`);return value.trim();};
const list=(value,label)=>{if(!Array.isArray(value)||!value.length||value.length>20)fail(`${label}不能为空。`);return value.map(x=>text(x,4000,label));};

// Adapt the old Synplex dependency validation, without importing its storage or
// executor state machine. Stored runs/results remain the sole execution truth.
export function validateTaskPlan(input){
 if(!input||Object.keys(input).sort().join(',')!=='nodes,title'||!Array.isArray(input.nodes)||!input.nodes.length||input.nodes.length>12)fail('安排需要一到十二个步骤。');
 const title=text(input.title,100,'安排名称'),ids=new Set();
 const nodes=input.nodes.map(n=>{
  if(!n||Object.keys(n).sort().join(',')!=='acceptanceCriteria,dependsOn,id,instruction,sideEffect,title')fail('步骤内容不完整。');
  if(typeof n.id!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(n.id)||ids.has(n.id))fail('步骤编号重复或无效。');ids.add(n.id);
  if(!Array.isArray(n.dependsOn)||n.dependsOn.length>12||n.dependsOn.some(x=>typeof x!=='string')||new Set(n.dependsOn).size!==n.dependsOn.length||!['read_only','isolated_files'].includes(n.sideEffect))fail('前置步骤或操作范围不正确。');
  return {id:n.id,title:text(n.title,100,'步骤名称'),instruction:text(n.instruction,8000,'步骤要求'),acceptanceCriteria:list(n.acceptanceCriteria,'交付要求'),dependsOn:[...n.dependsOn],sideEffect:n.sideEffect};
 });
 const ordered=[],seen=new Set(),visiting=new Set(),byId=new Map(nodes.map(n=>[n.id,n]));
 const visit=id=>{if(visiting.has(id))fail('步骤之间不能互相等待。');if(seen.has(id))return;const n=byId.get(id);if(!n)fail('前置步骤不存在。');visiting.add(id);n.dependsOn.forEach(visit);visiting.delete(id);seen.add(id);ordered.push(n);};
 nodes.forEach(n=>visit(n.id));return {title,nodes:ordered};
}

function nodeExecutionOptions(run,assigned,lookup){
 if(run)return lookup(run);
 return assigned?{model:assigned.model,effort:assigned.effort}:null;
}

function selectedStep(history,selections,planId,nodeId){
 const chosen=selections.findLast(x=>x.planId===planId&&x.nodeId===nodeId),selection=chosen?.generation===history.length?chosen:null;
 return {selection,link:selection?{...history.at(-1),runId:selection.runId,selectedResultId:selection.resultId,inputRefs:selection.inputRefs}:history.at(-1)};
}
function stepReview(result,reviews,selection){
 const review=result&&reviews.filter(x=>x.resultId===result.id).at(-1);
 return selection&&review?.id===selection.priorReviewId?null:review;
}
function resultStepStatus(run,attempt,review){
 const unsuccessful=run?.mode!=='host_assist'&&['failed','cancelled'].includes(attempt?.status)?attempt.status:null;
 return review?.status??unsuccessful??'awaiting_review';
}

export function projectTaskPlan(plan,{links,runs,attempts,results,reviews,operations,selections=[],executionOptionsForRun}){
 const projection=[],states=new Map();
 for(const node of plan.nodes){
  const history=links.filter(x=>x.planId===plan.id&&x.nodeId===node.id),{link,selection}=selectedStep(history,selections,plan.id,node.id),run=link&&runs.find(x=>x.id===link.runId);
  const attempt=run&&attempts.find(x=>x.id===run.attemptIds.at(-1)),result=link?.selectedResultId?results.find(x=>x.id===link.selectedResultId):attempt&&results.find(x=>x.id===attempt.resultRevisionIds.at(-1));
  const review=stepReview(result,reviews,selection),op=run&&operations.findLast(x=>x.kind==='execute_task'&&links.some(l=>l.runId===run.id)&&x.resultId===result?.id);
  const dependencies=node.dependsOn.map(id=>states.get(id));
  const inputRefs=dependencies.filter(x=>x?.status==='passed').map(x=>({nodeId:x.id,resultId:x.resultId,resultHash:x.resultHash}));
  const blocked=dependencies.some(x=>x?.status!=='passed');
  const stale=!!link&&payloadHash(link.inputRefs)!==payloadHash(inputRefs);
  let status=!link?'ready':run?.status??'unknown';
  // A failed engine may still have saved files. Keep execution failure visible
  // until the user explicitly accepts/rejects those files; their existence alone
  // is not a successful delivery or a reason to hide the retry path.
  if(result)status=resultStepStatus(run,attempt,review);
  if(attempt&&['queued','running','unknown'].includes(attempt.status)&&run?.mode!=='host_assist')status=attempt.status;
  if(blocked&&!['queued','running','unknown'].includes(status))status='blocked_dependency';
  else if(stale&&!['queued','running','unknown'].includes(status))status='stale_input';
  const assigned=plan.routeSelection?.assignments.find(a=>a.nodeId===node.id);
  const state={...node,status,executionOptions:nodeExecutionOptions(run,assigned,executionOptionsForRun),runId:run?.id??null,resultId:result?.id??null,resultHash:result?.payloadHash??null,
   generation:history.length,inputRefs,review:review??null,resultSelection:selection,history,operationId:op?.id??null};
  state.executionHash=payloadHash({planId:plan.id,baseRunId:plan.baseRunId,...state});
  states.set(node.id,state);projection.push(state);
 }
 return {...plan,nodes:projection,complete:projection.every(x=>x.status==='passed')};
}

// One explicit start advances one eligible node. Reviews never dispatch work.
// Ambiguous/in-flight work is reconciled before any other node in this plan.
export function startableTaskSteps(plan){
 if(plan.nodes.some(n=>['queued','running','unknown'].includes(n.status)))return [];
 return plan.nodes.filter(n=>['ready','prepared','stale_input','failed','cancelled','needs_revision'].includes(n.status));
}
export function nextTaskStep(plan){return startableTaskSteps(plan)[0]??null;}

export function requireReadyStep(plan,nodeId,{revision=false}={}){
 const node=plan.nodes.find(x=>x.id===nodeId);if(!node)fail('这一步不存在。');
 if(['queued','running','unknown'].includes(node.status))throw new ProtocolError('conflict','这一步仍在执行或结果待核对。','先查看原执行结果，不重新开始。','lookup_operation');
 if(node.status==='blocked_dependency')throw new ProtocolError('conflict','前面的成果还未确认。','先检查前一步的成果，再继续这一步。');
 if(!revision&&['passed','prepared','awaiting_review'].includes(node.status))throw new ProtocolError('conflict','这一步已有说明或成果。','查看已有说明；需要修改时使用修改入口。','lookup_operation');
 if(revision&&!node.resultId)fail('修改需要一份已有成果。');
 return node;
}
