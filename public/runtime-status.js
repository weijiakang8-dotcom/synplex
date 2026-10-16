// Request IDs identify diagnostics, not permission or proof of task completion.
export function traceError(error,response){
 const id=response.headers.get('X-Synplex-Trace-Id');
 if(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id||''))error.supportId=id;
 return error;
}
export function supportMessage(value,text){return value?.supportId?text+'\n问题编号：'+value.supportId:text;}
export function runtimeStatusCard(view,history,esc,date){
 if(!['progress','task'].includes(view)||!history.executionStatus)return '';
 const status=history.executionStatus,c=status.counts;
 const states=[['queued','排队'],['running','处理中'],['waiting','等你处理'],['stopping','正在停止'],['unknown','结果待核对'],['needsInput','需要补充'],['succeeded','执行结束'],['failed','未完成'],['cancelled','已停止']];
 return `<details class="panel" data-ai-context="task-status"><summary>任务状态</summary><p class="subtle">这里只统计从工作台开始的任务。执行结束后，仍需检查成果是否符合要求。</p>${c.total?`<dl class="task-state-counts">${states.filter(([key])=>c[key]>0).map(([key,label])=>`<div><dt>${label}</dt><dd>${esc(c[key])}</dd></div>`).join('')}</dl>`:'<p class="subtle">还没有从这里开始的任务。</p>'}${c.unknown||c.observationExpired?'<p class="notice">有任务的进度需要核对，请查看原任务，不要重新开始。</p>':''}${c.answersUnconfirmed?'<p class="notice">有答案已保存，但还无法确认工具是否收到，请核对原任务进度。</p>':''}${c.writebackPending?'<p class="notice">有结果还未完整保存。请核对原任务，只补存结果，不要重新执行。</p>':''}${history.diagnostics?.enabled&&!history.diagnostics.available?'<p class="notice">诊断记录暂时无法保存，已有任务和资料仍保留。</p>':''}<p class="subtle">查看于 ${esc(date(status.observedAt))}</p><button type="button" data-action="refresh" data-ai-key="task-status" data-tip="核对已有记录，不会重新开始任务">更新状态</button></details>`;
}

export function importStatusCard(history){
 const c=history.importStatus?.counts??{},active=(c.queued||0)+(c.running||0),attention=(c.unknown||0)+(c.failed||0)+(c.needs_input||0);
 if(!active&&!attention)return '';
 return `<section class="notice" data-ai-context="library-import-progress" role="status"><strong>${active?'资料正在后台整理':'资料整理进度'}</strong><p>原件已保存 ${history.importStatus.sources} 份${active?'，还有 '+active+' 份正在整理；可以继续工作，关闭窗口不影响已上传的资料':''}。${attention?'有 '+attention+' 份需要核对，请在资料中查看读取说明。':''}</p><button type="button" data-action="refresh" data-ai-key="import-status">更新进度</button></section>`;
}
