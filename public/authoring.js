export function claimEditor(detail,esc){
 const c=detail.claim;
 return `<div class="dialog-heading"><h2>修改记录</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="subtle">修改后仍需确认，旧记录和原文会保留。手工整理的内容不会被自动整理覆盖。</p><form id="claim-edit-form"><label>名称<input name="title" required maxlength="160" value="${esc(c.title)}"></label><label>归为哪种记录<select name="type">${[['fact','事实'],['decision','决定'],['failure','遇到的问题'],['lesson','经验'],['unknown','待确认的信息']].map(([id,label])=>`<option value="${id}" ${c.type===id?'selected':''}>${label}</option>`).join('')}</select></label><label>内容<textarea name="body" required maxlength="32000" rows="7">${esc(c.body)}</textarea></label><label>适用情况<textarea name="condition" maxlength="8000" rows="2">${esc(c.condition||'')}</textarea></label><label>为什么修改<textarea name="note" required maxlength="8000" rows="2"></textarea></label><button class="primary" type="submit">保存修改</button><p role="alert"></p></form><details><summary>修改前的记录</summary><p class="excerpt">${esc(c.body)}</p>${c.evidence.map(e=>`<blockquote>${esc(e.quote)}</blockquote>`).join('')}</details>${detail.revisions.length?`<details><summary>修改经过</summary>${detail.revisions.map(r=>`<p>${esc(r.reason)}</p><p class="subtle">${esc(new Date(r.recordedAt).toLocaleString('zh-CN'))}</p>`).join('')}</details>`:''}`;
}
export function sourceEditor(meta,title,categories,esc){
 return `<div class="dialog-heading"><h2>名称与分类</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="subtle">只整理名称和分类，原文件内容不变。</p><form id="source-edit-form"><label>名称<input name="title" required maxlength="160" value="${esc(meta.title||title)}"></label><label>分类<input name="category" maxlength="240" list="material-categories" placeholder="例如：调研资料/用户访谈" value="${esc(meta.category)}"><datalist id="material-categories">${categories.map(x=>`<option value="${esc(x)}"></option>`).join('')}</datalist></label><label>标签<input name="tags" maxlength="1000" placeholder="用逗号分开，例如：预算、需求" value="${esc(meta.tags.join('、'))}"></label><label class="check"><input type="checkbox" name="locked" ${meta.locked?'checked':''}>锁定这份整理</label><p class="subtle">锁定后，自动整理不能覆盖已有内容；你仍可手工修改。</p><button type="submit" class="primary">保存</button><p role="alert"></p></form>`;
}
export function categoryFilter(metadata,selected,esc){
 const categories=[...new Set(metadata.map(m=>m.category).filter(Boolean))].sort();if(!categories.length)return '';
 return `<label>分类<select id="material-category" aria-label="按分类查看资料"><option value="all">全部资料</option><option value="uncategorized" ${selected==='uncategorized'?'selected':''}>未分类</option>${categories.map(c=>`<option value="${esc(c)}" ${selected===c?'selected':''}>${esc(c)}</option>`).join('')}</select></label>`;
}
export const AUTHORING_REQUESTS=Object.freeze({'synplex-pending-claim-edit':'ui_edit_claim','synplex-pending-source-edit':'ui_source_metadata','synplex-pending-claim-restore':'ui_restore_claim'});
export function pendingAuthoring(storage,scope){
 return Object.keys(AUTHORING_REQUESTS).filter(key=>{try{const value=JSON.parse(storage.getItem(key));return value?.intent&&JSON.stringify(value.current.scope)===JSON.stringify(scope);}catch{return false;}});
}
export function authoringRecovery(keys,esc){
 return keys.length?`<div class="notice" role="status">上次修改的保存结果还需核对，原内容已保留。${keys.map(key=>`<button data-action="check-authoring-save" data-id="${esc(key)}">核对保存结果</button>`).join('')}</div>`:'';
}
