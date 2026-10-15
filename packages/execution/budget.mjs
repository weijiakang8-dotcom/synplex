import {ProtocolError,payloadHash} from '../contracts/validate.mjs';
const fail=()=>{throw new TypeError('Invalid configured execution limits');};
export function validateLimits(value){
 const keys=['totalUsd','dailyUsd','reservationUsd','maximumUnknownCharges','timezone','startsAt'];
 if(!value||Object.keys(value).sort().join(',')!==keys.sort().join(',')||
  !['totalUsd','dailyUsd','reservationUsd'].every(k=>typeof value[k]==='number'&&Number.isFinite(value[k])&&value[k]>0)||
  value.reservationUsd>value.dailyUsd||value.dailyUsd>value.totalUsd||
  !Number.isSafeInteger(value.maximumUnknownCharges)||value.maximumUnknownCharges<1||
  !Number.isFinite(Date.parse(value.startsAt)))fail();
 try{new Intl.DateTimeFormat('en-CA',{timeZone:value.timezone}).format();}catch{fail();}
 return {...value,revision:payloadHash(value)};
}
export function budgetProjection(limits,holds,rows,at=new Date().toISOString()){
 if(!limits)return null;
 const day=x=>new Intl.DateTimeFormat('en-CA',{timeZone:limits.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(x));
 const currentDay=day(at),byAttempt=new Map(rows.map(r=>[r.attemptId,r]));
 let totalCommittedUsd=0,dailyCommittedUsd=0,unknownCharges=0;
 for(const h of holds){
  if(Date.parse(h.createdAt)<Date.parse(limits.startsAt))continue;
  const row=byAttempt.get(h.attemptId),cost=h.notSubmitted?0:row?.paidUsd;
  const amount=cost===null||cost===undefined?h.reservationUsd:cost;
  if(!h.notSubmitted&&row&&['succeeded','failed','cancelled','unknown'].includes(row.status)&&row.paidUsd===null)unknownCharges++;
  totalCommittedUsd+=amount;
  if(day(h.startedAt??h.createdAt)===currentDay)dailyCommittedUsd+=amount;
 }
 return {policyRevision:limits.revision,totalLimitUsd:limits.totalUsd,dailyLimitUsd:limits.dailyUsd,
  reservationUsd:limits.reservationUsd,totalCommittedUsd,dailyCommittedUsd,unknownCharges,
  maximumUnknownCharges:limits.maximumUnknownCharges,timezone:limits.timezone};
}
export function requireBudget(status,additionalHold){
 if(!status)return;
 if(status.unknownCharges>=status.maximumUnknownCharges)
  throw new ProtocolError('budget_exceeded','前面的执行费用还没核对，本次任务尚未发送。','先核对原任务账单，避免未知费用不断累积。');
 const extra=additionalHold??status.reservationUsd;
 if(status.totalCommittedUsd+extra>status.totalLimitUsd+1e-9||status.dailyCommittedUsd+extra>status.dailyLimitUsd+1e-9)
  throw new ProtocolError('budget_exceeded','已达到设置的费用额度，本次任务尚未发送。','核对已预留额度和账单，或由维护者调整额度。');
}
