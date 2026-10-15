import test from 'node:test';
import assert from 'node:assert/strict';
import {artifactPreviewDialog} from '../../public/artifact-view.js';

const esc=value=>String(value).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
const show=(text,mediaType='text/markdown')=>artifactPreviewDialog({name:'比较.md',mediaType,text,notice:'完整原文保留',resultId:'result',artifactId:'file'},esc);
const table=(rows,header='项目 | 数量')=>header+'\n--- | ---\n'+rows.join('\n');

test('成果表格只呈现原数据，数字图以零为基线；歧义/代码/超限原文保留且无可执行内容',()=>{
 const text='开篇\n'+table(['甲 | -2','乙 | 6','丙 | 0'])+'\n\n末尾';
 const html=show(text);assert.match(html,/<th scope="col">项目/);assert.match(html,/<td>-2<\/td>/);
 assert.match(html,/x="0" y="0" width="25"/);assert.match(html,/x="25" y="0" width="75"/);assert.match(html,/x="25" y="0" width="0"/);
 assert.match(html,/查看原文/);assert.ok(html.includes(esc(text)));assert.match(html,/保存到电脑/);
 for(const rows of [['甲 | 1','乙 | 0.25'],['甲 | 1','乙 | 1,000'],['甲 | 1','乙 | 30%'],['甲 | 1','乙 | =SUM(A1)'],['甲 | 1','|乙| |'],['甲 | 1','乙 | 1e3'],['甲 | 0','乙 | 0'],['甲 | 1','乙 | 1000000000000000']]){
  const preview=show(table(rows));assert.match(preview,/<table>/);
  if(rows[1]==='乙 | 0.25')assert.match(preview,/看图/);else assert.doesNotMatch(preview,/看图/);
 }
 const untrusted=table(['<img src=x onerror=alert(1)> | 1','<script>bad()</script> | 2']);
 const safe=show(untrusted);assert.doesNotMatch(safe,/<img|<script/);assert.ok(safe.includes('&lt;img'));
 assert.doesNotMatch(safe,/ style=/,'图形不能要求放宽当前安全策略');
 for(const text of ['```md\n'+table(['甲 | 1','乙 | 2'])+'\n```','~~~~\n'+table(['甲 | 1','乙 | 2'])+'\n~~~',table(['甲 | 1','乙 | ']),table(['甲 | 1','乙 | 2 | 多余']),table(['甲\\|乙 | 1','丙 | 2']),table(Array.from({length:101},(_,i)=>'行'+i+' | '+i)),'长'.repeat(65537)+table(['甲 | 1','乙 | 2'])]){
  const fallback=show(text);assert.doesNotMatch(fallback,/<table>/);assert.ok(fallback.includes(esc(text)));
 }
 const code=artifactPreviewDialog({name:'page.html',mediaType:'text/html',text:table(['甲 | 1','乙 | 2']),notice:'只显示原文',resultId:'r',artifactId:'a'},esc);
 assert.doesNotMatch(code,/<table>/);
});
