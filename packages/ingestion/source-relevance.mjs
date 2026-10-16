// Provenance guides default retrieval; it never changes or deletes a source.
export const isFixtureSource=path=>/(?:^|\/)_附件\/.*\/(?:真实任务验收|合成样例|评测输入)\//.test(path);
export function sourceIdentity(occurrence={}){
 try{
  const value=JSON.parse(occurrence.sessionId);
  if(value&&typeof value==='object'&&!Array.isArray(value))return {path:typeof value.path==='string'?value.path:'',vault:typeof value.vault==='string'?value.vault:''};
 }catch{/* Ordinary session identifiers are not JSON note identities. */}
 return {path:typeof occurrence.sessionId==='string'?occurrence.sessionId:'',vault:''};
}
export function primaryTopic(occurrences){
 const groups=new Map();
 for(const item of occurrences.values()){
  const {path='',vault=''}=sourceIdentity(item),topic=path.match(/^项目\/([^/]+)\//)?.[1];
  if(!topic||/历史|快照/.test(vault))continue;
  if(!groups.has(topic))groups.set(topic,new Set());groups.get(topic).add(item.sourceId);
 }
 const ranked=[...groups].sort((a,b)=>b[1].size-a[1].size),top=ranked[0];
 return top&&top[1].size>=3&&top[1].size>ranked.reduce((n,x)=>n+x[1].size,0)/2?top[0]:null;
}
function evidenceRole({fixture,presentation,external,uncertain,historical,planned}){
 if(fixture)return '测试输入或样例产物，不是本人实际经历';
 if(presentation)return '展示材料，仅表示作者陈述';
 if(external)return '外部或通用参考';
 if(uncertain)return '来源归属待核对';
 if(planned)return '方案或验收计划，只说明目标与安排，不证明能力已经完成';
 return historical?'历史记录，状态仅代表记录当时':'项目原始记录，仍需核对结论';
}
function declaredState(preamble){
 const metadata=preamble.match(/^\s*---\s*\n([\s\S]*?)\n---(?:\s|$)/)?.[1]??'';
 return {planned:/^type:\s*["']?plan["']?\s*$/m.test(metadata),
  historical:/^status:\s*["']?(?:historical|superseded)["']?\s*$/m.test(metadata)
   ||/^(?:source_baseline|code_revision):\s*\S+/m.test(metadata)};
}
function historicalSource(vault,path,title,declared){
 return declared||/历史|快照/.test(vault)||/历史版本/.test(path)||/^(?:历史快照|历史记录)\s*[·：:-]/.test(title??'');
}
export function sourceRelevance(occurrence,title,topic,preamble=''){
 const {path,vault}=sourceIdentity(occurrence),name=path||title||'',other=name.match(/(?:^|\/)项目\/([^/]+)/)?.[1];
 const presentation=/\.pptx?$|演讲|展示材料|作品集|拿手菜|提交稿/i.test(name);
 const external=/^(?:生活|Skill|计算机知识基础|成长与职业)\//.test(path)||/市场产品对标|学术.*(?:基准|差距)/.test(name);
 const fixture=isFixtureSource(name);
 const uncertain=/原文件夹待核对|来源待核验/.test(name);
 const {planned,historical:declaredHistorical}=declaredState(preamble);
 const historical=historicalSource(vault,path,title,declaredHistorical);
 return {eligible:!fixture&&!presentation&&!external&&!uncertain&&!(topic&&other&&other!==topic),
  role:evidenceRole({fixture,presentation,external,uncertain,historical,planned}),
  priority:(topic&&other===topic?12:0)+(historical?-24:0)+(planned?-12:0),path:path||null};
}
