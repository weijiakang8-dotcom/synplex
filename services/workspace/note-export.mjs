import {ProtocolError,payloadHash,sha256} from '../../packages/contracts/validate.mjs';

const types={fact:'事实',decision:'决定',failure:'遇到的问题',lesson:'经验',unknown:'待确认的信息'};
const literal=value=>String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/([\\`*_{}\[\]()#!|])/g,'\\$1');
const fence=value=>{const text=String(value??''),ticks='`'.repeat(Math.max(3,...[...text.matchAll(/`+/g)].map(m=>m[0].length+1)));return `${ticks}text\n${text}\n${ticks}`;};
const filename=title=>(title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').replace(/^\.+/,'').trim().slice(0,80)||'项目记录')+'.md';

// Read-only projection, adapted from Weave's confirmed-note Markdown export.
// Never synchronize a vault or execute embedded links/HTML from source text.
export function previewNoteExport(detail,scope){
 const {claim,current,journey,sources,sourceRefs=[]}=detail;
 if(claim.reviewStatus!=='confirmed'||claim.lifecycle!=='active'||current.length!==1||current[0].id!==claim.id)
  throw new ProtocolError('conflict','只能保存当前已确认的记录。','先处理待核对内容，再打开当前记录。');
 if(!detail.complete||!journey.complete||journey.pending.length)
  throw new ProtocolError('conflict','还有待核对的修改，或版本过多需要先整理。','先核对当前版本；原记录和文件仍保留。');
 const selectionHash=payloadHash({scope,claim,sources,sourceRefs,journey});
 const entries={title:claim.title,type:'synplex-project-note',project:scope.projectId,record:claim.id,recorded:claim.recordedAt,occurred:claim.occurredAt,review:'confirmed',selection:selectionHash};
 const head=['---',...Object.entries(entries).map(([key,value])=>`${key}: ${JSON.stringify(value)}`),'---'];
 const lines=[...head,'',`# ${literal(claim.title)}`,'',`记录类型：${types[claim.type]}。这是保存时已确认的一版；后续修改或撤回不会自动更新这份文件。`,'',
  '## 内容','',fence(claim.body),''];
 if(claim.condition)lines.push('## 适用情况','',fence(claim.condition),'');
 lines.push('## 原文依据','');
 for(const e of claim.evidence){
  const source=sources.find(s=>s.id===e.sourceId);
  lines.push(`### ${literal(source?.title||'原始资料')}`,'',fence(e.quote),'',`引用位置：${e.start}–${e.end}。`,'',fence(JSON.stringify({...e,quote:undefined,sourceSha256:sourceRefs.find(s=>s.id===e.sourceId)?.sha256??null})),'');
 }
 if(!claim.evidence.length)lines.push('没有附带原文引用，不能把这份记录当作外部事实的证明。','');
 lines.push('## 修改与核对','');
 for(const change of journey.changes)lines.push(`- ${literal(change.recordedAt)}：${literal(change.reason||'未记录修改原因，不能推断。')}`);
 if(!journey.changes.length)lines.push('还没有关联的修改记录。');
 lines.push('','此文件只保存当前记录和明确关联的依据，不包含整个项目，也不证明相关任务已完成。','来源文字按原文封装，不运行其中的网页、脚本或指令。','');
 const text=lines.join('\n');return {claimId:claim.id,name:filename(claim.title),text,selectionHash,sha256:sha256(Buffer.from(text)),
  notice:'只保存你选中的当前记录及出处。保存后仍是私人文件；不会自动写入笔记库，也不会公开。'};
}

export function noteExport(repository,auth,scope,claimId,expectedSelectionHash){
 const detail=repository.claimDetail(auth,scope,claimId);
 const sourceRefs=[...new Set(detail.claim.evidence.map(e=>e.sourceId))].map(id=>{
  const source=repository.read(auth,scope,'source',id);if(!source)throw new ProtocolError('conflict','原文依据暂时无法核对。','保留当前记录，检查原文件后再保存。');
  return {id,sha256:source.sha256,byteLength:source.byteLength,format:source.format};
 });
 const result=previewNoteExport({...detail,sourceRefs},scope);
 if(expectedSelectionHash!==undefined&&result.selectionHash!==expectedSelectionHash)
  throw new ProtocolError('stale_context','记录、出处或核对结果已改变，尚未保存。','重新预览最新内容后再保存。');
 return result;
}
