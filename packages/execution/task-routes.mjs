import {ProtocolError,payloadHash} from '../contracts/validate.mjs';
import {selectExecution} from './selection.mjs';

const fail=()=>{throw new ProtocolError('validation_failed','请为每一步选择已连接的型号和思考程度。','检查步骤数量和所选型号，不会自动换用其他型号。');};
export const planRouteFingerprint=plan=>payloadHash({id:plan.id,baseRunId:plan.baseRunId,nodes:plan.nodes.map(({id,title,instruction,acceptanceCriteria,dependsOn,sideEffect,executionHash})=>({id,title,instruction,acceptanceCriteria,dependsOn,sideEffect,executionHash:executionHash??null}))});

function assignmentsFor(plan,choices,raw){
 if(!Array.isArray(raw)||raw.length!==plan.nodes.length)fail();
 const ids=new Set();
 return raw.map(a=>{
  if(!a||Object.keys(a).sort().join(',')!=='effort,model,nodeId'||!plan.nodes.some(n=>n.id===a.nodeId)||ids.has(a.nodeId))fail();
  ids.add(a.nodeId);return {nodeId:a.nodeId,...selectExecution({model:a.model,effort:a.effort},choices,{})};
 }).sort((a,b)=>plan.nodes.findIndex(n=>n.id===a.nodeId)-plan.nodes.findIndex(n=>n.id===b.nodeId));
}
function priceReference(assignment,prices,at){
 const candidates=prices.filter(p=>p.model===assignment.model&&p.provider===assignment.provider);
 const matches=candidates.filter(p=>Date.parse(p.validFrom)<=at&&(p.validUntil===null||at<Date.parse(p.validUntil)));
 if(matches.length!==1)return {price:null,reason:matches.length?'price_conflict':candidates.length?'price_not_effective':'price_unknown'};
 const p=matches[0];return {price:{revision:p.revision,source:p.source,validFrom:p.validFrom,validUntil:p.validUntil,inputUsdPerMillion:p.inputUsdPerMillion,cachedInputUsdPerMillion:p.cachedInputUsdPerMillion,outputUsdPerMillion:p.outputUsdPerMillion},reason:'versioned_price'};
}
// Adapt the old Synplex assignment/signature comparison. Do not copy its
// cold-start latency or model-name quality heuristics into measured claims.
export function compareTaskRoutes({plan,packet,choices,prices,assignments,quotedAt}){
 if(!choices.length)throw new ProtocolError('capability_unavailable','这个工具尚未提供可选型号。','先选择可以指定型号的执行工具。');
 const defaults=packet.executionOptions??{model:choices[0].id,effort:choices[0].efforts[0]};
 const remaining={...plan,nodes:plan.nodes.filter(n=>!n.generation)};
 if(!remaining.nodes.length)throw new ProtocolError('conflict','所有步骤都已准备，当前设置已固定。','查看已有任务；不会改变已提交的要求。');
 const uniform=assignmentsFor(remaining,choices,remaining.nodes.map(n=>({nodeId:n.id,...(n.executionOptions??defaults)})));
 const variants=[{title:plan.routeSelection?'沿用当前安排':packet.executionOptions?'沿用当前选择':'统一安排',assignments:uniform}];
 if(assignments!==undefined)variants.push({title:'按步骤安排',assignments:assignmentsFor(remaining,choices,assignments)});
 const seen=new Set(),routes=[];
 for(const variant of variants){
  const signature=payloadHash(variant.assignments);if(seen.has(signature))continue;seen.add(signature);
  routes.push({...variant,id:signature,assignments:variant.assignments.map(a=>({...a,...priceReference(a,prices,Date.parse(quotedAt))})),
   estimatedUsd:null,estimatedSeconds:null,qualityStatus:'unmeasured',
   notice:'只调整尚未准备的步骤，已提交的设置和成果保持不变。这里只比较执行设置和已确认单价。总费用、完成时间及交付质量尚无足够依据；失败、返工和补充问答也会产生用量，不计为零。'});
 }
 return {routes,planFingerprint:planRouteFingerprint(plan),choicesFingerprint:payloadHash(choices),pricesFingerprint:payloadHash(prices.map(p=>p.revision)),quotedAt};
}
