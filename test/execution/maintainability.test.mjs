import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeSource,dependencyCycles,checkBudget} from '../../scripts/quality/maintainability.mjs';
import {checkModuleLinks} from '../../scripts/quality/module-links.mjs';

test('结构测量解析真实语法，嵌套函数独立计数，字符串不算分支，新增复杂度和循环被门禁拦截',()=>{
 const report=analyzeSource(`export function task(x=1){if(x>1&&x<4){}const inner=()=>x?1:0;try{for(const item of []){}}catch{}return x?.value??0;}const text="if while && ?";import './other.mjs';`,'fixture.mjs');
 assert.equal(report.functions.find(f=>f.id==='fixture.mjs::module/task').complexity,8);
 assert.equal(report.functions.find(f=>f.id==='fixture.mjs::module/task/inner').complexity,2);
 assert.equal(report.functions.find(f=>f.id==='fixture.mjs::module').complexity,1);assert.deepEqual(report.imports,['./other.mjs']);
 assert.deepEqual(dependencyCycles({a:['b'],b:['a'],c:['c'],d:[]}),[['a','b'],['c']]);
 const budget={defaultMaximum:3,exceptions:{},cycles:[]},actual={functions:report.functions,cycles:[['a','b']],unresolved:[]};
 const problems=checkBudget(actual,budget);assert.equal(problems[0].complexity,8);assert.deepEqual(problems[1],{newCycle:['a','b']});
 assert.deepEqual(checkBudget(actual,{...budget,exceptions:{'fixture.mjs::module/task':8},cycles:[['a','b']]}),[]);
});

test('静态模块门不执行代码即拦截缺失命名/默认导入、错误转导出和歧义星导出，允许同绑定别名与循环',()=>{
 const sources=new Map([
  ['/fixture/a.js',`throw Error('MUST NEVER EXECUTE');export const {value:real}= {value:1};export default function work(){};`],
  ['/fixture/b.js',`export {real as alias} from './a.js';export * from './a.js';export * as tools from './a.js';`],
  ['/fixture/c.js',`import first,{alias,tools} from './b.js';import {missing} from './a.js';export {gone} from './a.js';`],
  ['/fixture/d.js',`export const real=2;`],
  ['/fixture/ambiguous.js',`export * from './a.js';export * from './d.js';`],
  ['/fixture/check.js',`import {real} from './ambiguous.js';import './absent.js';`],
 ]);
 const problems=checkModuleLinks(sources);
 assert.deepEqual(problems.map(p=>[p.source,p.name,p.reason]),[
  ['./b.js','default','missing-export'],['./a.js','missing','missing-export'],['./a.js','gone','missing-export'],
  ['./absent.js',undefined,'missing-module'],['./ambiguous.js','real','ambiguous-export'],
 ]);
 sources.set('/fixture/c.js',`import base from './a.js';import {alias,tools} from './b.js';export {alias as again};`);
 sources.set('/fixture/d.js',`export {real} from './a.js';`);
 sources.set('/fixture/check.js',`import {real} from './ambiguous.js';`);
 sources.set('/fixture/cycle1.js',`export * from './cycle2.js';export const own=1;`);
 sources.set('/fixture/cycle2.js',`export * from './cycle1.js';import {own} from './cycle1.js';`);
 assert.deepEqual(checkModuleLinks(sources),[]);
});
