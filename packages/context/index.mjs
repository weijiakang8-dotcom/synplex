import {addRecordHistory} from './record-history.mjs';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, ProtocolError, validatePrepare, validateWire, payloadHash } from '../contracts/validate.mjs';
import { occurrences, evidencePages, checkSnapshot, sameScope } from './repository-read.mjs';

const fail=(code,message,nextAction)=>{throw new ProtocolError(code,message,nextAction);};
const unique=items=>[...new Map(items.map(item=>[payloadHash(item),item])).values()];
const words=text=>[...new Set([
  ...(text.match(/[A-Za-z][\w.-]{1,40}/g)??[]),
  ...(text.match(/[\p{Script=Han}]+/gu)??[]).flatMap(run=>Array.from(run).slice(0,-1).map((_,i)=>Array.from(run).slice(i,i+2).join('')))
].map(x=>x.toLowerCase()))].slice(0,64);
// Conservative upper bound, not a provider tokenizer or observed model usage.
export function estimatePacketTokens(packet) {
  const {contentHash,budget,...content}=packet;
  return Buffer.byteLength(JSON.stringify({...content,budget:{...budget,estimatedTokens:1000000}}),'utf8')+128;
}

function optionalInputs(options){return {...(options.taskInputs?.length?{taskInputs:options.taskInputs}:{}),...(options.chatReference?{chatReference:options.chatReference}:{})};}

export async function prepareContext(repo,input,options) {
  validatePrepare(input);input=structuredClone(input);options=structuredClone(options);
  if(!sameScope(repo.scope,input.scope)||!Number.isSafeInteger(options?.reservedTokens)||options.reservedTokens<0||
      options.estimatorVersion!=='utf8-bytes-conservative/1')fail('validation_failed','项目范围或背景预算无效。','使用当前项目与支持的预算配置。');
  const state=await repo.getState();
  if(state.stateRevision!==input.expectedStateRevision)fail('stale_context','项目已更新。','读取最新进展后重新准备。');
  const all=await occurrences(repo,state),selected=new Set(input.selectedOccurrenceIds);
  if([...selected].some(id=>!all.some(o=>o.id===id)))fail('scope_denied','选中的资料不属于当前项目。','重新选择当前项目的资料。');
  const inScope=claim=>!selected.size||claim.evidence.some(e=>selected.has(e.occurrenceId));
  const terms=words([input.goal,...input.constraints,...input.acceptanceCriteria].join(' '));
  const conflicts=typeof repo.taskConflicts==='function'?await repo.taskConflicts(input.selectedOccurrenceIds):state.conflicts;
  const score=c=>terms.reduce((n,term)=>n+((c.body+' '+(c.condition??'')).toLowerCase().includes(term)?1:0),0);
  // Explicit selections take precedence for ordinary facts. Decisions and known failures remain mandatory:
  // lexical relevance cannot silently discard a human choice or a safety boundary.
  const boundary=c=>/(?:不得|禁止|不能|不允许|必须|务必|仅允许|\bnever\b|\bmust\b|\bdo not\b)/i.test(c.body+' '+(c.condition??''));
  const relevant=c=>boundary(c)||inScope(c)&&(selected.size||!terms.length||score(c)>0);
  const excluded=[...state.facts,...state.lessons].filter(c=>inScope(c)&&!relevant(c)).length;
  const packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope:structuredClone(repo.scope),stateRevision:state.stateRevision,
    permissionRevision:state.permissionRevision,goal:input.goal,constraints:input.constraints,acceptanceCriteria:input.acceptanceCriteria,
    facts:[...state.facts.filter(relevant),...state.decisions],failures:[...state.failures],lessons:state.lessons.filter(relevant),
    candidates:[],conflicts:[...conflicts],unknowns:[],evidence:[],selectedOccurrenceIds:input.selectedOccurrenceIds,
    ...(input.executionOptions?{executionOptions:input.executionOptions}:{}),
    ...optionalInputs(options),
    coverage:conflicts.length?'needs_input':'complete',budget:{maxInputTokens:input.maxInputTokens,reservedTokens:options.reservedTokens,
      estimatedTokens:0,estimatorVersion:options.estimatorVersion},createdAt:new Date().toISOString()};
  packet.evidence=unique([...packet.facts,...packet.failures,...packet.lessons].flatMap(c=>c.evidence));
  const fits=()=>estimatePacketTokens(packet)+options.reservedTokens<=input.maxInputTokens;
  if(!fits())fail('budget_exceeded','完整目标、验收及已确认背景超过这次预算。','缩小选中的资料范围或增加背景预算，原要求没有被截断。');
  if(excluded){packet.unknowns.push(`已按这次目标筛选背景，${excluded}条未匹配的确认信息或经验未加入；原记录未删除。关键词筛选可能漏掉相关内容，可手动选择资料。`);packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';}
  const unmatched=state.pending.filter(c=>inScope(c)&&!relevant(c)).length;
  if(unmatched){packet.unknowns.push(`${unmatched}条未匹配的待核对记录未加入，仍保留在资料和历史中。`);packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';}
  const candidates=state.pending.filter(relevant).sort((a,b)=>{
    return score(b)-score(a)||a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id);
  });
  // Reserve room for explicit coverage notices before considering optional material.
  if(candidates.length)packet.unknowns.push('待核对内容仅为原文线索，不代表已确认事实或执行授权。');
  let omitted=0;
  for(const candidate of candidates){
    const prior=packet.evidence;packet.candidates.push(candidate);packet.evidence=unique([...prior,...candidate.evidence]);
    if(!fits()){packet.candidates.pop();packet.evidence=prior;omitted++;}
  }
  // Historical evidence preserves rejected/obsolete decisions without making them current facts.
  let historical=0,limited=false;const historicalSpans=[];
  for(const query of terms.slice(0,8)){
    const page=await evidencePages(repo,{query,includeHistory:true,occurrenceIds:selected.size?[...selected]:null},state,100);
    limited ||= page.partial;
    for(const hit of page.items){
      if(hit.claim?.reviewStatus==='rejected'||hit.claim?.lifecycle!=='active'&&hit.claim){
        const note=`历史线索 ${hit.claim.id}：${hit.claim.reviewStatus}/${hit.claim.lifecycle}，不能当作当前结论。`;
        const prior=packet.evidence;packet.evidence=unique([...prior,hit.span]);
        const added=!packet.unknowns.includes(note);if(added)packet.unknowns.push(note);
        if(!fits()){packet.evidence=prior;if(added)packet.unknowns.pop();limited=true;}else{historical++;historicalSpans.push(hit.span);}
      }
    }
  }
  if(omitted||limited){packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';
    packet.unknowns.push(`背景按预算选取；${omitted}条待核对内容未加入，历史检索${limited?'达到上限':'按关键词进行'}。完整原件仍保留，可选定资料或增加预算。`);}
  if(all.length&&!historical){packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';
    packet.unknowns.push('历史检索按有限关键词进行，不保证找齐所有转折；没有依据的部分需继续核对。');}
  // Coverage notices are necessary too. A nearly full packet must shed optional
  // candidates whole before rejecting a goal that actually fits on its own.
  if(!fits()&&packet.candidates.length){
    packet.unknowns.push('为保留完整要求和缺口说明，部分可选待核对内容未加入，原件仍可查询。');
    packet.coverage=packet.coverage==='needs_input'?'needs_input':'partial';
    while(!fits()&&packet.candidates.length){
      packet.candidates.pop();
      packet.evidence=unique([...packet.facts,...packet.failures,...packet.lessons,...packet.candidates].flatMap(c=>c.evidence).concat(historicalSpans));
    }
  }
  if(options.includeRecordHistory!==false)await addRecordHistory(repo,packet,fits);
  packet.budget.estimatedTokens=estimatePacketTokens(packet);
  if(!fits())fail('budget_exceeded','必要背景和缺口说明超过预算。','缩小资料范围或增加背景预算，完整目标与验收仍保留。');
  checkSnapshot(await repo.getState(),state);
  packet.contentHash=payloadHash(packet);
  return validateWire('ContextPacket',packet);
}
