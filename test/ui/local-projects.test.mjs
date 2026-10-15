import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import { LocalProjects } from '../../services/workspace/local-projects.mjs';
const scope={projectId:'root-fixture',versionId:null,branchId:null},protocolVersion='synplex.workspace/1.0.0';
test('local owner creates and replays isolated projects; ordinary agents cannot create, switch or read across scopes',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-projects-')),repository=new WorkspaceRepository({dataDir});
 const caps=['read_memory','write_memory','prepare_task','record_result'];
 const human=repository.createCredential({ownerId:'owner',actorId:'local-human',scope,kind:'ui',capabilities:[...caps,'review_memory']});
 const host=repository.createCredential({ownerId:'owner',actorId:'codex-host',scope,capabilities:caps});
 const uiTokenFile=join(dataDir,'ui'),agentTokenFile=join(dataDir,'agent');writeFileSync(uiTokenFile,human.token,{mode:0o600});writeFileSync(agentTokenFile,host.token,{mode:0o600});
 const rootAuth=repository.authenticate(human.token),connection={scope,uiTokenFile,agentTokenFile};
 const localProjects=new LocalProjects({repository,dataDir,connection,rootAuth}),app=createWorkspaceServer({repository,localProjects});
 const endpoint=await app.listen();t.after(async()=>{await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});});
 const pairing=await app.createUiPairing(rootAuth,scope),r=await fetch(endpoint+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:pairing.nonce}),redirect:'manual'});
 const cookie=r.headers.get('set-cookie').split(';')[0];
 const post=(path,body,headers={Cookie:cookie})=>fetch(endpoint+'/api/v1/'+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion,...body})});
 const input={scope,requestId:'create-fixture',name:'验收项目'};
 const a=await post('ui_create_project',input);assert.equal(a.status,200);const first=await a.json();assert.notDeepEqual(first.scope,scope);assert.equal(first.projects.length,2);
 const b=await post('ui_create_project',input);assert.equal(b.status,200);assert.deepEqual((await b.json()).scope,first.scope);
 assert.equal((await post('ui_create_project',{...input,name:'修改同请求'})).status,409);
 assert.equal((await post('ui_select_project',{scope:{...first.scope,versionId:'other'}})).status,403);
 assert.equal((await post('ui_create_project',input,{Authorization:'Bearer '+host.token})).status,403);
 assert.equal((await post('get_project_state',{scope:first.scope},{Authorization:'Bearer '+host.token})).status,403);
 assert.equal((await post('get_project_state',{scope})).status,403); // active project session stays exact
 assert.equal((await post('ui_select_project',{scope})).status,200);
 const catalog=readFileSync(join(dataDir,'projects.json'),'utf8');assert.equal(catalog.includes(human.token),false);assert.equal(catalog.includes(host.token),false);
 const reloaded=new LocalProjects({repository,dataDir,connection,rootAuth});assert.deepEqual(await reloaded.list(rootAuth),first.projects);
 // A crash after private files were saved but before catalog completion must reuse this identity.
 const interrupted=JSON.parse(catalog);interrupted.entries[1].status='creating';writeFileSync(join(dataDir,'projects.json'),JSON.stringify(interrupted),{mode:0o600});
 const recovering=new LocalProjects({repository,dataDir,connection,rootAuth});assert.equal((await recovering.list(rootAuth)).length,1);
 assert.deepEqual((await recovering.create(rootAuth,input)).scope,first.scope);
 assert.equal((await recovering.list(rootAuth)).length,2);
 // The DSH token file may exist when the final catalog save was interrupted; never replace it.
 const dsh=await recovering.connection(rootAuth,first.scope,'dsh'),token=readFileSync(dsh.tokenFile,'utf8');
 const lostCatalog=JSON.parse(readFileSync(join(dataDir,'projects.json'),'utf8'));delete lostCatalog.entries[1].dshTokenFile;writeFileSync(join(dataDir,'projects.json'),JSON.stringify(lostCatalog),{mode:0o600});
 const recovered=new LocalProjects({repository,dataDir,connection,rootAuth});assert.equal((await recovered.connection(rootAuth,first.scope,'dsh')).tokenFile,dsh.tokenFile);assert.equal(readFileSync(dsh.tokenFile,'utf8'),token);
 repository.revokeCredential(human.id);assert.equal((await post('ui_select_project',{scope:first.scope})).status,403);
});
