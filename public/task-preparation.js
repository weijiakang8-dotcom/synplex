// A pending preparation is scoped to one project. Recovery reads the original
// intent; edits made while a response is uncertain are a separate draft.
export const taskPreparationKey=scope=>'synplex-pending-task-preparation:'+JSON.stringify(scope);
export function taskPreparationControls(storage,scope){
 const pending=!!pendingTaskPreparation(storage,scope);
 return {attributes:pending?'novalidate':'',label:pending?'核对上次准备':'准备任务'};
}
export function pendingTaskPreparation(storage,scope){
 const raw=storage.getItem(taskPreparationKey(scope));if(!raw)return null;
 try{const saved=JSON.parse(raw);if(saved?.intent&&saved.current&&JSON.stringify(saved.current.scope)===JSON.stringify(scope))return saved;}catch{/* Keep the uncertain intent, never silently create another task. */}
 return {invalid:true};
}
export function taskPreparationInput(data){
 const lines=value=>String(value).split('\n').filter(x=>x.trim()),executor=data.get('executor')||'current_host';
 const input={goal:data.get('goal'),constraints:lines(data.get('constraints')),acceptanceCriteria:lines(data.get('acceptance')),
  mode:executor==='current_host'?'host_assist':executor==='synplex'?'platform_owned':'delegated',executor,
  selectedOccurrenceIds:data.getAll('occurrence'),maxInputTokens:Number(data.get('maxInputTokens'))};
 if(data.get('model'))input.executionOptions={model:String(data.get('model')),effort:String(data.get('effort'))};
 return input;
}
export function preparationNotice(storage,scope,esc){
 const saved=pendingTaskPreparation(storage,scope);if(!saved)return '';
 if(saved.invalid)return '<p class="notice" role="alert">上次准备记录暂时无法读取。请保留这个页面，由维护人员核对已有任务；不会再创建一份。</p>';
 return `<section class="notice" role="status" data-ai-role="task_preparation_recovery"><p>上次准备的结果还需核对。下方按钮会查找原任务，后来编辑的内容仍保留为草稿，不会另建任务或开始执行。</p><details><summary>上次的目标</summary><p class="excerpt">${esc(saved.current.goal)}</p></details></section>`;
}
