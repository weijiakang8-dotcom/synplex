// A read-only view of explicit Markdown tables, never an instruction parser.
// Ambiguous, fenced or oversized content stays verbatim. No HTML/links execute.
const cells=line=>{
 const value=line.trim();
 if(!value.includes('|')||/[\\`]/.test(value))return null;
 return value.replace(/^\|/,'').replace(/\|$/,'').split('|').map(x=>x.trim());
};
function tableAt(lines,start){
 const headers=cells(lines[start]),rule=cells(lines[start+1]??'');
 if(!headers||headers.length<2||headers.length>12||headers.some(x=>!x)||!rule||rule.length!==headers.length||!rule.every(x=>/^:?-{3,}:?$/.test(x)))return null;
 const rows=[];let end=start+2;
 while(end<lines.length&&lines[end].trim()&&lines[end].includes('|')){
  const row=cells(lines[end]);if(!row||row.length!==headers.length||rows.length>=100)return null;
  rows.push(row);end++;
 }
 return rows.length?{headers,rows,end}:null;
}
function numericRows(table){
 if(table.headers.length!==2||table.rows.length<2||table.rows.length>30)return null;
 const result=[];
 for(const [label,text] of table.rows){
  // Do not infer units, cached formula values, percentages or missing numbers.
  if(!label||!/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)||text.replace(/\D/g,'').length>15)return null;
  const value=Number(text);if(!Number.isFinite(value)||Math.abs(value)>Number.MAX_SAFE_INTEGER)return null;
  result.push({label,text,value});
 }
 return result;
}
function chart(table,esc){
 const values=numericRows(table);if(!values)return '';
 const min=Math.min(0,...values.map(x=>x.value)),max=Math.max(0,...values.map(x=>x.value));
 const range=max-min;if(!Number.isFinite(range)||range===0)return '';
 const percent=x=>String(Math.max(0,Math.min(100,x*100/range)));
 return `<details class="output-chart" data-ai-context="table-chart"><summary data-ai-action="view_table_chart" data-tip="把这张表里的数值换成对比图">看图</summary><figure><figcaption>${esc(table.headers[1])}</figcaption><ol>${values.map(row=>`<li><span class="output-chart-label">${esc(row.label)}</span><svg class="output-chart-track" viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true"><line class="output-chart-zero" x1="${percent(-min)}" x2="${percent(-min)}" y1="0" y2="16" vector-effect="non-scaling-stroke"></line><rect class="output-chart-bar" x="${percent(Math.min(0,row.value)-min)}" y="0" width="${percent(Math.abs(row.value))}" height="16"></rect></svg><span class="output-chart-value">${esc(row.text)}</span></li>`).join('')}</ol><p class="subtle">按表内数值展示，完整数据见上表。</p></figure></details>`;
}
function renderTable(table,esc,index){
 return `<section class="output-table" data-ai-context="preview-table:${index}"><div class="output-table-scroll" role="region" aria-label="成果表格" tabindex="0"><table><thead><tr>${table.headers.map(x=>`<th scope="col">${esc(x)}</th>`).join('')}</tr></thead><tbody>${table.rows.map(row=>`<tr>${row.map(x=>`<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${chart(table,esc)}</section>`;
}
export function outputTablePreview(preview,esc){
 const text=preview.text,raw=()=>`<pre class="excerpt">${esc(text)}</pre>`;
 if(!text)return '';
 if(!(preview.mediaType==='text/markdown'||/\.md$/i.test(preview.name??''))||text.length>65536)return raw();
 const lines=text.split('\n');if(lines.length>2000)return raw();
 const parts=[],pending=[];let fence=null,tables=0;
 const flush=()=>{if(pending.some(line=>line.trim()))parts.push(`<pre class="excerpt">${esc(pending.join('\n'))}</pre>`);pending.length=0;};
 for(let i=0;i<lines.length;){
  const line=lines[i],marker=line.trimStart().match(/^(`{3,}|~{3,})(.*)$/);
  if(marker){
   if(!fence)fence={char:marker[1][0],length:marker[1].length};
   else if(marker[1][0]===fence.char&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;
   pending.push(line);i++;continue;
  }
  const table=!fence&&tables<10?tableAt(lines,i):null;
  if(table){flush();parts.push(renderTable(table,esc,++tables));i=table.end;}
  else{pending.push(line);i++;}
 }
 if(!tables)return raw();flush();
 return `<div class="output-document">${parts.join('')}<details class="output-original"><summary>查看原文</summary>${raw()}</details></div>`;
}
