import {ProtocolError,validateWire} from '../../packages/contracts/validate.mjs';
const invalid=()=>{throw new ProtocolError('validation_failed','请检查名称、分类和填写内容。','原文件不会改变，请填写完整后再保存。');};
const text=(value,max,empty=false)=>{if(typeof value!=='string'||value.length>max||!empty&&!value.trim())invalid();return value.trim();};
export function sourceMetadata(value){
 if(!value||Object.keys(value).sort().join(',')!=='category,locked,tags,title'||typeof value.locked!=='boolean'||!Array.isArray(value.tags)||value.tags.length>20)invalid();
 const category=text(value.category,240,true),parts=category.split('/');if(category&&(parts.length>6||parts.some(p=>!p.trim()||p.length>40)))invalid();
 return {title:text(value.title,160),category:category?parts.map(x=>x.trim()).join('/'):'',tags:[...new Set(value.tags.map(x=>text(x,40)))],locked:value.locked};
}
export function claimDraft(value){
 if(!value||Object.keys(value).sort().join(',')!=='body,condition,title,type')invalid();
 validateWire('CandidateInput',{...value,evidenceKind:'user_statement',evidence:[],supersedes:[],occurredAt:null});
 if(!value.title.trim()||!value.body.trim()||value.type==='lesson'&&!value.condition?.trim())invalid();
 return {...value,title:value.title.trim(),body:value.body.trim(),condition:value.condition?.trim()??null};
}

// Version links describe the same author-reviewed subject. Do not infer a
// relationship from matching titles, wording or timestamps.
export function claimVersions(focusId,claims,revisions,limit=200){
 const byId=new Map(claims.map(c=>[c.id,c])),edges=new Map();
 const link=(a,b)=>{if(!byId.has(a)||!byId.has(b))return;for(const [x,y] of [[a,b],[b,a]]){if(!edges.has(x))edges.set(x,new Set());edges.get(x).add(y);}};
 for(const c of claims)for(const id of c.supersedes)link(c.id,id);
 for(const r of revisions)if(r.replacementId)link(r.claimId,r.replacementId);
 const connected=new Set([focusId]),queue=[focusId];for(let i=0;i<queue.length;i++)for(const id of edges.get(queue[i])??[])if(!connected.has(id)){connected.add(id);queue.push(id);}
 const all=queue.map(id=>byId.get(id)).filter(Boolean),current=all.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='confirmed');
 const sorted=all.slice().sort((a,b)=>b.recordedAt.localeCompare(a.recordedAt)||b.id.localeCompare(a.id));
 return {versions:[...new Map([...current,byId.get(focusId),...sorted].filter(Boolean).map(c=>[c.id,c])).values()].slice(0,limit),current,total:all.length,complete:all.length<=limit,connected};
}
export function claimDifference(before,after){
 return ['title','type','body','condition'].filter(field=>before[field]!==after[field]).map(field=>({field,before:before[field],after:after[field]}));
}
