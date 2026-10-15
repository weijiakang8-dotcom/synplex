import test from 'node:test';
import assert from 'node:assert/strict';
import {bindInputMethodGuard} from '../../public/input-method.js';

test('输入法守卫不堵其他表单，确认键松开或明确点击后可继续，结束保护有限时且可解绑',()=>{
 const handlers=new Map(),document={addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:name=>handlers.delete(name)};
 const form=()=>({elements:[],matches:selector=>selector==='form'}),a=form(),b=form();
 const input=form=>{const element={form,closest:()=>element};form.elements.push(element);return element;};
 const first=input(a),second=input(b);let time=100;
 const dispose=bindInputMethodGuard(document,{now:()=>time});
 function fire(type,target,props={}){
  const event={target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...props};
  handlers.get(type)(event);return event;
 }
 fire('compositionstart',first);assert.equal(fire('submit',a).prevented,true);assert.equal(fire('submit',b).prevented,false);
 assert.equal(fire('keydown',second,{key:'Enter'}).stopped,false);
 fire('compositionend',first);assert.equal(fire('keydown',first,{key:'Enter'}).prevented,true);
 fire('keyup',first,{key:'Enter'});assert.equal(fire('submit',a).prevented,false);
 fire('compositionend',first);time+=101;assert.equal(fire('keydown',first,{key:'Enter'}).prevented,false);
 fire('keydown',first,{key:'Enter',keyCode:229});
 const button={form:a,closest(){return this;}};fire('pointerdown',button);assert.equal(fire('submit',a).prevented,false);
 dispose();assert.equal(handlers.size,0);
});
