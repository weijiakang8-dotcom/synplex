import {noteLinks,resolveNoteLink} from './obsidian-notes.js';
export async function obsidianNavigation(c,preview){
 const index=await c.request('ui_obsidian_notes',{}),origins=index.items.filter(n=>n.sourceId===preview.source.id);
 if(!origins.length)return '';
 const links=noteLinks((preview.parsed?.blocks||[]).map(b=>b.text).join('\n'));
 return '<section aria-label="笔记链接"><h3>笔记链接</h3>'+origins.map(origin=>`<p class="subtle">${c.esc(origin.vault+' / '+origin.path)}</p>${links.map((link,i)=>linkControl(origin,link,index.items,i,c.esc)).join('')}`).join('')+(!links.length?'<p class="subtle">这一段没有笔记链接。</p>':'')+(!index.complete?'<p class="notice">这里只列出最近导入的笔记，较早的笔记请在资料中查找。</p>':'')+'</section>';
}
function linkControl(origin,link,notes,index,esc){
 const found=resolveNoteLink(origin,link,notes),key=origin.vault+':'+origin.path+':'+index;
 if(found.status!=='found')return `<p class="subtle">${esc(link.label)} · ${found.status==='ambiguous'?'有同名笔记，请在资料中选择':'尚未导入，可从笔记库补充'}</p>`;
 const target=found.matches[0];
 return `<button type="button" data-action="preview-source" data-id="${esc(target.sourceId)}" data-ai-key="${esc(key)}" data-anchor="${esc(link.anchor)}" data-tip="${esc(target.path+(link.anchor?' · '+link.anchor:''))}">${esc(link.label)}</button>`;
}
