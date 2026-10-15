import test from 'node:test';
import assert from 'node:assert/strict';
import {executionContextView} from '../../adapters/execution/context-view.mjs';

test('every raw quotation carries its actual use; mixed and historical sources do not inherit confirmation',()=>{
 const span=(start,quote)=>({sourceId:'same-source',start,quote});
 const fact=span(0,'Adopted one line'),pending=span(17,'Pending other line'),history=span(0,'Adopted one line\nRejected claim from same source');
 const packet={goal:'Keep all requirements',facts:[{evidence:[fact]}],failures:[],lessons:[],candidates:[{evidence:[pending]}],evidence:[fact,pending,history],constraints:['Do not alter source'],unknowns:['rejected history'],contentHash:'original-fingerprint'};
 const view=executionContextView(packet);
 assert.match(view.evidence[0].materialUse,/已确认/);assert.match(view.evidence[1].materialUse,/待核对/);assert.match(view.evidence[2].materialUse,/仅供回看/);
 assert.deepEqual(view.evidence.map(({materialUse,...raw})=>raw),packet.evidence);assert.deepEqual(view.facts,packet.facts);assert.equal(view.contentHash,packet.contentHash);assert.ok(!packet.evidence[0].materialUse);
});
