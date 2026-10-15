import {artifactComparisonForm} from './artifact-comparison.js';
import {fileLabel} from './user-copy.js';
import {outputTablePreview} from './output-table.js';
export function artifactPreviewDialog(preview,esc){
 return `<div class="dialog-heading"><h2>${esc(fileLabel(preview.name))}</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="notice">${esc(preview.notice)}</p>${outputTablePreview(preview,esc)}<button data-action="save-artifact-file" data-result="${esc(preview.resultId)}" data-id="${esc(preview.artifactId)}" data-ai-action="save_artifact_file">保存到电脑</button><p class="subtle">浏览器支持时可选择位置；否则保存到下载文件夹。不会自动替换其他版本。</p>`;
}
export function resultVersionDialog(detail,esc){
 const selected=detail.versions.find(r=>r.id===detail.selectedResultId),other=detail.versions.find(r=>r.id!==detail.selectedResultId)||selected;
 return `<div class="dialog-heading"><h2>成果版本</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="subtle">只比较这份成果真实的修改版本。查看不会重新执行，也不会改变已检查的结论。</p>${!detail.complete?'<p class="notice">这里展示部分版本，完整历史仍保留。</p>':''}<label>与这版比较<select id="result-version-select">${detail.versions.map((r,i)=>`<option value="${esc(r.id)}" ${r.id===other.id?'selected':''}>${esc(new Date(r.recordedAt).toLocaleString('zh-CN'))}${r.id===selected.id?' · 当前查看':''} · ${i+1}</option>`).join('')}</select></label><div id="result-version-comparison">${resultComparison(selected,other,esc)}</div>`;
}
export function resultComparison(current,other,esc){
 const files=(r,side)=>`<section data-ai-context="${side}:${esc(r.id)}"><h3>${side==='viewing'?'当前查看的版本':'选中的版本'}</h3><p class="excerpt">${esc(r.summary)}</p>${r.artifacts.map(a=>`<article class="record"><h4>${esc(fileLabel(a.name))}</h4><p class="subtle">${(a.byteLength/1024).toFixed(1)} 千字节 · ${current.id===other.id?'同一版本':(side==='viewing'?other:current).artifacts.some(b=>b.sha256===a.sha256&&b.byteLength===a.byteLength)?'另一版也有相同内容':'与另一版文件内容不同'}</p>${a.saved?`<button data-action="artifact-preview" data-result="${esc(r.id)}" data-id="${esc(a.id)}">查看内容</button><button data-action="artifact-download" data-result="${esc(r.id)}" data-id="${esc(a.id)}">下载</button>`:'<p class="notice">原文件还未保存，暂时无法查看内容。</p>'}</article>`).join('')||'<p>这个版本还没有文件。</p>'}</section>`;
 return `<p class="notice">${current.summary===other.summary?'成果说明相同；文件和排版仍需分别核对。':'成果说明有变化，请结合文件查看。'}</p><div class="form-columns">${files(current,'viewing')}${files(other,'selected')}</div>${artifactComparisonForm(current,other,esc)}`;
}
