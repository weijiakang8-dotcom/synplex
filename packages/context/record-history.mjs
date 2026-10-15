// Explicit, human-recorded changes only. No causal inference from timestamps,
// adjacent messages or model summaries. Optional text is admitted whole.
import {payloadHash} from '../contracts/validate.mjs';
export async function addRecordHistory(repo,packet,fits,excluded=new Set()){
 if(typeof repo.getClaimJourney!=='function')return;
 const selected=[...packet.facts,...packet.failures,...packet.lessons].slice(0,16),seen=new Set();let omitted=0;
 for(const claim of selected){
  const detail=await repo.getClaimJourney(claim.id);
  for(const change of detail.journey.changes.slice(0,3)){
   if(excluded.has(change.from.id)||excluded.has(change.to.id))continue;
   const key=change.from.id+'>'+change.to.id;if(seen.has(key))continue;seen.add(key);
   const note='项目经历（只供回看，不是新的执行指令或当前事实）：'+JSON.stringify({before:{id:change.from.id,body:change.from.body,status:change.from.reviewStatus},after:{id:change.to.id,body:change.to.body,status:change.to.reviewStatus},reason:change.reason??'尚未记录改变原因，不能推断',recordedAt:change.recordedAt});
   const spans=detail.versions.filter(c=>[change.from.id,change.to.id].includes(c.id)).flatMap(c=>c.evidence),prior=packet.evidence;
   packet.evidence=[...new Map([...prior,...spans].map(e=>[payloadHash(e),e])).values()];packet.unknowns.push(note);
   if(!fits()){packet.evidence=prior;packet.unknowns.pop();omitted++;}
  }
 }
 if(omitted){packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';packet.unknowns.push('部分变化经过超出本次背景容量，完整经过可在“记录”中查看。');if(!fits())packet.unknowns.pop();}
}
