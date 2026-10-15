import {obsidianNavigation} from './obsidian-navigation.js';
import {documentExtension} from './document-formats.js';
export const SOURCE_PREVIEW_ACTIONS=Object.freeze(['preview-source','source-preview-next','source-preview-previous']);

function pageHtml(preview,number,esc){
 const blocks=preview.parsed?.blocks??[];
 return `<div class="dialog-heading"><h2>资料内容</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="notice">${documentExtension(preview.source.format)?'这里只显示提取出的文字；图片、排版、批注和备注请查看原文件。':'已读取的文字，整理出的记录仍需确认。'}</p>
 <div id="source-preview-content">${blocks.length?blocks.filter(b=>b.text.trim()).map(b=>`<pre class="excerpt">${esc(b.text)}</pre>`).join(''):'<p>暂时没有读取到文字，请下载原文件检查。扫描文件可以先转成含文字的文档。</p>'}</div>
 ${preview.page?`<nav aria-label="资料阅读"><button data-action="source-preview-previous" ${number===1?'disabled':''}>上一段</button><span role="status">第 ${number} 段${preview.page.cursor?' · 后面还有内容':''}</span><button data-action="source-preview-next" ${preview.page.cursor?'':'disabled'}>继续阅读</button></nav><p class="subtle">长资料分段显示；这不是原文件页码。原文和出处保留，不影响提问时选择整份资料。</p>`:''}
 <p role="alert" id="source-preview-error"></p><button data-action="download" data-id="${esc(preview.source.id)}">下载原文件</button>`;
}
async function navigation(c,preview){try{return await obsidianNavigation(c,preview);}catch{return '<p class="subtle">笔记链接暂时无法读取，原文仍可查看。</p>';}}
function anchorNotice(c,anchor){if(anchor)c.dialog.querySelector('#source-preview-content').insertAdjacentHTML('beforebegin','<p class="notice">目标位置：'+c.esc(anchor)+'。请按原文阅读；不在本段时可继续阅读。</p>');}
export function createSourcePreviewActions(c){
 let current=null,sequence=0;
 async function load(button,direction){
  const starting=direction===0,ticket=starting?c.beginPreview():current?.ticket;
  if(!ticket||!c.previewCurrent(ticket))return;
  const state=starting?{ticket,sourceId:button.dataset.id,cursors:[null],index:0}:current;
  const index=starting?0:state.index+direction;
  if(index<0||index>=state.cursors.length)return;
  const pending=++sequence;
  button.disabled=true;
  try{
   const preview=await c.request('ui_source_preview',{sourceId:state.sourceId,...(state.cursors[index]?{cursor:state.cursors[index]}:{})});
   const links=await navigation(c,preview);
   if(!c.previewCurrent(ticket)||pending!==sequence)return;
   current={...state,index,cursors:state.cursors.slice(0,index+1)};
   if(preview.page?.cursor)current.cursors.push(preview.page.cursor);
   c.dialog.innerHTML=pageHtml(preview,index+1,c.esc)+links;
   anchorNotice(c,button.dataset.anchor);c.dialog.querySelector('#close-dialog').onclick=()=>c.dialog.close();
   if(!c.dialog.open)c.dialog.showModal();c.dialog.scrollTop=0;
  }catch(error){
   if(pending!==sequence||!c.previewCurrent(ticket))return;
   if(!starting){c.dialog.querySelector('#source-preview-error').textContent='暂时无法继续阅读，请稍后重试。若资料或权限已变化，请关闭后重新打开；已读内容保留。';return;}
   throw error;
  }finally{button.disabled=false;}
 }
 return {'preview-source':button=>load(button,0),'source-preview-next':button=>load(button,1),'source-preview-previous':button=>load(button,-1)};
}
