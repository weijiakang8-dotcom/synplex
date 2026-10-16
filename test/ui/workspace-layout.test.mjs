import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutGeometry} from '../../public/workspace-layout.js';

test('分栏只在足够宽且存在任务时开启，极端宽度设置仍为正文保留操作空间',()=>{
 for(const width of [390,900,901,959,960,1024,1179,1180,1440,2560])for(const collapsed of [false,true]){
  const value={navigation:999999,task:999999,collapsed,taskOpen:true};
  const size=layoutGeometry(width,value,true);
  assert.equal(size.split,width>=960);
  if(size.split)assert.ok(width-size.navigation-size.task-(collapsed?6:12)>=420);
  assert.ok(size.task>=280&&size.task<=520);
  assert.equal(layoutGeometry(width,value,false).split,false);
  assert.equal(layoutGeometry(width,{...value,taskOpen:false},true).split,false);
 }
 assert.equal(layoutGeometry(1440,{navigation:-1,task:-1,collapsed:false,taskOpen:true},true).navigation,180);
 assert.equal(layoutGeometry(1440,{navigation:-1,task:-1,collapsed:false,taskOpen:true},true).task,280);
});
