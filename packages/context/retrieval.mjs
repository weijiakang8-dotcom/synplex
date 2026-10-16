// Query expansion improves recall for common project questions, not their answers.
// Matching source text remains untrusted evidence and is never an instruction.
import {payloadHash} from '../contracts/validate.mjs';

export function addConversationEvidence(packet,spans,selected,reserved,estimate,limit){
 const admitted=[];let omitted=0;
 // A date header alone cannot ground a cited conclusion. Give the actual
 // quoted body first access to capacity, then attach its original metadata.
 for(const span of [...spans].sort((a,b)=>Number(preambleOnly(a.quote))-Number(preambleOnly(b.quote)))){
  if(selected.size&&!selected.has(span.occurrenceId)){omitted++;continue;}
  if(preambleOnly(span.quote)&&!packet.evidence.some(e=>e.sourceId===span.sourceId&&!preambleOnly(e.quote))){omitted++;continue;}
  if(packet.evidence.some(e=>payloadHash(e)===payloadHash(span)))continue;
  packet.evidence.push(span);
  if(estimate(packet)+reserved+2000>limit){packet.evidence.pop();omitted++;}
  else admitted.push(span);
 }
 if(admitted.length)packet.unknowns.push('已带入选定对话或前版成果当时实际引用的原文，逐条重新核对出处；模型回答与原文均不是人工确认或新授权。');
 if(omitted){packet.unknowns.push(`原对话或前版成果的${omitted}段原文因资料选择或容量未带入；这些引用尚不能作为本次依据，完整原件仍保留。`);packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';}
 return admitted;
}
const profiles=[
 [/介绍|说明文件|如何工作|产品定位|解决什么问题/,['工作台','项目经历','依据','核对','成果','双向补齐']],
 [/量化|数据|证明|指标|好用|效果|成本(?!人)|效益/,['实测','闭环','修订','下载','样本','结果','对照','成本','耗时','参考','平均','未测']],
 [/经验|模板|沉淀|卡点|复盘|转变|转向/,['经验','复盘','失败','根因','转向','回退','约束','适用','下一轮']],
 [/碰撞|火花|人与|人机|交互|讨论|协商/,['提出','纠正','改变','讨论','分歧','取舍','协作','协商','转向']],
 [/成本|费用|实付|单价|预算/,['费用','成本','参考','实付','对照','合格']]
];
export function retrievalTerms(text){
 const expanded=profiles.filter(([pattern])=>pattern.test(text)).flatMap(([,terms])=>terms.slice(0,6));
 const anchors=[...text.matchAll(/[“「《]([^”」》]{2,40})[”」》]/g)].flatMap(m=>{
  const chars=Array.from(m[1]);return [chars.slice(0,2).join(''),chars.slice(-2).join(''),...(m[1].match(/[A-Za-z][\w.-]+/g)??[])];
 });
 const tokens=[...(text.match(/[A-Za-z][\w.-]{1,40}/g)??[]),...(text.match(/[\p{Script=Han}]+/gu)??[]).flatMap(run=>{const chars=Array.from(run);return chars.slice(0,-1).map((_,i)=>chars.slice(i,i+2).join(''));})];
 const stop=new Set(['这个','项目','有没有','什么','哪些','怎么','如何','可以','我们','你们','本次','这次','是否','一个','后续','需要','用的']);
 // Spread literal terms across the whole request. A long first question must
 // not exhaust the budget and erase the second/third question's intent.
 const literal=[...new Set(tokens.map(t=>t.toLowerCase()).filter(t=>!stop.has(t)))];
 const terms=[...new Set([...anchors,...expanded].map(t=>t.toLowerCase()))].slice(0,20),room=24-terms.length;
 for(let i=0;i<room&&literal.length;i++)terms.push(literal[Math.min(literal.length-1,Math.floor(i*literal.length/room))]);
 return [...new Set(terms)].slice(0,24);
}
export function sourceReference(hit,index){return {label:'资料'+(index+1),sourceId:hit.span.sourceId,occurrenceId:hit.span.occurrenceId,blockId:hit.span.blockId,title:hit.title,path:hit.path};}

function quotedQueries(text){
 // Quoted concepts are separate retrieval intents. Nearby generic words such
 // as "任务/来源/必须" must not outvote the concept itself, and section titles
 // must not use up all slots before a later named correction is searched.
 return [...text.matchAll(/[“「《]([^”」》]{2,40})[”」》]/g)].slice(0,8).map(m=>{
  const chars=Array.from(m[1]);
  return [...new Set([m[1],...chars.slice(0,-1).map((_,i)=>chars.slice(i,i+2).join(''))])].slice(0,24);
 });
}
function causalQueries(text){
 // Search the subject of each explicit "why" question independently; generic
 // review/measurement words from other clauses must not outrank its cause.
 return text.split(/[，。；！？\n]/u).filter(s=>/为何|为什么|原因|取舍/.test(s)).slice(0,6).map(s=>{
  const literals=[...(s.match(/[A-Za-z][\w.-]{1,40}/g)??[]),...(s.match(/[\p{Script=Han}]+/gu)??[]).flatMap(run=>Array.from(run).slice(0,-1).map((_,i)=>Array.from(run).slice(i,i+2).join('')))];
  return [...new Set(literals)].slice(0,24);
 });
}
function preambleOnly(quote){return /^\s*---\s*\n[\s\S]*\n---\s*$/.test(quote)&&/^(?:type|status|created|updated):/m.test(quote);}
function nonNarrative(quote,goal){
 // Metadata is a preamble, not a topical answer. Exact original bytes remain
 // available and dated preambles are attached only after a substantive hit.
 if(preambleOnly(quote))return true;
 // Code is useful when requested, but should not displace product prose.
 return /^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*\n\1\s*$/.test(quote)
  && !/代码|命令|脚本|配置|接口|schema|sql|json|api|code|command/i.test(goal);
}
async function retrieveEvidenceHits(repo,goal,selected){
 const matched=profiles.filter(([pattern])=>pattern.test(goal));
 const queries=[...causalQueries(goal),...quotedQueries(goal),retrievalTerms(goal),...(matched.length>1?matched.map(([,terms])=>terms.slice(0,6)):[])];
 const causal=causalQueries(goal);
 const pages=await Promise.all(queries.map(async (terms,index)=>{
  const page=await repo.retrieveContext({terms,occurrenceIds:selected,limit:48});
  return index<causal.length?[...page].sort((a,b)=>Number(/因为|为了|由于|原因|权衡|因此|所以/.test(b.span.quote))-Number(/因为|为了|由于|原因|权衡|因此|所以/.test(a.span.quote))):page;
 }));
 // A compound question has several intents. Interleave their hits so that
 // many generic lessons cannot crowd out an actual delivery/measurement.
 const hits=[],seen=new Set();
 for(let i=0;i<48;i++)for(const page of pages){
  const hit=page[i];if(!hit||/^\s*#{1,6}\s+[^\n]+\s*$/.test(hit.span.quote)||nonNarrative(hit.span.quote,goal))continue;
  const key=JSON.stringify([hit.span.sourceId,hit.span.blockId,hit.span.start,hit.span.end]);
  if(seen.has(key))continue;seen.add(key);hits.push(hit);
 }
 return hits;
}
export async function addSourceEvidence(repo,packet,goal,selected,reserved,estimate,optionalLimit=packet.budget.maxInputTokens){
 if(typeof repo.retrieveContext!=='function')return [];
 const hits=await retrieveEvidenceHits(repo,goal,selected);
 const spans=[];packet.sourceReferences=[];
 for(const hit of hits){
  if(spans.length>=24)break;
  const prior=packet.evidence,reference=sourceReference(hit,packet.sourceReferences.length),added=!packet.sourceReferences.some(r=>r.sourceId===hit.span.sourceId);
  if(prior.some(e=>e.sourceId===hit.span.sourceId&&e.blockId===hit.span.blockId&&e.start===hit.span.start&&e.end===hit.span.end))continue;
  packet.evidence=[...prior,hit.span];if(added)packet.sourceReferences.push(reference);
  if(estimate(packet)+reserved+2000>optionalLimit){packet.evidence=prior;if(added)packet.sourceReferences.pop();continue;}
  spans.push(hit.span);
  const provenance=`《${hit.title}》：${hit.evidenceRole}`;
  if(hit.evidenceRole&&!packet.unknowns.includes(provenance))packet.unknowns.push(provenance);
 }
 // Attach dates only after a real passage from that source has fitted. This
 // prevents a small YAML header from consuming the last slot while its body
 // is omitted, which used to advertise a source without its actual evidence.
 await addPreambles(repo,packet,spans,reserved,estimate,optionalLimit);
 if(spans.length)packet.unknowns.push('来源摘录是原始资料，不是人工确认事实；引用资料标题和段落，区分历史、外部材料、计划与实测结果，不把收藏内容说成本人的经历。来源标题须逐字取自sourceReferences，可附资料编号；正文提及的双链、模板或文件名不是本次已核对的来源，不可冒充来源标题。展示稿或计划中的能力陈述不能证明实测通过，数字必须有对应执行记录和验收范围。默认不带入展示、外部及其他项目资料，需要时可明确选择；历史状态只代表记录当时，不以导入时间推断事实新旧。原文件头部的日期只说明原记录标注日期，不自动证明每个事件发生日期。将个案整理成经验时须保留触发条件和边界，不能把“应先判断”改成“一律默认”，也不能把一次结果扩大为所有项目都适用的规则。');
 return spans;
}

async function addPreambles(repo,packet,spans,reserved,estimate,limit){
 if(typeof repo.sourcePreambles!=='function'||!spans.length)return;
 const first=[...new Map(spans.map(span=>[span.occurrenceId,span])).values()].slice(0,24);
 for(const span of await repo.sourcePreambles(first)){
  if(packet.evidence.some(e=>payloadHash(e)===payloadHash(span)))continue;
  packet.evidence.push(span);
  if(estimate(packet)+reserved+2000>limit)packet.evidence.pop();
  else spans.push(span);
 }
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
