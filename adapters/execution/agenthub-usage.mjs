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

export function engineChecks(task,evidence){
 const review=evidence?.verification,recordedAt=review?.recordedAt;
 const scoped=evidence?.protocol==='synplex.engine-usage/1'&&evidence.executionId===task.id&&evidence.workflowId===task.workflow_id&&review?.executionId===task.id&&review.workflowId===task.workflow_id;
 const checks=review?.checks,valid=scoped&&['PASS','FAIL'].includes(review.status)&&Array.isArray(checks)&&checks.length>0&&checks.length<=12&&checks.every(c=>c&&['PASS','FAIL'].includes(c.status)&&['criterion','reason'].every(k=>typeof c[k]==='string'&&c[k].length>0&&Array.from(c[k]).length<=200));
 const dated=typeof recordedAt==='string'&&Number.isFinite(Date.parse(recordedAt));
 const consistent=valid&&dated&&(review.status==='PASS')===checks.every(c=>c.status==='PASS');
 const common={method:'自动核对正文与要求',artifactIds:[],performedBy:'synplex-agenthub:semantic-verifier',recordedAt:dated?new Date(recordedAt).toISOString():new Date().toISOString()};
 if(!consistent)return [{...common,id:'agenthub:'+task.id+':verification',status:'unknown',evidence:'尚无有效的自动核对结论。文件和原执行记录已保存，请逐项检查成果；这不代表人工验收通过。'}];
 return checks.map((c,i)=>({...common,id:'agenthub:'+task.id+':verification:'+i,status:c.status==='PASS'?'passed':'failed',evidence:c.criterion+'：'+c.reason}));
}
