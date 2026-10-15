// Planning assumptions are displayed, never represented as a provider quote,
// measured latency, quality score, invoice or enforceable spending limit.
export function routeEstimate(assignments,choices,packet,plan){
 const rows=assignments.map(a=>{
  const choice=choices.find(c=>c.id===a.model),limits=choice?.estimateLimits;
  if(!a.price||!limits)return null;
  const {contextWindow,maxOutputTokens,maxCalls}=limits;
  if(![contextWindow,maxOutputTokens,maxCalls].every(n=>Number.isSafeInteger(n)&&n>0)||maxOutputTokens>=contextWindow)return null;
  const node=plan.nodes.find(n=>n.id===a.nodeId),inputBytes=Buffer.byteLength(JSON.stringify({packet,node}));
  // Tool definitions, runtime instructions, dependency files and subsequent
  // rounds are not known here. Keep their absence explicit in the UI.
  const reference=(Math.min(inputBytes,contextWindow-maxOutputTokens)*a.price.inputUsdPerMillion+maxOutputTokens*a.price.outputUsdPerMillion)/1e6;
  const envelope=maxCalls*((contextWindow-maxOutputTokens)*Math.max(a.price.inputUsdPerMillion,a.price.cachedInputUsdPerMillion)+maxOutputTokens*a.price.outputUsdPerMillion)/1e6;
  return {reference,envelope};
 });
 if(!rows.length||rows.some(r=>r===null))return null;
 return {singleCallReferenceUsd:rows.reduce((n,r)=>n+r.reference,0),planningEnvelopeUsd:rows.reduce((n,r)=>n+r.envelope,0),basis:'utf8-bytes-no-cache/1',notice:'参考值按每步一次请求、当前文字容量和回复上限计算；未包含工具说明、前置文件和后续交互。规划范围按每步最多24次、每次填满资料容量计算。实际调用轮次、缓存、失败和返工会改变费用；这不是账单或消费上限。'};
}
