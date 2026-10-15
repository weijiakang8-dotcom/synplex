import {connectionScreen,showStartupFailure} from '../../public/workspace-startup.js';
import {bindModelUsageReview,executionModelUsage} from '../../public/model-usage.js';
import {createChatTask} from '../../public/chat-task.js';
import {bindModelSettings,modelSettingsButton} from '../../public/model-settings.js';
import {taskPreparationKey,pendingTaskPreparation,taskPreparationInput,taskPreparationControls,preparationNotice} from '../../public/task-preparation.js';
import {traceError,supportMessage,runtimeStatusCard} from '../../public/runtime-status.js';
import {createWorkspacePages,createPageDrafts,PAGE_NAMES,PAGE_ACTIONS} from '../../public/workspace-pages.js';
import {bindPageFinder} from '../../public/page-finder.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TASK_STATUS, taskTitle, activityText, executionActivity, systemText } from '../../public/task-presentation.js';
import { readableText, errorText, backgroundNote, fileLabel } from '../../public/user-copy.js';
import {uploadFormat,sourceExtension,documentExtension} from '../../public/document-formats.js';
import {modelControls,effortOptions} from '../../public/execution-selection.js';
import {usageCard,budgetCard} from '../../public/usage-presentation.js';
import {conflictCard,conflictTitle,readConflictChoice} from '../../public/conflict-presentation.js';
import {planEditor,taskPlanCards,revisionForm,stepNote} from '../../public/task-plan.js';
import {sourceBriefDialog} from '../../public/memory-view.js';
import {claimVersionDialog,claimComparison,metadataHistory} from '../../public/version-view.js';
import {claimEditor,sourceEditor,categoryFilter,AUTHORING_REQUESTS,pendingAuthoring,authoringRecovery} from '../../public/authoring.js';
import {captureResultForms,restoreResultForms} from '../../public/result-form-state.js';
import {createFileActions} from '../../public/file-actions.js';
import {taskChatReferenceField,chatReferenceCard,followupForm,conversationCard,currentQuestion,originalGoal} from '../../public/task-conversation.js';
import {resultSelectionRecovery,bindResultSelection,selectedResultNeedsReview} from '../../public/result-selection.js';
import {approvalDetails,questionAction,questionHelp,waitingLabel} from '../../public/operation-approval.js';
import {obsidianImportButton} from '../../public/obsidian-import.js';

// Render the real page template without requests, executors, or a browser session.
function page(view, executions = [], fixture = {}) {
  const app = { addEventListener() {}, querySelector(){return null;}, innerHTML: '' };
  const node = { addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} } };
  const sandbox = {
    obsidianImportButton,bindObsidianImport(){},connectionScreen,showStartupFailure,bindModelUsageReview,executionModelUsage,taskChatReferenceField,chatReferenceCard,createChatTask,bindModelSettings,modelSettingsButton,bindPageFinder,bindInputMethodGuard(){},createWorkspaceLayout(){return {capture(){},attach(){},clear(){}};},approvalDetails,questionAction,questionHelp,waitingLabel,
    taskPreparationKey,pendingTaskPreparation,taskPreparationInput,taskPreparationControls,preparationNotice,TASK_STATUS, taskTitle, activityText, executionActivity, systemText, readableText, errorText, backgroundNote, fileLabel, modelControls,usageCard,budgetCard,conflictCard,conflictTitle,readConflictChoice,uploadFormat,sourceExtension,documentExtension,planEditor,taskPlanCards,revisionForm,stepNote,followupForm,conversationCard,currentQuestion,originalGoal,
    traceError,supportMessage,runtimeStatusCard,createWorkspacePages,createPageDrafts,PAGE_NAMES,PAGE_ACTIONS,createFileActions,observeActions(){},captureResultForms,restoreResultForms,claimEditor,sourceEditor,categoryFilter,AUTHORING_REQUESTS,pendingAuthoring,authoringRecovery,sourceBriefDialog,claimVersionDialog,claimComparison,metadataHistory,resultSelectionRecovery,bindResultSelection,selectedResultNeedsReview,
    document: { querySelector: s => s === '#app' ? app : node, createElement: () => node,
      body: { append() {} }, addEventListener() {} },
    sessionStorage: { getItem: () => null },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    window: { addEventListener() {} },
    fetch:async()=>({ok:false,status:403,json:async()=>({code:'scope_denied'}),headers:{get(){return null;}}}),console
  };
  const code = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8')
    .replace(/^import .*?;\n/gm, '').replace(/^start\(\);$/m, '');
  if (fixture.connection) return vm.runInNewContext(code + '\nstart();', sandbox).then(() => app.innerHTML);
  vm.runInNewContext(code + `\nview=${JSON.stringify(view)};
    scope={projectId:'fixture',versionId:null,branchId:null};
    projects=[{scope,name:'合成项目'}];capabilities=${JSON.stringify(fixture.capabilities||{executors:[]})};
    state={facts:[],decisions:[],failures:[],lessons:[],pending:[],conflicts:[]};
    history={executions:${JSON.stringify(executions)},events:[],claims:[],sources:[],results:[],runs:[],totals:{claims:0}};
    Object.assign(state,${JSON.stringify(fixture.state||{})});
    Object.assign(history,${JSON.stringify(fixture.history||{})});
    prepared=${JSON.stringify(fixture.prepared||null)};
    render();`, sandbox);
  return app.innerHTML;
}

test('步骤记录保留历史而不冒充成功，原任务可展开且技术正文不进入页面',()=>{
 const events=[{stage:'planning',label:'正在整理执行步骤',at:'2026-10-15T01:00:00Z'},{stage:'tool_failed',label:'这一步未完成，已有内容仍保留',at:'2026-10-15T01:01:00Z'}];
 const html=page('task',[{goal:'整理项目报告',operation:{id:'activity-task',status:'failed'},questions:[],activity:events}]);
 assert.match(html,/步骤记录/);assert.match(html,/data-ai-action="view_execution_steps"/);assert.match(html,/执行记录：整理执行步骤/);assert.doesNotMatch(html,/正在整理执行步骤/);assert.match(html,/这一步未完成/);
 const active=page('task',[{goal:'整理项目报告',operation:{id:'activity-task',status:'running'},questions:[],activity:[...events,{stage:'exporting',label:'正在生成文件',at:'2026-10-15T01:02:00Z'}]}]);
 assert.doesNotMatch(active,/正在整理执行步骤/);assert.equal((active.match(/正在生成文件/g)||[]).length,1,'only the latest live status uses the present tense');
});

test('任务页优先新任务、历史默认折叠，长目标仍可完整展开', () => {
  const goal = '需要处理中文😀项目记录并生成文档。'.repeat(12);
  const html = page('task', [{ goal, operation: { id: 'old', status: 'succeeded' },
    activity: [{ label: '正在保存成果' }], questions: [] }]);
  assert.ok(html.indexOf('id="task-form"') < html.indexOf('id="execution-panel"'));
  assert.match(html, /<details><summary>已结束的任务 · 1/);
  assert.match(html, /执行结束/);
  assert.ok(!html.includes('正在保存成果'));
  assert.match(html, /执行记录：保存成果/);
  assert.ok(html.includes(goal), '完整目标保留在任务详情');
  assert.ok(Array.from(html.match(/<h3>(.*?)<\/h3>/s)[1]).length <= 37);
});

test('结束和未知步骤不冒充仍在运行，也不冒充步骤成功', () => {
  for (const status of ['succeeded', 'failed', 'cancelled', 'unknown']) {
    assert.equal(activityText({ label: '正在保存成果' }, status), '执行记录：保存成果');
  }
  assert.equal(activityText({ label: '正在保存成果' }, 'running'), '正在保存成果');
  assert.equal(TASK_STATUS.unknown, '执行待核对');
  assert.equal(TASK_STATUS.failed, '未完成');
  for (const status of ['succeeded', 'failed', 'cancelled']) {
    const html = page('task', [{ goal: '终态停止提示', operation: { id: 'old', status },
      activity: [], questions: [], cancelRequested: true }]);
    assert.match(html, /执行记录：曾请求停止。/);
    assert.ok(!html.includes('等待执行工具确认'));
  }
  const running = page('task', [{ goal: '待确认停止', operation: { id: 'running', status: 'running' },
    activity: [], questions: [], cancelRequested: true }]);
  assert.match(running, /已请求停止，等待工具确认。/);
  const paused={goal:'连接中断后的原问题',operation:{id:'paused',status:'unknown'},run:{executorOwner:'synplex'},questions:[{status:'unavailable'}]};
  assert.match(page('task',[paused],{capabilities:{executors:[{owner:'synplex',mode:'platform_owned',inputRecovery:true}]}}),/data-ai-action="reconnect_input"/);
  assert.ok(!page('task',[paused],{capabilities:{executors:[{owner:'synplex',inputRecovery:false}]}}).includes('data-ai-action="reconnect_input"'));
});

test('目标标题按字符缩短，不拆emoji，不能改变完整目标', () => {
  const goal = '😀'.repeat(50);
  assert.equal(taskTitle(goal), '😀'.repeat(36) + '…');
  assert.equal(taskTitle('  第一行\n第二行  '), '第一行 第二行');
  assert.equal(goal.length, 100);
});

test('已保存的型号和思考程度失效时要求重选，不静默改成首项',()=>{
 const executors=[{owner:'codex',selectionChoices:[{id:'available',label:'可用型号',efforts:['low','high']}]}],draft={executor:'codex',model:'retired',effort:'removed'};
 const html=modelControls(executors,draft);assert.equal(draft.model,'retired');assert.equal(draft.effort,'removed');assert.match(html,/原型号已不可用，请重新选择/);assert.match(html,/原思考程度已不可用，请重新选择/);assert.equal((html.match(/required/g)||[]).length,2);
 assert.equal(modelControls(executors,draft),html,'重复渲染不能把无效选择当成空草稿');
 draft.model='available';const validModel=modelControls(executors,draft);assert.equal(draft.effort,'removed');assert.match(validModel,/原思考程度已不可用/);
 draft.effort='high';assert.ok(!modelControls(executors,draft).includes('data-unavailable'));
 const initial={executor:'codex',model:'',effort:''};modelControls(executors,initial);assert.deepEqual(initial,{executor:'codex',model:'available',effort:'low'});
 assert.match(effortOptions(['low','max'],'high'),/value="" disabled selected data-unavailable/);assert.ok(!effortOptions(['low','max'],'max').includes('data-unavailable'));
});

test('系统提示统一任务说明，但历史目标与模型原文不重写', () => {
  assert.equal(systemText('工作说明已保留，查询原工作，不重复提交。'), '任务说明已保留，查看原任务，不重复提交。');
  const goal = '原始用户目标：让助理读取工作说明。';
  const html = page('task', [{goal, operation:{id:'old',status:'failed'},questions:[],activity:[]}]);
  assert.ok(html.includes(goal));
  assert.equal(activityText({label:'正在处理这次工作'},'running'), '正在处理这次任务');
});

test('固定导航、状态和确认按钮名称不引入助理实体', () => {
  for (const view of ['progress', 'task', 'materials', 'history', 'results', 'connect', 'review']) {
    const html = page(view);
    assert.ok(!html.includes('助理'));
    assert.match(html, /data-nav="task"[^>]*>.*?任务<\/button>/);
  }
  const code = readFileSync(new URL('../../public/app.js', import.meta.url), 'utf8');
  assert.match(code, /data-status="confirmed">确认/);
  assert.ok(!code.includes('常用工具'));
});


test('技术任务标题不暴露调用片段，完整目标和复制内容仍保全', () => {
  const goal='读取已安装 Synplex 插件 Skill 后，用 get_project_state、find_evidence 查看项目，prepare_task 后继续。';
  const prepared={packet:{goal,facts:[],failures:[],lessons:[],unknowns:[],acceptanceCriteria:['保留原文依据']},run:{id:'prepared-fixture',status:'prepared',mode:'host_assist'}};
  const html=page('task',[],{prepared});
  const title=html.match(/<h2>(.*?)<\/h2>/s)[1];
  assert.match(title,/查看项目进展/);
  assert.ok(!/Skill|get_project|find_evidence|prepare_task/.test(title));
  assert.ok(html.includes(goal),'完整目标没有重写');
  assert.match(html,/value="current_host"[^>]*>复制到其他工具/);
  assert.match(html,/name="maxInputTokens"/);
  assert.match(html,/复制说明/);
  assert.match(taskTitle('不得调用 get_project_state 修改任何内容'),/不得/);
  assert.equal(readableText('本次采购超过预算，不允许增加预算。'),'本次采购超过预算，不允许增加预算。');
});

test('资料、记录、成果与选项预览使用中文，原文和操作身份保持', () => {
  const raw='const task_state = get_project_state();';
  const claim={id:'claim1',body:raw,title:raw,type:'decision',reviewStatus:'confirmed',lifecycle:'active',evidence:[{sourceId:'source1',occurrenceId:'event1'}]};
  const record=page('history',[],{history:{claims:[claim]}});
  assert.ok(!record.match(/<h3>(.*?)<\/h3>/s)[1].includes('task_state'));
  assert.ok(record.includes(raw));
  const materials=page('materials',[],{history:{sources:[{id:'source1',byteLength:10}],claims:[claim]}});
  assert.ok(!materials.match(/<h3>(.*?)<\/h3>/s)[1].includes('task_state'));
  assert.match(materials,/data-id="source1"/);
  assert.match(fileLabel('plugin-check-revised.md'),/扩展检查（修订版）/);
  assert.notEqual(fileLabel('下一步清单.pdf'),fileLabel('下一步清单.md'));
  assert.equal(readableText('已确认选择'),'已确认的决定');
  const result={id:'r1',summary:raw,trust:'host_reported',usage:{costUsd:null},checks:[],artifacts:[]};
  const results=page('results',[],{history:{results:[result]}});
  assert.ok(!results.match(/<h3>(.*?)<\/h3>/s)[1].includes('task_state'));
  assert.ok(results.includes(raw));assert.match(results,/费用未知/);
  const prompt={questions:[{id:'format',question:'请用 requestId 说明 API 设置',isOther:true,options:[{label:'Markdown',description:'以 JSON 格式返回'}]}]};
  const question=page('task',[{goal:'继续项目',operation:{id:'op',status:'running'},questions:[{id:'q1',status:'pending',prompt}],activity:[]}]);
  assert.match(question,/value="Markdown"/);assert.match(question,/可编辑的文字文件/);
  assert.match(question,/完整问题（原文）/);assert.ok(question.includes(prompt.questions[0].question));
});

test('断线、格式异常与九类服务错误给出中文动作，不建议重复执行', () => {
  for(const code of ['validation_failed','scope_denied','conflict','stale_context','budget_exceeded','capability_unavailable','unsupported_format','partial_parse','writeback_pending']){
    const text=errorText({code,message:'RPC API metadata requestId sqlite JSON error'});
    assert.ok(!/RPC|API|metadata|requestId|sqlite|JSON/.test(text));
    assert.match(text,/[\p{Script=Han}]/u);
  }
  assert.match(errorText(new TypeError('Failed to fetch')),/不要重复提交/);
  assert.match(errorText(new SyntaxError('Unexpected token in JSON')),/无法读取/);
  assert.match(errorText({code:'writeback_pending'}),/只补存结果，不要重新执行/);
  const id='09e2c932-2849-47bb-a45b-951b204d8820',failure=traceError(new Error('请求未完成'),{headers:new Headers({'X-Synplex-Trace-Id':id})});
  assert.match(supportMessage(failure,errorText(failure)),new RegExp(id));
  assert.equal(traceError(new Error('请求未完成'),{headers:new Headers({'X-Synplex-Trace-Id':'never-show-secret'})}).supportId,undefined);
  const card=runtimeStatusCard('task',{executionStatus:{observedAt:'2026-10-15T00:00:00Z',counts:{total:2,unknown:1,queued:1,observationExpired:0,answersUnconfirmed:1,writebackPending:1}}},x=>String(x),x=>x);
  assert.match(card,/结果待核对/);assert.match(card,/只补存结果/);assert.ok(!card.includes('<dt>已停止</dt>'));
  const html=page('task',[{goal:'任务',operation:{id:'op',status:'failed',error:{code:'scope_denied',message:'scope tokenFile'}},activity:[],questions:[]}]);
  assert.match(html,/没有访问权限/);assert.ok(!html.includes('tokenFile'));
});

test('扩展页先给中文安装步骤，必要命令只在技术说明内，工具名不改', () => {
  const html=page('connect');
  assert.match(html,/下载安装包/);assert.match(html,/安装命令（供技术人员使用）/);
  assert.match(html,/codex plugin add synplex-workspace@synplex-workspace-local/);
  assert.match(html,/data-action="extension" data-id="codex"/);
  assert.match(html,/data-action="extension" data-id="dsh"/);
  assert.ok(!html.includes('0.2.0-rc.2'));
});


test('未连接页面与加载入口给出中文引导，刷新命令在技术说明中', async () => {
  const html=await page('connection',[],{connection:true});
  assert.match(html,/连接码/);assert.match(html,/已有任务不需要重新开始/);
  assert.match(html,/<details><summary>刷新命令（供技术人员使用）/);
  assert.match(html,/SYNPLEX_WORKSPACE_DATA_DIR=你的数据目录 npm run connect:workspace/);
  assert.ok(!html.includes('正式密钥'));
  const index=readFileSync(new URL('../../public/index.html',import.meta.url),'utf8');
  assert.match(index,/正在打开项目…/);
});
