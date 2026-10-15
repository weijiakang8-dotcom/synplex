import {ProtocolError,validateUsage,payloadHash} from '../contracts/validate.mjs';

const fail=()=>{throw new ProtocolError('validation_failed','费用记录不完整或格式不正确。','填写真实账单金额与出处；不知道的金额留作未知。');};
export function validatePrice(price){
  const keys=['provider','model','validFrom','validUntil','inputUsdPerMillion','cachedInputUsdPerMillion','outputUsdPerMillion','source'];
  if(!price||Object.keys(price).sort().join(',')!==keys.sort().join(',')||
    !['provider','model','source'].every(k=>typeof price[k]==='string'&&price[k].trim()&&price[k].length<=512)||
    !Number.isFinite(Date.parse(price.validFrom))||price.validUntil!==null&&(!Number.isFinite(Date.parse(price.validUntil))||Date.parse(price.validUntil)<=Date.parse(price.validFrom))||
    !['inputUsdPerMillion','cachedInputUsdPerMillion','outputUsdPerMillion'].every(k=>typeof price[k]==='number'&&Number.isFinite(price[k])&&price[k]>=0))fail();
  return {...price,revision:payloadHash(price)};
}
export function priceUsage(usage,prices,occurredAt){
  validateUsage(usage);
  if(usage.provenance==='no_model_call')return {usd:0,pricingRevision:null,reason:'no_model_call'};
  if(usage.observationScope!=='attempt'||![usage.inputTokens,usage.outputTokens,usage.cachedInputTokens].every(Number.isSafeInteger)||usage.cachedInputTokens>usage.inputTokens)
    return {usd:null,pricingRevision:null,reason:'usage_unknown'};
  const at=Date.parse(occurredAt),matches=prices.filter(p=>p.provider===usage.provider&&p.model===usage.model&&at>=Date.parse(p.validFrom)&&(p.validUntil===null||at<Date.parse(p.validUntil)));
  // An overlap is a configuration conflict, not permission to pick a convenient rate.
  if(matches.length!==1)return {usd:null,pricingRevision:null,reason:matches.length?'price_conflict':'price_unknown'};
  const p=matches[0],usd=((usage.inputTokens-usage.cachedInputTokens)*p.inputUsdPerMillion+usage.cachedInputTokens*p.cachedInputUsdPerMillion+usage.outputTokens*p.outputUsdPerMillion)/1e6;
  return {usd,pricingRevision:p.revision,reason:'priced_usage'};
}
export function usageLedger({attempts,results,reconciliations=[],prices=[],modelCallCosts={}}){
  const byAttempt=new Map();
  for(const r of results){const list=byAttempt.get(r.attemptId)||[];list.push(r);byAttempt.set(r.attemptId,list);}
  const replaced=new Set(reconciliations.map(r=>r.supersedesId).filter(Boolean));
  const rows=attempts.map(a=>{
    const observations=byAttempt.get(a.id)||[],last=observations.at(-1);
    // One receipt per attempt; revision/cumulative snapshots are never summed as new calls.
    const usage=last?.usage??a.usage;
    const priced=modelCallCosts[a.id]??priceUsage(usage,prices,a.createdAt);
    const invoices=reconciliations.filter(x=>x.attemptId===a.id&&!replaced.has(x.id));
    const invoice=invoices.length===1?invoices[0]:null;
    const reported=usage.provenance==='invoice'&&usage.observationScope==='attempt'?usage.costUsd:usage.provenance==='no_model_call'?0:null;
    return {attemptId:a.id,runId:a.runId,status:a.status,createdAt:a.createdAt,usage,observations:observations.map(r=>r.id),
      estimatedUsd:usage.provenance==='estimate'?usage.costUsd:null,calculatedUsd:priced.usd,pricingRevision:priced.pricingRevision,
      paidUsd:invoice?.costUsd??reported,paidSource:invoice?'user_invoice':reported!==null?'reported_invoice':null,
      invoiceId:invoice?.id??null,receiptReference:invoice?.receiptReference??null,reason:priced.reason};
  });
  const total=key=>rows.every(r=>r[key]!==null)?rows.reduce((n,r)=>n+r[key],0):null;
  return {rows,totals:{paidUsd:total('paidUsd'),calculatedUsd:total('calculatedUsd'),knownPaidUsd:rows.reduce((n,r)=>n+(r.paidUsd??0),0),unknownPaidCount:rows.filter(r=>r.paidUsd===null).length},priceRevisions:prices.map(p=>p.revision)};
}
