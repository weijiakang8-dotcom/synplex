import {expressionContent} from './project-expression.js';

const sameScope=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const date=value=>new Date(value).toLocaleString('zh-CN');
const heading=title=>`<div class="dialog-heading"><h2>${title}</h2><button id="close-dialog" aria-label="关闭">×</button></div>`;
function show(c,html){c.dialog.innerHTML=html;c.dialog.querySelector('#close-dialog').onclick=()=>c.dialog.close();if(!c.dialog.open)c.dialog.showModal();}
async function versions(button,c){
 const ticket=c.beginPreview();button.disabled=true;
 try{
  const reply=await c.request('ui_expression_versions',{});if(!c.previewCurrent(ticket))return;
  show(c,heading('确认版本')+'<p>保留每次确认的内容；不会自动替换为后来的修改。</p>'+reply.versions.map(v=>`<article class="record" data-ai-context="expression:${c.esc(v.id)}"><h3>${c.esc(v.title)}</h3><p>${c.esc(date(v.createdAt))} · ${v.count}条记录 · ${v.status==='stopped'?'已停止查看':'已保存，打开链接前会核对最新情况'}</p><button data-action="view-expression-version" data-version="${c.esc(v.id)}">查看这版</button></article>`).join('')+(!reply.versions.length?'<p class="notice">还没有确认版本。先选择内容并完整预览，再保存。</p>':'')+(!reply.complete?'<p class="subtle">这里只展示最近50版，更早记录仍保留。</p>':''));
 }finally{button.disabled=false;}
}
function versionDialog(c,value){
 c.dialog.expressionVersion={id:value.id,scope:structuredClone(c.getScope())};
 show(c,heading('确认版本')+`<p class="notice">${value.status==='stopped'?'已停止查看，原内容仍为你保留。':'这是保存时确认的内容，不会随项目更新。查看链接会重新核对内容与权限。'}</p>`+expressionContent(value.content,c.esc)+`<div class="button-row">${value.status==='stopped'?'':`<button data-action="create-expression-link" data-version="${c.esc(value.id)}">生成查看链接</button><button data-action="stop-expression-link" data-version="${c.esc(value.id)}">停止查看</button>`}<button data-action="expression-versions">所有版本</button></div><div id="expression-link-result" aria-live="polite"></div><p class="subtle">链接只在这台电脑上打开，1小时内有效；工作台重启后失效。已经复制或另存的内容无法收回。</p>`);
}
async function view(button,c){
 const ticket=c.beginPreview();button.disabled=true;
 try{const value=await c.request('ui_expression_version',{versionId:button.dataset.version});if(c.previewCurrent(ticket))versionDialog(c,value);}finally{button.disabled=false;}
}
async function approve(button,c){
 const saved=c.dialog.projectExpression;
 if(!saved?.preview||!sameScope(saved.scope,c.getScope())||!c.dialog.querySelector('#expression-approved')?.checked)throw new Error('请先核对完整预览，并勾选确认。');
 const ticket=c.beginPreview();button.disabled=true;
 try{
  const value=await c.savedMutation('ui_approve_expression',{...saved.selection,expectedSelectionHash:saved.preview.selectionHash,approved:true},'synplex-pending-expression-approval');
  if(c.previewCurrent(ticket)){const stored=await c.request('ui_expression_version',{versionId:value.id});if(c.previewCurrent(ticket))versionDialog(c,stored);}c.notify('确认版本已保存，没有上传到互联网。');
 }finally{button.disabled=false;}
}
function selected(button,c){
 const saved=c.dialog.expressionVersion;
 if(!saved||saved.id!==button.dataset.version||!sameScope(saved.scope,c.getScope()))throw new Error('请重新打开当前项目的确认版本。');return saved;
}
async function link(button,c){
 const saved=selected(button,c),ticket=c.beginPreview();button.disabled=true;
 try{
  const value=await c.request('ui_expression_link',{versionId:saved.id});if(!c.previewCurrent(ticket))return;
  const url=new URL(value.path,location.origin);if(url.origin!==location.origin||!/^\/view\/[a-f0-9]{64}$/.test(url.pathname)||url.search||url.hash)throw new Error('链接暂时无法核对，请重新打开这版。');
  c.dialog.querySelector('#expression-link-result').innerHTML=`<p>${c.esc(value.notice)}</p><p>到期时间：${c.esc(date(value.expiresAt))}</p><a href="${c.esc(url.href)}" target="_blank" rel="noopener noreferrer" data-version="${c.esc(saved.id)}" data-ai-action="open_project_view">打开介绍</a>`;
 }finally{button.disabled=false;}
}
async function stop(button,c){
 const saved=selected(button,c),ticket=c.beginPreview();button.disabled=true;
 try{
  await c.savedMutation('ui_stop_expression',{versionId:saved.id},'synplex-pending-expression-stop');
  if(c.previewCurrent(ticket)){const value=await c.request('ui_expression_version',{versionId:saved.id});if(c.previewCurrent(ticket))versionDialog(c,value);}c.notify('已停止查看，这版内容与历史记录仍保留。');
 }finally{button.disabled=false;}
}
export const EXPRESSION_VERSION_ACTIONS=Object.freeze({'expression-versions':versions,'view-expression-version':view,'approve-project-expression':approve,'create-expression-link':link,'stop-expression-link':stop});
