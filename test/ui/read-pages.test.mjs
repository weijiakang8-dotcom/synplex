import test from 'node:test';
import assert from 'node:assert/strict';
import {readPage} from '../../public/read-pages.js';
test('expired read positions reset one bounded page; writes and unknown failures are never retried',async()=>{
 const calls=[];
 const result=await readPage(async(path,body)=>{calls.push([path,body]);if(body.cursor)throw Object.assign(Error(),{status:409,code:'stale_context'});return {items:['current'],cursor:null};},'ui_pending_page','expired');
 assert.deepEqual(calls,[['ui_pending_page',{cursor:'expired'}],['ui_pending_page',{cursor:null}]]);
 assert.equal(result.reset,true);assert.deepEqual(result.items,['current']);
 for(const status of [403,500]){let count=0;await assert.rejects(readPage(async()=>{count++;throw Object.assign(Error(),{status,code:'stale_context'});},'ui_pending_page','old'));assert.equal(count,1);}
});
