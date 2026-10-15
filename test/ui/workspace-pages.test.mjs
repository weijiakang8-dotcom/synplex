import {taskPreparationKey,pendingTaskPreparation,taskPreparationControls,taskPreparationInput,preparationNotice} from '../../public/task-preparation.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspacePages,PAGE_NAMES} from '../../public/workspace-pages.js';

test('页面状态只允许既有页面、逐项目隔离；固定/关闭/重开/刷新和损坏存储不新建任务',()=>{
 const entries=new Map(),storage={getItem:k=>entries.get(k),setItem:(k,v)=>entries.set(k,v),removeItem:k=>entries.delete(k)};
 const a={projectId:'a',versionId:null,branchId:null},b={...a,projectId:'b'},pages=createWorkspacePages(storage);
 assert.equal(pages.current(a),'progress');pages.open(a,'materials');pages.open(a,'task');pages.open(a,'materials');
 assert.equal(pages.current(b),'progress');
 pages.act(a,'pin-page','materials');pages.act(a,'close-page','materials');assert.equal(pages.current(a),'materials');
 pages.act(a,'close-other-pages','materials');const html=pages.markup(a,x=>x);
 assert.ok(!html.includes('page-tab-task'));assert.match(html,/page-tab-progress/);assert.match(html,/page-tab-materials/);
 assert.equal(createWorkspacePages(storage).current(a),'materials');
 pages.act(a,'pin-page','materials');pages.act(a,'close-page','materials');assert.equal(pages.current(a),'progress');
 pages.act(a,'pin-page','progress');pages.act(a,'close-page','progress');assert.equal(pages.current(a),'progress','关闭最后一页仍有项目入口');
 assert.equal(pages.open(a,'__proto__'),'progress');assert.equal(pages.open(a,'assistant'),'progress');assert.equal(Object.keys(PAGE_NAMES).length,8);
 pages.clear();assert.equal(entries.size,0);
 const damaged=createWorkspacePages({getItem:()=>'{',setItem:()=>{throw Error('full');},removeItem(){}});
 assert.equal(damaged.current(a),'progress');assert.equal(damaged.open(a,'task'),'task');assert.equal(damaged.current(a),'task');
 const corrupt=createWorkspacePages({getItem:()=>JSON.stringify({items:[null,{id:'results'},{id:'results'},{id:'unknown'}],active:'absent'}),setItem(){},removeItem(){}});
 assert.equal(corrupt.current(a),'results');assert.equal((corrupt.markup(a,x=>x).match(/role="tab"/g)||[]).length,1);
});


test('准备任务的待核对提交逐项目保留；损坏记录禁止静默重建，后续草稿不替代原意图',()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)},scope={projectId:'a',versionId:null,branchId:null},other={...scope,projectId:'b'};
 const data=new FormData();for(const [k,v] of Object.entries({goal:'原目标',constraints:'不外发\n不删除',acceptance:'报告\n出处',executor:'synplex',maxInputTokens:'24000',model:'fixture',effort:'high'}))data.set(k,v);data.append('occurrence','original-event');
 const input=taskPreparationInput(data);assert.equal(input.mode,'platform_owned');assert.deepEqual(input.executionOptions,{model:'fixture',effort:'high'});assert.deepEqual(input.selectedOccurrenceIds,['original-event']);
 const saved={current:{scope,...input},intent:{scope,...input,requestId:'original-request',expectedStateRevision:4}};values.set(taskPreparationKey(scope),JSON.stringify(saved));data.set('goal','新草稿');
 assert.equal(pendingTaskPreparation(storage,scope).intent.goal,'原目标');assert.equal(pendingTaskPreparation(storage,other),null);assert.equal(taskPreparationControls(storage,scope).attributes,'novalidate');assert.equal(taskPreparationControls(storage,other).label,'准备任务');
 assert.match(preparationNotice(storage,scope,x=>x),/不会另建任务/);values.set(taskPreparationKey(scope),'{');assert.equal(pendingTaskPreparation(storage,scope).invalid,true);assert.match(preparationNotice(storage,scope,x=>x),/不会再创建一份/);assert.equal(values.get(taskPreparationKey(scope)),'{');
});
