import {ProtocolError,payloadHash,sha256} from '../../packages/contracts/validate.mjs';
import {noteExport} from './note-export.mjs';

const groups=Object.freeze({fact:'已确认的信息',decision:'关键决定',failure:'遇到的问题',lesson:'留下的经验',unknown:'还需补充的条件'});
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=value=>!value?'未知':Number.isNaN(new Date(value).getTime())?value:new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const fail=()=>{throw new ProtocolError('validation_failed','请填写标题，选择1至30条已确认记录。','先核对记录，再选择需要放进项目介绍的内容。');};
export function validExpressionInput(i){
 return typeof i.title==='string'&&i.title.trim().length>0&&i.title.length<=80&&!/[\u0000-\u001f\u007f]/.test(i.title)&&
  typeof i.includeEvidence==='boolean'&&Array.isArray(i.claimIds)&&i.claimIds.length>0&&i.claimIds.length<=30&&
  i.claimIds.every(id=>typeof id==='string'&&id.length>0&&id.length<=160)&&new Set(i.claimIds).size===i.claimIds.length;
}
const style=`*{box-sizing:border-box}body{margin:0;background:#f8f7f3;color:#191b19;font:16px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}main{max-width:900px;margin:auto;padding:64px 24px}header{padding-bottom:32px;border-bottom:1px solid #d9dbd5}h1{font-size:clamp(28px,6vw,48px);line-height:1.3;overflow-wrap:anywhere}h2{font-size:22px;margin-top:40px}h3{font-size:18px;margin-bottom:8px}.label,small,footer{font-size:13px;color:#636b62}article{border-top:1px solid #d9dbd5;padding:20px 0}p,blockquote{white-space:pre-wrap;overflow-wrap:anywhere}blockquote{margin:12px 0;border-left:2px solid #b6c2b1;padding-left:16px}details{margin-top:16px}summary{cursor:pointer}footer{margin-top:48px;border-top:1px solid #d9dbd5;padding-top:24px}@media print{body{background:white}main{padding:0}details{display:block}article{break-inside:avoid}}`;

function evidenceHtml(items){
 return items.length?`<details><summary>原文依据</summary>${items.map(e=>`<section><h4>${esc(e.title)}</h4><blockquote>${esc(e.quote)}</blockquote><small>引用位置：${e.start}–${e.end}；发生时间：${esc(time(e.date))}。</small></section>`).join('')}</details>`:'';
}
export const EXPRESSION_CSP=`default-src 'none'; style-src 'sha256-${Buffer.from(sha256(Buffer.from(style)),'hex').toString('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
export function renderExpressionHtml(preview,{linked=false}={}){
 const policy=EXPRESSION_CSP;
 const content=preview.sections.map(group=>`<section><h2>${esc(group.title)}</h2>${group.items.map(item=>`<article><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p>${item.condition?`<p>适用情况：${esc(item.condition)}</p>`:''}<small>发生时间：${esc(time(item.occurredAt))}；记录时间（北京时间）：${esc(time(item.recordedAt))}。${item.hasEvidence?'有原文引用，确认不等于外部验证。':'未附原文引用，不能当作外部事实证明。'}</small>${evidenceHtml(item.evidence)}</article>`).join('')}</section>`).join('');
 const label=linked?'作者确认的版本':'私人副本',notice=linked?'此链接只在运行工作台的这台电脑上打开，未上传到互联网。链接1小时内有效；停止查看、工作台重启、相关内容或权限改变后不能继续打开。已经看过、复制或另存的内容不能收回。':'文件不会自动发布。保存后，工作台里的修改、撤回与权限变化不会自动更新这份副本；转交他人前请重新核对。';
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${esc(policy)}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(preview.title)}</title><style>${style}</style></head><body><main><header><div class="label">Synplex · 项目介绍 · ${label}</div><h1>${esc(preview.title)}</h1><p>这份介绍只包含作者选中的已确认记录，按内容整理；各条记录之间未证明的因果关系不作推断。</p></header>${content}<footer>${notice}不包含完整项目或未选资料，不证明相关任务已经完成。</footer></main></body></html>`;
}

// Adapt Weave's author-selected, escaped, static snapshot. No mock portfolio,
// identities, whole-vault material, remote URLs, JS, model calls or publication.
export function projectExpression(repository,auth,scope,input){
 if(!validExpressionInput(input))fail();
 const notes=input.claimIds.map(id=>({detail:repository.claimDetail(auth,scope,id),note:noteExport(repository,auth,scope,id)}));
 const sections=Object.entries(groups).map(([type,title])=>({title,items:notes.filter(n=>n.detail.claim.type===type).map(({detail})=>{
  const c=detail.claim;return {title:c.title,body:c.body,condition:c.condition,occurredAt:c.occurredAt,recordedAt:c.recordedAt,
   hasEvidence:c.evidence.length>0,evidence:input.includeEvidence?c.evidence.map(e=>({title:detail.sources.find(s=>s.id===e.sourceId)?.title||'原始资料',quote:e.quote,start:e.start,end:e.end,date:c.occurredAt})):[]};
 })})).filter(group=>group.items.length);
 const selectionHash=payloadHash({scope,title:input.title.trim(),includeEvidence:input.includeEvidence,notes:notes.map(n=>({id:n.note.claimId,selectionHash:n.note.selectionHash}))});
 if(input.expectedSelectionHash!==undefined&&input.expectedSelectionHash!==selectionHash)
  throw new ProtocolError('stale_context','选中的记录或原文已有变化，尚未保存。','重新预览最新内容，再保存项目介绍。');
 const preview={title:input.title.trim(),sections,selectionHash,count:notes.length,
  notice:input.includeEvidence?'只包含你选中的记录及其原文引用；保存到电脑不会公开。':'只包含你选中的记录，不附原文；保存到电脑不会公开。'};
 const html=renderExpressionHtml(preview),name=(input.title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').replace(/^\.+/,'').trim()||'项目介绍')+'.html';
 return {...preview,html,name,sha256:sha256(Buffer.from(html))};
}
