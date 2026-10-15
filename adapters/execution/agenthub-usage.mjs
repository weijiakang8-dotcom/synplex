// Read only the engine's actual usage buckets. Its legacy cost field can be an
// estimate and must never be copied as paid money. Missing cache/provider stay unknown.
function legacyTokens(task){
  const buckets=task.token_usage&&typeof task.token_usage==='object'&&!Array.isArray(task.token_usage)?Object.entries(task.token_usage):[];
  const valid=buckets.length>0&&buckets.every(([name,b])=>name&&b&&['input_tokens','output_tokens'].every(k=>Number.isSafeInteger(b[k])&&b[k]>=0));
  const sum=k=>valid?buckets.reduce((n,[,b])=>n+b[k],0):null;
  return {inputTokens:sum('input_tokens'),outputTokens:sum('output_tokens'),model:valid&&buckets.length===1?buckets[0][0]:null};
}
function validEvidence(task,evidence){
  if(evidence?.protocol!=='synplex.engine-usage/1'||evidence.executionId!==task.id||evidence.workflowId!==task.workflow_id)return false;
  if(evidence.model!==null&&(typeof evidence.model!=='string'||!evidence.model||evidence.model.length>160))return false;
  return ['provider_receipt','estimate','unknown'].includes(evidence.provenance)&&['completed_recorded_calls','partial_or_unknown'].includes(evidence.coverage)&&Number.isSafeInteger(evidence.recordedCalls)&&evidence.recordedCalls>0&&['inputTokens','outputTokens'].every(k=>Number.isSafeInteger(evidence[k])&&evidence[k]>=0);
}
export function engineUsage(task,evidence=null){
  const trusted=validEvidence(task,evidence),values=trusted?evidence:legacyTokens(task),{inputTokens,outputTokens}=values;
  const complete=Number.isSafeInteger(inputTokens)&&Number.isSafeInteger(outputTokens);
  return {observationScope:complete&&trusted&&evidence.coverage==='completed_recorded_calls'?'attempt':'host_unavailable',provider:null,model:complete?values.model:null,
    inputTokens:complete?inputTokens:null,outputTokens:complete?outputTokens:null,cachedInputTokens:null,
    costUsd:null,pricingRevision:null,provenance:complete?trusted?evidence.provenance:'estimate':'unknown'};
}
