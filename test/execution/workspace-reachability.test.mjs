import test from'node:test';
import assert from'node:assert/strict';
import{DatabaseSync}from'node:sqlite';
import{mkdtempSync,rmSync,readFileSync,mkdirSync,writeFileSync}from'node:fs';
import{tmpdir}from'node:os';
import{join}from'node:path';
import{ModelVault}from'../../services/workspace/model-vault.mjs';
import{ModelService}from'../../services/workspace/model-service.mjs';
import{scanNoteLibrary}from'../../public/obsidian-library.js';
import{WorkspaceRepository}from'../../services/workspace/repository.mjs';
import{initialConnection}from'../../services/workspace/initial-connection.mjs';
import{LocalProjects}from'../../services/workspace/local-projects.mjs';
import{payloadHash}from'../../packages/contracts/hash.mjs';
import{exportHistory,importHistory}from'../../scripts/runtime/history-transfer.mjs';
const config={name:'平台默认',endpoint:'https://api.deepseek.com',protocol:'chat-completions',maxOutputTokens:1024,models:[{id:'deepseek-flash',name:'日常型号',capabilities:{tools:true,stream:true,efforts:['high'],contextWindow:32000}}]},secret='synthetic-default-test-key';
test('site default crosses tenants only after operator binding; tenant administrators cannot edit or read its secret',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-default-')),db=new DatabaseSync(':memory:');t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const vault=new ModelVault(db,dir),root={ownerId:'platform',actorId:'operator'},a={ownerId:'a',actorId:'user'},b={ownerId:'b',actorId:'user'};
 const builtin=vault.save(root,{requestId:'default',kind:'builtin',config,secret},true),own=vault.save(a,{requestId:'personal',config,secret});assert.equal(vault.list(a).length,1);
 vault.configureBuiltinOwner(root.ownerId);assert.equal(vault.list(a)[0].id,builtin.id);assert.equal(vault.list(a)[0].canManage,false);assert.equal(vault.list(b).length,1);assert.equal(JSON.stringify(vault.list(b)).includes(secret),false);
 const choice={connectionId:builtin.id,model:'deepseek-flash',effort:'high'};assert.equal(vault.acquire(a,choice,'use',{tools:true}).secret,secret);
 assert.throws(()=>vault.change(b,{requestId:'steal',id:builtin.id,revision:1,action:'delete'},true),/管理权限/);
 assert.throws(()=>vault.save(b,{requestId:'overwrite',id:builtin.id,revision:1,kind:'builtin',config,secret},true),/管理权限/);assert.throws(()=>vault.acquire(b,{...choice,connectionId:own.id},'personal-leak'),/不可用/);
 assert.throws(()=>vault.change(root,{requestId:'active',id:builtin.id,revision:1,action:'disable'},true),/仍有任务/);vault.release(a,'use');vault.change(root,{requestId:'idle',id:builtin.id,revision:1,action:'disable'},true);assert.throws(()=>vault.acquire(a,choice,'disabled'),/不可用/);
});
test('three-field save fetches catalogue once without generating text; all returned models remain switchable and unknown tools stay disabled',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-catalog-')),db=new DatabaseSync(':memory:'),vault=new ModelVault(db,dir),auth={ownerId:'one',actorId:'human'},calls=[];
 t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
 const service=new ModelService({models:()=>({save:(i,a)=>vault.save(auth,i,a)})},db,{transport:async input=>{calls.push(input);return Buffer.from(JSON.stringify({data:[{id:'deepseek-flash'},{id:'unverified-model'}]}));}});
 const result=await service.call(auth,{requestId:'save',config:{...config,models:[]},secret},'save');assert.equal(calls.length,1);assert.equal(calls[0].path,'/models');assert.equal(calls[0].body,undefined);assert.equal(result.connection.models.length,2);assert.equal(result.connection.models[0].capabilities.tools,true);assert.equal(result.connection.models[1].capabilities.tools,false);assert.equal(JSON.stringify(result).includes(secret),false);
});
test('connected note library scans read-only, skips hidden/oversized files and bounds enumeration without reading document bytes',async()=>{
 let byteReads=0;const file=(name,size=20)=>({kind:'file',async getFile(){return{name,size,arrayBuffer(){byteReads++;throw Error('not needed during browse');}};}}),directory=entries=>({kind:'directory',async*entries(){yield*entries;}});
 const vault=directory([['.obsidian',directory([['secret.md',file('secret.md')]])],['项目',directory([['方案.md',file('方案.md')],['大文件.md',file('大文件.md',3*1024*1024)]])],['报告.pdf',file('报告.pdf')],['第二篇.md',file('第二篇.md')]]);
 const result=await scanNoteLibrary(vault);assert.deepEqual(result.items.map(x=>x.path).sort(),['第二篇.md','项目/方案.md'].sort());assert.equal(result.skipped,2);assert.equal(byteReads,0);assert.equal((await scanNoteLibrary(vault,{limit:1})).partial,true);
});
function setup(dir,ownerId,actorId,scope){const repository=new WorkspaceRepository({dataDir:dir}),connection=initialConnection(repository,{dataDir:dir,scope,port:5297,ownerId,actorId}),auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8'));new LocalProjects({repository,dataDir:dir,connection,rootAuth:auth});return{repository,auth};}
function account(db,id,email,owner,actor,scope){db.prepare('INSERT INTO workspace_accounts VALUES(?,?,?,?,?,?,?,1)').run(id,email,'synthetic-no-login-hash',owner,actor,JSON.stringify(scope),Date.now());}
test('same-email history transfer adds original bytes, records and conversations while preserving online credentials, existing data and account identity',async t=>{
 const root=mkdtempSync(join(tmpdir(),'synplex-history-')),source=join(root,'source'),target=join(root,'target'),scope={projectId:'source-project',versionId:null,branchId:null},online={...scope,projectId:'online-project'};let r;
 t.after(()=>{r?.close();rmSync(root,{recursive:true,force:true});});
 let s=setup(source,'local-owner','local-human',scope);s.repository.accounts();s.repository.close();let db=new DatabaseSync(join(source,'workspace.sqlite'));account(db,'source-account','same@example.com','local-owner','local-human',scope);
 const p=payloadHash({ownerId:'local-owner',scope}),body={id:'history-record',body:'原始项目决定',actorId:'local-human'};db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?)').run(p,'fixture_history',body.id,null,payloadHash(body),JSON.stringify(body));const bytes=Buffer.from('原文 [[项目/说明]]');db.prepare('INSERT INTO raw_blobs VALUES(?,?,?)').run('local-owner',createDigest(bytes),bytes);db.prepare('INSERT INTO chat_conversations VALUES(?,?,?,?,?,?)').run('conversation',p,'local-human','create','原对话',new Date().toISOString());db.close();
 const f=setup(target,'tenant:online','account:online',online);f.repository.accounts();f.repository.close();db=new DatabaseSync(join(target,'workspace.sqlite'));account(db,'online','same@example.com','tenant:online','account:online',online);const existing=db.prepare('SELECT count(*) n FROM credentials').get().n;db.close();const accountDir=join(target,'accounts','online');mkdirSync(accountDir,{recursive:true,mode:0o700});writeFileSync(join(accountDir,'projects.json'),readFileSync(join(target,'projects.json')),{mode:0o600});
 const bundle=exportHistory(source,' SAME@example.com '),receipt=importHistory(target,bundle);assert.equal(receipt.conversations,1);assert.deepEqual(importHistory(target,bundle),receipt);
 r=new WorkspaceRepository({dataDir:target});const stored=r.accounts().account('online');assert.equal(stored.ownerId,'tenant:online');assert.deepEqual(stored.scope,online);const imported=JSON.parse(readFileSync(join(accountDir,'projects.json'))).entries.find(x=>x.scope.projectId===scope.projectId),auth=r.authenticate(readFileSync(imported.uiTokenFile,'utf8'));assert.equal(r.chat(auth,scope).list().items[0].id,'conversation');assert.throws(()=>r.chat(f.auth,scope).list());r.close();r=null;
 db=new DatabaseSync(join(target,'workspace.sqlite'));assert.equal(db.prepare('SELECT password_hash FROM workspace_accounts').get().password_hash,'synthetic-no-login-hash');assert.equal(db.prepare('SELECT count(*) n FROM records').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM credentials').get().n,existing+2);assert.deepEqual(Buffer.from(db.prepare('SELECT bytes FROM raw_blobs').get().bytes),bytes);assert.equal(db.prepare('SELECT body_json FROM records').get().body_json,JSON.stringify(body));db.close();
 const wrong={...bundle,email:'other@example.com'};const{sha256,...data}=wrong;wrong.sha256=payloadHash(data);assert.throws(()=>importHistory(target,wrong),/相同邮箱/);
});
function createDigest(bytes){return payloadHashBytes(bytes);}
import{createHash}from'node:crypto';
const payloadHashBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
