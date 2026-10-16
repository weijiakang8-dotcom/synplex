// Query expansion improves recall for common project questions, not their answers.
// Matching source text remains untrusted evidence and is never an instruction.
const profiles=[
 [/量化|数据|证明|指标|好用|效果|成本(?!人)|效益/,['实测','对照','合格','参考','结果','成本','耗时','样本','平均','未测']],
 [/经验|模板|沉淀|卡点|复盘|转变|转向/,['经验','复盘','失败','根因','转向','回退','约束','适用','下一轮']],
 [/碰撞|火花|人与|人机|交互|讨论|协商/,['协作','协商','分歧','取舍','纠正','人机','本人','提出','转向']]
];
export function retrievalTerms(text){
 const expanded=profiles.filter(([pattern])=>pattern.test(text)).flatMap(([,terms])=>terms);
 const tokens=[...(text.match(/[A-Za-z][\w.-]{1,40}/g)??[]),...(text.match(/[\p{Script=Han}]+/gu)??[]).flatMap(run=>{const chars=Array.from(run);return chars.slice(0,-1).map((_,i)=>chars.slice(i,i+2).join(''));})];
 const stop=new Set(['这个','项目','有没有','什么','哪些','怎么','如何','可以','我们','你们','本次','这次','是否','一个','后续','需要','用的']);
 return [...new Set([...expanded,...tokens].map(t=>t.toLowerCase()).filter(t=>!stop.has(t)))].slice(0,24);
}
export function sourceReference(hit,index){return {label:'资料'+(index+1),sourceId:hit.span.sourceId,occurrenceId:hit.span.occurrenceId,blockId:hit.span.blockId,title:hit.title,path:hit.path};}

export async function addSourceEvidence(repo,packet,goal,selected,reserved,estimate){
 if(typeof repo.retrieveContext!=='function')return [];
 const hits=await repo.retrieveContext({terms:retrievalTerms(goal),occurrenceIds:selected,limit:48});
 const groups=new Map();for(const hit of hits){if(!groups.has(hit.span.sourceId))groups.set(hit.span.sourceId,[]);groups.get(hit.span.sourceId).push(hit);}
 const order=[];for(let i=0;i<6;i++)for(const group of [...groups.values()].slice(0,6))if(group[i])order.push(group[i]);
 const spans=[];packet.sourceReferences=[];
 for(const hit of order){
  if(spans.length>=24)break;
  const prior=packet.evidence,reference=sourceReference(hit,packet.sourceReferences.length),added=!packet.sourceReferences.some(r=>r.sourceId===hit.span.sourceId);
  if(prior.some(e=>e.sourceId===hit.span.sourceId&&e.blockId===hit.span.blockId&&e.start===hit.span.start&&e.end===hit.span.end))continue;
  packet.evidence=[...prior,hit.span];if(added)packet.sourceReferences.push(reference);
  if(estimate(packet)+reserved+2000>packet.budget.maxInputTokens){packet.evidence=prior;if(added)packet.sourceReferences.pop();continue;}
  spans.push(hit.span);
 }
 if(spans.length)packet.unknowns.push('来源摘录是原始资料，不是人工确认事实；引用资料标题和段落，区分历史、外部材料、计划与实测结果，不把收藏内容说成本人的经历。');
 return spans;
}

export async function completeReferenceIndex(repo,packet,fits){
 if(typeof repo.sourceDescriptions!=='function')return;
 const known=new Set((packet.sourceReferences??[]).map(r=>r.sourceId));
 const missing=[...new Set(packet.evidence.map(e=>e.sourceId))].filter(id=>!known.has(id)).slice(0,24-known.size);
 for(const d of await repo.sourceDescriptions(missing)){
  const span=packet.evidence.find(e=>e.sourceId===d.sourceId);packet.sourceReferences??=[];
  packet.sourceReferences.push(sourceReference({...d,span},packet.sourceReferences.length));if(!fits())packet.sourceReferences.pop();
 }
}
