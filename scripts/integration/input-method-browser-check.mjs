import assert from 'node:assert/strict';
import {join} from 'node:path';

export async function checkInputMethod(page,evidence,scope){
 let submissions=0;
 const onRequest=request=>{if(request.method()==='POST'&&request.url().endsWith('/api/v1/ui_create_project'))submissions++;};
 page.on('request',onRequest);
 const client=await page.context().newCDPSession(page);
 try{
  await page.locator('[data-nav=new-project]').click();
  const input=page.locator('#project-form input[name=name]');await input.fill('输入法保护测试');await input.focus();
  await page.evaluate(()=>{
   globalThis.imeObservations=[];globalThis.allowedImeSubmissions=0;
   for(const type of ['compositionstart','compositionend','keydown'])document.addEventListener(type,event=>{
    if(event.target.matches('#project-form input'))globalThis.imeObservations.push({type,isComposing:event.isComposing===true,keyCode:event.keyCode??null});
   },true);
   document.querySelector('#project-form').addEventListener('submit',()=>globalThis.allowedImeSubmissions++);
  });
  await client.send('Input.imeSetComposition',{text:'nihao',selectionStart:5,selectionEnd:5});
  assert.ok(await page.evaluate(()=>imeObservations.some(event=>event.type==='compositionstart')));
  // A browser-driven composition, including an implicit form submit during it.
  await page.locator('#project-form').evaluate(form=>form.requestSubmit());
  assert.equal(await page.evaluate(()=>allowedImeSubmissions),0);assert.equal(submissions,0);
  await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
  assert.equal(submissions,0);
  await client.send('Input.insertText',{text:'你好'});
  await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:36});
  assert.ok(await input.inputValue());
  assert.ok(await page.evaluate(()=>imeObservations.some(event=>event.type==='compositionend')));
  assert.equal(await page.evaluate(()=>allowedImeSubmissions),0);assert.equal(submissions,0);
  // Safari compatibility ordering: composition ended; confirmation key is 229.
  await input.evaluate(element=>{
   element.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
   element.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'你好'}));
   element.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:229,bubbles:true,cancelable:true}));
   element.form.requestSubmit();
   element.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,cancelable:true}));
  });
  assert.equal(await page.evaluate(()=>allowedImeSubmissions),0);assert.equal(submissions,0);
  await input.fill('输入法确认后再创建');
  const accepted=page.waitForResponse(response=>response.url().endsWith('/api/v1/ui_create_project'));
  await input.press('Enter');assert.equal((await accepted).status(),200);
  await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='输入法确认后再创建');assert.equal(submissions,1);
  await page.screenshot({path:join(evidence,'输入法确认后提交-手机.png'),fullPage:false});
  await page.locator('#project-select').selectOption(scope.projectId);
  await page.waitForFunction(project=>document.querySelector('#project-select')?.value===project&&document.querySelector('#app')?.getAttribute('aria-busy')==='false',scope.projectId);
  await page.locator('[data-action=close-page][data-id=new-project]').click();
  return {chromiumCompositionProtocol:true,liveCompositionImplicitSubmitBlocked:true,confirmationEnterBlocked:true,
   safari229OrderingFixture:true,intentionalEnterCreatesOneProject:true,modelCalls:0,nativeMacImeVerified:false};
 }finally{page.off('request',onRequest);await client.detach();}
}
