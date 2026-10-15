// A deterministic reading aid. Only explicit version/evidence relationships
// join records; chronology, matching titles and tool success are not causality.
export function recordJourney({claims,revisions,reviews,outcomes,limit=100}){
 const byId=new Map(claims.map(c=>[c.id,c]));
 const card=c=>({id:c.id,title:c.title,body:c.body,type:c.type,condition:c.condition,reviewStatus:c.reviewStatus,lifecycle:c.lifecycle,recordedAt:c.recordedAt});
 const changes=revisions.filter(r=>byId.has(r.claimId)&&byId.has(r.replacementId)).map(r=>({
  id:r.id,from:card(r.before),to:card(byId.get(r.replacementId)),reason:r.reason,
  restoredFrom:r.restoredFrom??null,recordedAt:r.recordedAt,
 }));
 const explained=new Set(changes.map(r=>r.from.id+'>'+r.to.id));
 // Imported replacements may have no human-entered rationale. Keep the gap.
 for(const c of claims)for(const oldId of c.supersedes)if(byId.has(oldId)&&!explained.has(oldId+'>'+c.id)){
  changes.push({id:null,from:card(byId.get(oldId)),to:card(c),reason:null,restoredFrom:null,recordedAt:c.recordedAt});
 }
 changes.sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||a.to.id.localeCompare(b.to.id));
 const decisions=reviews.filter(r=>byId.has(r.claimId)).map(r=>({id:r.id,claimId:r.claimId,title:r.after.title,
  status:r.after.reviewStatus,priorStatus:r.before.reviewStatus,recordedAt:r.recordedAt})).reverse();
 return {method:'synplex.explicit-record-journey/1',
  current:claims.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='confirmed').map(card),
  pending:claims.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='pending').map(card),
  changes:changes.slice(0,limit),reviews:decisions.slice(0,limit),outcomes:outcomes.slice(0,limit),
  counts:{changes:changes.length,reviews:decisions.length,outcomes:outcomes.length},
  complete:changes.length<=limit&&decisions.length<=limit&&outcomes.length<=limit};
}
