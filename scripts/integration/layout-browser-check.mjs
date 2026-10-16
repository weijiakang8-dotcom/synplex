import assert from 'node:assert/strict';
import {join} from 'node:path';

// Called by the existing approval/continuation scenario, not a second execution.
export async function checkWorkspaceLayout(page,evidence){
 await page.setViewportSize({width:1440,height:1000});
 const left=page.locator('[data-layout-resize=navigation]'),right=page.locator('[data-layout-resize=task]');
 const question=page.locator('.question-form'),radio=question.locator('input[value="拒绝操作"]');
 await page.locator('.shell.layout-split').waitFor();
 assert.equal(await page.locator('#task-progress .question-form').count(),1);
 assert.equal(await page.locator('#page-panel .question-form').count(),0);
 await radio.check();await radio.evaluate(element=>element.dataset.layoutFixture='same-node');
 await left.focus();await left.press('ArrowRight');assert.equal(await left.getAttribute('aria-valuenow'),'238');
 await right.focus();await right.press('ArrowLeft');assert.equal(await right.getAttribute('aria-valuenow'),'380');
 for(const [handle,delta] of [[left,40],[right,-50]]){
  const rect=await handle.boundingBox();await page.mouse.move(rect.x+rect.width/2,rect.y+80);await page.mouse.down();
  await page.mouse.move(rect.x+rect.width/2+delta,rect.y+80,{steps:5});await page.mouse.up();
 }
 assert.equal(await left.getAttribute('aria-valuenow'),'278');assert.equal(await right.getAttribute('aria-valuenow'),'430');
 const widths=await page.locator('#workspace-main').boundingBox();assert.ok(widths.width>=420);
 await page.locator('[data-layout-action=toggle_task_progress]').click();
 assert.equal(await page.locator('#page-panel .question-form').count(),1);assert.equal(await radio.isChecked(),true);
 await page.locator('[data-layout-action=toggle_task_progress]').click();
 assert.equal(await page.locator('#task-progress .question-form').count(),1);assert.equal(await radio.getAttribute('data-layout-fixture'),'same-node');
 await page.locator('[data-layout-action=toggle_navigation]').click();assert.equal(await left.isVisible(),false);
 assert.equal(await page.locator('[data-layout-action=toggle_navigation]').getAttribute('aria-expanded'),'false');
 await page.locator('[data-layout-action=toggle_navigation]').click();assert.equal(await left.isVisible(),true);
 await page.locator('#task-progress').evaluate(element=>element.scrollTop=140);
 const progressTop=await page.locator('#task-progress').evaluate(element=>element.scrollTop);assert.ok(progressTop>0);
 await page.locator('nav [data-nav=materials]').click();assert.equal(await page.locator('#collaboration-panel').isVisible(),true);
 await page.locator('[role=tab][data-id=task]').click();await question.waitFor();
 assert.ok(Math.abs(await page.locator('#task-progress').evaluate(element=>element.scrollTop)-progressTop)<2);
 assert.equal(await radio.isChecked(),true);
 await page.screenshot({path:join(evidence,'任务布局-桌面.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});
 await page.locator('#page-panel .question-form').waitFor();
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 assert.equal(await left.isVisible(),false);assert.equal(await right.isVisible(),false);
 assert.equal(await page.locator('#page-panel .question-form').count(),1);
 assert.equal(await radio.isChecked(),true);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(evidence,'任务布局-手机原屏.png'),fullPage:false,animations:'disabled'});
 await page.screenshot({path:join(evidence,'任务布局-手机全页.png'),fullPage:true,animations:'disabled'});
 assert.equal(await page.locator('#workspace-navigation').count(),1);assert.equal(await page.locator('#task-form').count(),1);
 await page.setViewportSize({width:1180,height:900});await page.locator('.layout-split').waitFor();
 assert.ok((await page.locator('#workspace-main').boundingBox()).width>=420);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1440,height:1000});await right.press('End');assert.equal(await right.getAttribute('aria-valuenow'),'520');
 await left.press('Home');assert.equal(await left.getAttribute('aria-valuenow'),'180');
 await left.press('Enter');await right.press('Enter');
 assert.equal(await left.getAttribute('aria-valuenow'),'218');assert.equal(await right.getAttribute('aria-valuenow'),'360');
 await radio.evaluate(element=>{element.checked=false;});await page.reload();await question.waitFor();
 assert.equal(await left.getAttribute('aria-valuenow'),'218');assert.equal(await right.getAttribute('aria-valuenow'),'360');
 const semantic=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');return {
  actions:availableOperations().filter(x=>x.role==='separator'),
  ambiguous:[...document.querySelectorAll('[data-ai-state=ambiguous]')].map(x=>x.dataset.aiId),
 };});
 assert.deepEqual(semantic.actions.map(x=>x.action).sort(),['resize_navigation','resize_task']);assert.deepEqual(semantic.ambiguous,[]);
 await page.setViewportSize({width:390,height:844});
 return {desktopPointerAndKeyboardResize:true,minimumCenterWidth:420,sameQuestionNodeAndSelection:true,
  narrowLayoutFallback:true,settingsSurviveReload:true,progressPositionAndAnswerSurviveTabSwitch:true,semanticResizeActions:true,extraExecutions:0};
}
