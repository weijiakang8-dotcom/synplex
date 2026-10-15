import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createCodexExecutor} from '../../adapters/execution/codex.mjs';

test('Codex unknown receipt is recovered from the exact stored turn, without a model turn or forged usage',async t=>{
 const root=mkdtempSync(join(tmpdir(),'synplex-codex-read-')),operationId=randomUUID(),attemptId=randomUUID();
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,operationId);mkdirSync(join(dir,'workspace'),{recursive:true});writeFileSync(join(dir,'workspace','output.md'),'# Real local bytes');
 const record={operationId,attemptId,threadId:'exact-thread',turnId:'exact-turn',model:'original-model',provider:'original-provider',receipt:null};
 const journal=join(dir,'executor.json');writeFileSync(journal,JSON.stringify(record),{mode:0o600});let status='inProgress',calls=[],closed=0;
 const adapter=createCodexExecutor({binary:'/fixture/codex',home:'/fixture/home',dataDir:root,model:'changed-model',provider:'changed-provider',rpcFactory:()=>({async connect(){},async call(method,params){calls.push(method);assert.equal(method,'thread/read');assert.deepEqual(params,{threadId:'exact-thread',includeTurns:true});return {thread:{id:'exact-thread',turns:[{id:'other-turn',status:'completed',items:[{type:'agentMessage',text:'Wrong result'}]},{id:'exact-turn',status,items:[{type:'reasoning',content:'Never expose this'},{type:'agentMessage',phase:'commentary',text:'Interim'},{type:'agentMessage',text:'Original final'}]}]}};},close(){closed++;}})});
 assert.equal(await adapter.lookup({operationId,attemptId}),null);status='completed';
 const result=await adapter.lookup({operationId,attemptId});assert.equal(result.status,'succeeded');assert.equal(result.result.summary,'Original final');assert.equal(result.result.usage.costUsd,null);assert.equal(result.result.usage.inputTokens,null);assert.equal(result.result.usage.model,'original-model');assert.equal(result.files[0].bytes.toString(),'# Real local bytes');
 await adapter.lookup({operationId,attemptId});assert.deepEqual(calls,['thread/read','thread/read']);assert.equal(closed,2);assert.ok(JSON.parse(readFileSync(journal)).receipt);
});
