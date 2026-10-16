import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,unlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ModelVault} from '../../services/workspace/model-vault.mjs';
import {ModelService} from '../../services/workspace/model-service.mjs';
import {publicAddress,resolvePublic} from '../../services/workspace/model-network.mjs';
import {validateConnection,validateEndpoint} from '../../services/workspace/model-contract.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {ModelRelayStore} from '../../services/workspace/model-relay-store.mjs';
import {parseProxyDnsReply,resolveProxyHostname} from '../../services/workspace/model-dns.mjs';
import {ModelConnectionError,modelConnectionFailure} from '../../services/workspace/model-error.mjs';
import {MODEL_CONNECTION_MESSAGES} from '../../public/model-feedback.js';
import {safeError} from '../../services/workspace/service.mjs';
import {errorText} from '../../public/user-copy.js';

const config={name:'我的模型',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:256,models:[{id:'example-model',name:'标准型号',pricing:{validFrom:'2026-01-01T00:00:00Z',validUntil:null,inputUsdPerMillion:1,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:2,source:'synthetic-snapshot-price'},capabilities:{tools:true,stream:true,efforts:['low','high'],contextWindow:32000}}]};
const secret='synthetic-test-key-never-a-real-credential';
const alice={ownerId:'one',actorId:'alice'},bob={ownerId:'one',actorId:'bob'},eve={ownerId:'two',actorId:'alice'};
test('model vault preserves owner boundaries, encrypted revisions, intent receipts and inflight holds',()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-model-')),db=new DatabaseSync(join(dir,'workspace.sqlite'));
  try{
    const vault=new ModelVault(db,dir),input={requestId:'save-one',config,secret};
    const saved=vault.save(alice,input);
    assert.deepEqual(vault.save(alice,input),saved);
    assert.throws(()=>vault.save(alice,{...input,secret:secret+'changed'}),/内容发生/);
    assert.equal(JSON.stringify(saved).includes(secret),false);
    assert.equal(readFileSync(join(dir,'workspace.sqlite')).includes(Buffer.from(secret)),false);
    assert.equal(vault.list(bob).length,0);assert.equal(vault.list(eve).length,0);
    assert.throws(()=>vault.save(bob,{requestId:'steal',id:saved.id,revision:1,config,secret}),/管理权限/);
    const choice={connectionId:saved.id,model:'example-model',effort:'high'};
    const held=vault.acquire(alice,choice,'task-one',{tools:true});
    assert.equal(held.secret,secret);assert.equal(held.binding.model,'example-model');assert.equal(held.binding.effort,'high');
    assert.throws(()=>vault.change(alice,{requestId:'disable',id:saved.id,revision:1,action:'disable'}),/仍有任务/);
    assert.throws(()=>vault.acquire(bob,choice,'task-two'),/不可用/);
    assert.throws(()=>vault.acquire(alice,{...choice,effort:'max'},'task-two'),/思考程度/);
    vault.release(alice,'task-one');
    const rotated=vault.save(alice,{...input,requestId:'rotate',id:saved.id,revision:1,secret:secret+'new'});
    assert.equal(rotated.revision,2);
    assert.equal(vault.acquire(alice,choice,'task-three').secret,secret+'new');vault.release(alice,'task-three');
    assert.throws(()=>vault.acquire(alice,choice,'task-one'),/原任务/);
    const disabled=vault.change(alice,{requestId:'disable',id:saved.id,revision:2,action:'disable'});
    assert.equal(disabled.enabled,false);assert.throws(()=>vault.acquire(alice,choice,'task-four'),/不可用/);
    vault.change(alice,{requestId:'enable',id:saved.id,revision:3,action:'enable'});
    const builtin=vault.save(alice,{requestId:'builtin',kind:'builtin',config,secret},true);
    assert.equal(vault.list(eve).length,0);assert.equal(vault.list(bob)[0].id,builtin.id);
    assert.throws(()=>vault.acquire(eve,{connectionId:builtin.id,model:'example-model',effort:'high'},'cross-tenant-builtin'),/不可用/);
    assert.throws(()=>vault.change(eve,{requestId:'delete-builtin',id:builtin.id,revision:1,action:'delete'},true),/管理权限/);
    const reloaded=new ModelVault(db,dir);
    assert.equal(reloaded.acquire(alice,choice,'task-five').secret,secret+'new');reloaded.release(alice,'task-five');
    const update={requestId:'settings-only',id:saved.id,revision:4,config:{...config,maxOutputTokens:512},secret:null};
    const adjusted=reloaded.save(alice,update);assert.equal(adjusted.revision,5);assert.equal(adjusted.maxOutputTokens,512);
    assert.deepEqual(reloaded.save(alice,update),adjusted);
    assert.equal(reloaded.acquire(alice,choice,'settings-check').secret,secret+'new');reloaded.release(alice,'settings-check');
    assert.throws(()=>reloaded.save(alice,{...update,requestId:'new-address',revision:5,config:{...config,endpoint:'https://other.example.com'}}),/重新填写密钥/);
    assert.throws(()=>reloaded.save(alice,{...update,requestId:'new-protocol',revision:5,config:{...config,protocol:'responses'}}),/重新填写密钥/);
    assert.throws(()=>reloaded.save(alice,{requestId:'new-without-key',config,secret:null}),/重新填写密钥/);
    unlinkSync(join(dir,'model-vault-key'));
    assert.throws(()=>reloaded.save(alice,{requestId:'lost-master',config,secret}),/安全资料缺失/);
    assert.throws(()=>reloaded.acquire(alice,choice,'task-six'),/无法读取/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('model traffic rejects private and mixed DNS answers, unusual URLs and encoded loopback',async()=>{
  for(const value of ['127.0.0.1','10.1.2.3','100.64.0.1','169.254.169.254','172.20.1.1','192.168.1.2','198.18.1.1','224.0.0.1','::1','::ffff:8.8.8.8','fc00::1','fe80::1','2001:db8::1','2002:808:808::1','3fff::1'])assert.equal(publicAddress(value),false,value);
  for(const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(publicAddress(value),true,value);
  for(const url of ['http://api.example.com','https://a:b@api.example.com','https://api.example.com:8443','https://api.example.com/v1?q=secret','https://api.example.com/v1#x','https://api.example.com/v1/%2fadmin'])assert.throws(()=>validateEndpoint(url));
  await assert.rejects(resolvePublic(new URL('https://2130706433').hostname));
  await assert.rejects(resolvePublic('api.example.com',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
  assert.deepEqual(await resolvePublic('api.example.com',async()=>[{address:'8.8.8.8',family:4}]),[{address:'8.8.8.8',family:4}]);
});
test('proxy DNS confirmation never permits private answers or forwards a model key; safe reasons survive both error layers',async()=>{
 const {EventEmitter}=await import('node:events');
 const host='api.example.com',publicAnswer=[{address:'8.8.8.8',family:4}],fake=async()=>[{address:'198.18.0.83',family:4}];let confirmations=0;
 const confirm=async name=>{confirmations++;assert.equal(name,host);return publicAnswer;};
 assert.deepEqual(await resolvePublic(host,fake,confirm),publicAnswer);assert.equal(confirmations,1);
 for(const addresses of [[{address:'127.0.0.1',family:4}],[...publicAnswer,{address:'198.18.0.83',family:4}]])await assert.rejects(resolvePublic(host,async()=>addresses,confirm));
 assert.equal(confirmations,1,'mixed/private system DNS must fail closed rather than use confirmation');
 await assert.rejects(resolvePublic('198.18.0.83',fake,confirm));assert.equal(confirmations,1,'literal fake IP never qualifies');
 await assert.rejects(resolvePublic(host,fake,async()=>[{address:'169.254.169.254',family:4}]));
 const reply={Status:0,Question:{name:host+'.',type:1},Answer:[{name:host+'.',type:5,data:'edge.example.com.'},{name:'edge.example.com.',type:1,data:'8.8.8.8'}]};
 assert.deepEqual(parseProxyDnsReply(JSON.stringify(reply),host),publicAnswer);
 for(const value of [{...reply,Status:3},{...reply,TC:true},{...reply,Question:{name:'other.example.com',type:1}},{...reply,Answer:[{name:'unrelated.example.com',type:1,data:'8.8.8.8'}]}])assert.throws(()=>parseProxyDnsReply(JSON.stringify(value),host));
 const requests=[];
 const send=(url,options,receive)=>{
  requests.push({url,options});const req=new EventEmitter();req.destroy=error=>{req.emit('error',error);req.emit('close');};
  req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};res.destroy=()=>{};receive(res);res.emit('data',Buffer.from(JSON.stringify(reply)));res.emit('end');req.emit('close');});return req;
 };
 assert.deepEqual(await resolveProxyHostname(host,{send}),publicAnswer);assert.equal(requests.length,1);
 assert.equal(requests[0].url.origin,'https://1.1.1.1');assert.equal(requests[0].url.searchParams.get('name'),host);assert.equal(requests[0].options.headers.Authorization,undefined);
 for(const reason of Object.keys(MODEL_CONNECTION_MESSAGES)){
  const error=modelConnectionFailure(reason);error.message=secret;error.nextAction=secret;
  const safe=safeError(error);assert.equal(errorText(safe),MODEL_CONNECTION_MESSAGES[reason]);assert.equal(errorText(Object.assign(new Error(errorText(safe)),{code:safe.code})),MODEL_CONNECTION_MESSAGES[reason]);
  assert.equal(JSON.stringify(safe).includes(secret),false);
 }
 assert.throws(()=>new ModelConnectionError(secret));assert.equal(JSON.stringify(safeError(new Error(secret))).includes(secret),false);
});
test('save has zero traffic; explicit probe submits once, binds selection, preserves unknown cost and survives restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-probe-')),db=new DatabaseSync(join(dir,'workspace.sqlite'));
  const vault=new ModelVault(db,dir),requests=[];
  const wrapped={list:()=>vault.list(alice),save:(i,a)=>vault.save(alice,i,a),change:(i,a)=>vault.change(alice,i,a),acquire:(s,h)=>vault.acquire(alice,s,h),release:h=>vault.release(alice,h)};
  const repo={models:()=>wrapped};
  const transport=async input=>{requests.push(input);return Buffer.from(JSON.stringify({choices:[{message:{content:'OK'}}],usage:{prompt_tokens:12,completion_tokens:1}}));};
  const service=new ModelService(repo,db,{transport});
  try{
    const saved=await service.call(alice,{requestId:'save',config,secret},'save');assert.equal(requests.length,0);
    const catalogCalls=[],catalog=new ModelService(repo,db,{transport:async input=>{catalogCalls.push(input);return Buffer.from(JSON.stringify({data:[{id:'model-b',context_window:1048576},{id:'model-a',context_window:32000},{id:'model-a',context_window:64000},{id:'bad\nname'}],has_more:true}));}});
    const found=await catalog.call(alice,{endpoint:config.endpoint,secret},'discover');assert.deepEqual(found.models,['model-a','model-b']);assert.equal(found.partial,true);assert.equal(catalogCalls[0].path,'/models');assert.equal(catalogCalls[0].body,undefined);assert.equal(JSON.stringify(found).includes(secret),false);
    assert.equal(found.capacities['model-b'],1048576);assert.equal(found.capacities['model-a'],null,'conflicting provider metadata cannot enlarge the capacity');
    await assert.rejects(catalog.call(alice,{endpoint:'http://127.0.0.1',secret},'discover'));assert.equal(catalogCalls.length,1);
    const selection={connectionId:saved.connection.id,model:'example-model',effort:'high'},input={requestId:'probe',consent:true,selection};
    await assert.rejects(service.call(alice,{...input,consent:false},'probe'),/可能产生费用/);assert.equal(requests.length,0);
    const result=await service.call(alice,input,'probe');
    assert.equal(result.usage.inputTokens,12);assert.equal(result.costUsd,null);assert.equal(requests[0].body.model,'example-model');assert.equal(requests[0].body.reasoning_effort,'high');
    assert.equal(requests[0].body.max_tokens,16);assert.equal(requests[0].secret,secret);
    assert.deepEqual(await new ModelService(repo,db,{transport}).call(alice,input,'probe'),result);assert.equal(requests.length,1);
    const broken=new ModelService(repo,db,{transport:async input=>{requests.push(input);throw Error(secret);}});
    const unknown=await broken.call(alice,{...input,requestId:'network-failed'},'probe');assert.equal(unknown.status,'unknown');assert.equal(JSON.stringify(unknown).includes(secret),false);
    await broken.call(alice,{...input,requestId:'network-failed'},'probe');assert.equal(requests.length,2);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('repository model settings recheck authentic scope and revocation; agents cannot read keys',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-model-auth-')),repo=new WorkspaceRepository({dataDir:dir}),scope={projectId:'one',branchId:null,versionId:null};
  try{
    const cred=repo.createCredential({...alice,scope,kind:'ui',capabilities:['read_memory','review_memory']}),auth=repo.authenticate(cred.token);
    const saved=await repo.modelOperation(auth,{protocolVersion:PROTOCOL_VERSION,scope,requestId:'save',config,secret},'save');
    assert.equal(saved.connection.enabled,true);
    await assert.rejects(repo.modelOperation({...auth},{scope},'list'),/权限/);
    await assert.rejects(repo.modelOperation(auth,{scope:{...scope,projectId:'two'}},'list'),/权限/);
    const agent=repo.authenticate(repo.createCredential({...alice,scope,kind:'agent',capabilities:['read_memory']}).token);
    await assert.rejects(repo.modelOperation(agent,{scope},'list'),/权限/);
    repo.revokeCredential(cred.id);await assert.rejects(repo.modelOperation(auth,{scope},'list'),/权限/);
  }finally{repo.close();rmSync(dir,{recursive:true,force:true});}
});

test('transport pins the vetted answer; redirects, oversized replies, DNS stalls and aborts never retry',async()=>{
  const {EventEmitter}=await import('node:events'),{createModelTransport}=await import('../../services/workspace/model-network.mjs');
  const calls=[];let responseMode='ok';
  const transport=createModelTransport({resolver:async()=>[{address:'8.8.8.8',family:4}],send:(url,options,receive)=>{
    calls.push({url,options});const req=new EventEmitter();req.destroy=error=>{req.emit('error',error);req.emit('close');};
    req.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=responseMode==='redirect'?302:200;response.headers={'content-type':'application/json',location:'http://127.0.0.1/secret'};response.destroy=error=>{if(error)response.emit('error',error);req.emit('close');};receive(response);if(response.statusCode===200){response.emit('data',Buffer.from('{}'));response.emit('end');req.emit('close');}});return req;
  }});
  const input={endpoint:config.endpoint,path:'/chat/completions',secret,body:{model:'chosen'}};
  assert.equal((await transport(input)).toString(),'{}');
  assert.equal(calls[0].url.hostname,'api.example.com');assert.equal(calls[0].options.agent,false);
  calls[0].options.lookup('api.example.com',{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
  calls[0].options.lookup('api.example.com',{all:true},(error,addresses)=>{assert.equal(error,null);assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]);});
  responseMode='redirect';await assert.rejects(transport(input));assert.equal(calls.length,2);
  responseMode='ok';await assert.rejects(transport({...input,maxBytes:1}));assert.equal(calls.length,3);
  let sent=0;const stalled=createModelTransport({resolver:()=>new Promise(()=>{}),send:()=>{sent++;throw Error('must not send');}});
  await assert.rejects(stalled({...input,timeoutMs:20}));const controller=new AbortController();const pending=stalled({...input,signal:controller.signal});controller.abort();await assert.rejects(pending);assert.equal(sent,0);
});

test('backup restores encrypted model revisions, interrupted chat identity and holds; incompatible downgrade is refused',async()=>{
  const {writeFileSync,mkdirSync}=await import('node:fs'),{snapshotWorkspace,restoreWorkspace,inspectDatabase}=await import('../../scripts/runtime/recovery.mjs'),{requiredDataFeatures,assertDataFeatures}=await import('../../scripts/runtime/data-compatibility.mjs');
  const dir=mkdtempSync(join(tmpdir(),'synplex-model-recovery-')),data=join(dir,'data'),scope={projectId:'recovery',branchId:null,versionId:null};let repo=new WorkspaceRepository({dataDir:data});
  try{
    const cred=repo.createCredential({...alice,scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task']}),auth=repo.authenticate(cred.token);
    writeFileSync(join(data,'ui-token'),cred.token,{mode:0o600});writeFileSync(join(data,'agent-token'),'synthetic-unused-token',{mode:0o600});
    writeFileSync(join(data,'connection.json'),JSON.stringify({scope,endpoint:'http://127.0.0.1:5414',uiTokenFile:join(data,'ui-token'),agentTokenFile:join(data,'agent-token')}),{mode:0o600});
    const saved=repo.models(auth,scope).save({requestId:'save',config,secret}),selection={connectionId:saved.id,model:'example-model',effort:'high'};
    const chat=repo.chat(auth,scope),conversation=chat.create('create');repo.models(auth,scope).acquire(selection,'pending-reply');
    chat.reserve({id:'pending-reply',conversationId:conversation.id,requestId:'original-send',inputHash:'synthetic',content:'保留原消息',selection,excludedClaimIds:[],background:null,historyLimited:false});
    chat.update('pending-reply',{status:'unknown',delta:'保留部分回复',notice:'原请求待核对'});
    const db=new DatabaseSync(join(data,'workspace.sqlite')),relay=new ModelRelayStore(db,data);
    const grant=relay.grant({operationId:'preserved-execution',attemptId:'original-attempt',credentialId:cred.id,scope,selection,binding:{model:'example-model'},virtualModel:'virtual',maxCalls:2});
    const completed=relay.reserve(grant,{content:'delivered'});relay.finish(completed.value.id,{status:'completed',response:Buffer.from('original provider bytes'),contentType:'application/json'});
    relay.reserve(grant,{content:'interrupted'});const token=relay.token(grant.id);db.close();repo.close();repo=null;
    const before=inspectDatabase(join(data,'workspace.sqlite'));assert.equal(before.unresolved,2);
    await snapshotWorkspace(data,join(dir,'backup'));const restored=restoreWorkspace(join(dir,'backup'),join(dir,'restored'),{port:5415});assert.deepEqual(restored.data,before);
    assert.deepEqual(requiredDataFeatures(join(restored.dataDir,'workspace.sqlite')),['chat-continuity/1','execution-model-connections/1','model-connections/1','model-price-snapshots/1']);
    mkdirSync(join(dir,'old','migrations'),{recursive:true});writeFileSync(join(dir,'old','migrations','workspace-features.json'),JSON.stringify({format:'synplex.workspace-features/1',features:[]}));assert.throws(()=>assertDataFeatures(join(dir,'old'),join(restored.dataDir,'workspace.sqlite')),/不能完整理解/);
    repo=new WorkspaceRepository({dataDir:restored.dataDir});const resumed=repo.authenticate(cred.token),models=repo.models(resumed,scope),value=repo.chat(resumed,scope).get('pending-reply');
    assert.equal(value.status,'unknown');assert.equal(value.answer,'保留部分回复');assert.equal(value.requestId,'original-send');assert.equal(value.costUsd,null);
    const restoredDb=new DatabaseSync(join(restored.dataDir,'workspace.sqlite')),restoredRelay=new ModelRelayStore(restoredDb,restored.dataDir);
    assert.equal(restoredRelay.token(grant.id),token);assert.equal(restoredRelay.authorize(token).attemptId,'original-attempt');
    assert.equal(restoredRelay.calls('preserved-execution')[1].status,'unknown');
    assert.equal(Buffer.from(restoredRelay.reserve(grant,{content:'delivered'}).response).toString(),'original provider bytes');
    assert.throws(()=>restoredRelay.reserve(grant,{content:'interrupted'}),/尚需核对/);assert.throws(()=>restoredRelay.reserve(grant,{content:'new'}),/仍有模型请求/);restoredDb.close();
    assert.throws(()=>models.change({requestId:'disable',id:saved.id,revision:1,action:'disable'}),/仍有任务/);
    const recovered=models.acquire(selection,'pending-reply');assert.equal(recovered.secret,secret);assert.equal(recovered.binding.priceSnapshot.source,'synthetic-snapshot-price');repo.chat(resumed,scope).acknowledge('pending-reply');
    assert.equal(models.change({requestId:'disable-after-review',id:saved.id,revision:1,action:'disable'}).enabled,false);
    repo.close();repo=null;const master=join(restored.dataDir,'model-vault-key'),original=readFileSync(master);writeFileSync(master,Buffer.alloc(32,9));assert.throws(()=>inspectDatabase(join(restored.dataDir,'workspace.sqlite')),/安全资料不一致/);writeFileSync(master,original);
  }finally{repo?.close();rmSync(dir,{recursive:true,force:true});}
});
