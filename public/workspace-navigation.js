// Reuses existing destinations; folding changes visibility, never permissions.
export function businessNavigation({view,projectName,pending,esc,storage}){
 const open=id=>storage.getItem('synplex-navigation:'+id)!=='closed'?'open':'';
 const button=(id,name,tip)=>`<button type="button" data-nav="${id}" data-tip="${tip}" class="${view===id?'selected':''}" ${view===id?'aria-current="page"':''}>${name}${id==='review'&&pending?`<b>${pending}</b>`:''}</button>`;
 const group=(id,name,body)=>`<details class="navigation-group" data-navigation-group="${id}" ${open(id)}><summary>${esc(name)}</summary>${body}</details>`;
 return `<nav aria-label="主导航" data-ai-context="navigation">${group('project',projectName,button('progress','项目概览','查看项目进展与待办')+group('work','工作',button('task','任务','对话或执行任务')+'<div class="navigation-children"><button type="button" data-open-task="chat" data-ai-action="open_chat_page">对话</button><button type="button" data-open-task="execute" data-ai-action="open_execution_page">执行任务</button></div>'+button('results','成果','查看和核对任务成果'))+group('library','资料与记录',button('materials','资料','查看文件和项目笔记')+'<div class="navigation-children"><button type="button" data-obsidian-open data-ai-id="navigation-obsidian" data-ai-action="import_notes">Obsidian 笔记库</button></div>'+button('history','记录','回看决定、转折和经验')+button('review','待核对','确认记录和处理冲突'))) }</nav>`;
}
export function collaborationContext({view,state,history,esc}){
 const recent=[...state.decisions,...state.lessons].slice(-3),pending=history.pendingTotal??state.pending.length,sources=history.totals?.sources??history.sources.length;
 const names={materials:'资料使用',results:'成果核对',review:'核对提醒',history:'项目背景'};
 return `<section id="collaboration-panel" data-ai-context="collaboration"><h3>${names[view]||'项目背景'}</h3>${recent.length?recent.map(r=>`<article><span class="tag">${r.type==='lesson'?'经验':'已确认'}</span><p>${esc(r.body.slice(0,180))}</p></article>`).join(''):`<p class="subtle">${sources?'资料已保存，可以直接提问；重要结论仍需你确认。':'添加项目资料，之后的对话和任务就能参考这些背景。'}</p>`}<div class="button-row"><button type="button" data-nav="materials">添加资料</button><button type="button" data-nav="review">待核对${pending?' · '+pending:''}</button></div><p class="subtle">${sources} 份资料 · ${state.lessons.length} 条经验</p><button type="button" data-open-task="chat" data-ai-action="collaborate_chat">继续对话</button></section>`;
}
