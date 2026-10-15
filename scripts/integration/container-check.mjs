import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const name=process.argv[2];
const full=process.env.SYNPLEX_CONTAINER_FULL==='1';
assert.match(name,/^synplex-ci-[0-9]+$/);
const endpoint='http://127.0.0.1:5260',origin='https://synplex.example';
const basic='Basic '+Buffer.from('ci-user:test-only-container-password').toString('base64');
assert.equal((await fetch(endpoint+'/')).status,200);
assert.equal((await fetch(endpoint+'/app')).status,401);
assert.equal((await fetch(endpoint+'/api/v1/ui_bootstrap')).status,401);
assert.equal((await fetch(endpoint+'/internal/model/v1/models')).status,404);
assert.equal((await fetch(endpoint+'/api/v1/ui_bootstrap',{headers:{Authorization:basic}})).status,403);
const launcher=full?'/var/lib/synplex/workspace/打开Synplex.html':'/var/lib/synplex/打开Synplex.html';
const nonce=execFileSync('docker',['exec',name,'node','--input-type=module','-e',`import {readFileSync} from 'node:fs';const h=readFileSync(${JSON.stringify(launcher)},'utf8');console.log(h.match(/name="pair" value="([a-f0-9]{64})"/)[1]);`],{encoding:'utf8'}).trim();
const pair=await fetch(endpoint+'/api/v1/ui_pair',{method:'POST',headers:{Authorization:basic,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({pair:nonce}),redirect:'manual'});
assert.equal(pair.status,303);const cookie=pair.headers.get('set-cookie');assert.match(cookie,/; Secure/);
const headers={Authorization:basic,Cookie:cookie.split(';')[0],Origin:origin};
assert.equal((await fetch(endpoint+'/api/v1/ui_pair',{method:'POST',headers:{Authorization:basic,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({pair:nonce}),redirect:'manual'})).status,403);
assert.equal((await fetch(endpoint+'/api/v1/ui_bootstrap',{headers:{...headers,Origin:'https://other.example'}})).status,403);
const boot=await(await fetch(endpoint+'/api/v1/ui_bootstrap',{headers})).json();assert.ok(boot.scope);assert.equal(boot.capabilities.execution,full);
if(full){
 assert.equal(boot.capabilities.chat,true);
 const check=execFileSync('docker',['exec',name,'/opt/synplex-python/bin/python','-B','-c',`import json,time
from pathlib import Path
from celery import Celery
s=json.loads(Path('/var/lib/synplex/engine/engine/bootstrap.json').read_text())
app=Celery('synplex-readiness',broker='redis://:'+s['redis_password']+'@127.0.0.1:'+str(s['redis_port'])+'/0')
responses=app.control.ping(timeout=5)
assert len(responses)==1 and next(iter(responses[0].values()))=={'ok':'pong'},'actual private worker response'
print('Independent engine API and worker ready; no task submitted.')`],{encoding:'utf8',timeout:20000});
 execFileSync('docker',['exec',name,'node','--input-type=module','-e',`import {readFileSync} from 'node:fs';import assert from 'node:assert/strict';const s=JSON.parse(readFileSync('/var/lib/synplex/engine/engine/bootstrap.json'));assert.equal((await fetch('http://127.0.0.1:'+s.api_port+'/health/live')).status,200);`],{encoding:'utf8',timeout:10000});
 assert.match(check,/worker ready/);
}
const post=async(route,input={})=>{const response=await fetch(endpoint+'/api/v1/'+route,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:boot.scope,...input})});assert.ok(response.ok,route+' '+response.status);return response;};
const original='决定：保留完整原文，按真实出处继续项目。',form=new FormData();
form.append('metadata',JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:boot.scope,requestId:'container-import',expectedStateRevision:0,format:'text/markdown',sourceSystem:'user-markdown',formatVersion:'1',sessionId:null,eventId:'container-material',occurredAt:null}));
form.append('source',new Blob([original],{type:'text/markdown'}),'container.md');
const admission=await fetch(endpoint+'/api/v1/import_source',{method:'POST',headers,body:form});assert.ok(admission.ok);let imported=await admission.json();
for(let i=0;i<60&&['queued','running'].includes(imported.operation.status);i++){await new Promise(r=>setTimeout(r,50));imported=await(await post('get_import_result',{operationId:imported.operation.id})).json();}
assert.equal(imported.operation.status,'succeeded');
const history=await(await post('ui_history')).json(),claim=history.state.pending[0];assert.ok(claim);
const review={requestId:'container-review',expectedStateRevision:history.state.stateRevision,claimId:claim.id,reviewStatus:'confirmed'};
const grant=await(await post('authorize_review',review)).json();await post('review_claim',{...review,authorizationId:grant.authorizationId});
assert.equal(await(await post('source_file',{sourceId:claim.evidence[0].sourceId})).text(),original);
const final=await(await post('ui_history')).json();assert.equal(final.executions.length,0);assert.equal(final.usage.rows.length,0);
assert.equal((await(await fetch(endpoint+'/health',{headers})).json()).buildSha,'ci-container');
if(full){
 execFileSync('docker',['restart',name],{timeout:45000,stdio:'pipe'});
 let ready=false;for(let i=0;i<120;i++){try{ready=(await fetch(endpoint+'/app',{signal:AbortSignal.timeout(1000)})).status===401;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,500));}assert.ok(ready,'full container restarts');
 assert.equal((await fetch(endpoint+'/api/v1/ui_bootstrap',{headers})).status,403,'restart invalidates the old browser session');
 const renewedNonce=execFileSync('docker',['exec',name,'node','--input-type=module','-e',`import {readFileSync} from 'node:fs';console.log(readFileSync(${JSON.stringify(launcher)},'utf8').match(/name="pair" value="([a-f0-9]{64})"/)[1]);`],{encoding:'utf8'}).trim();
 const renewed=await fetch(endpoint+'/api/v1/ui_pair',{method:'POST',headers:{Authorization:basic,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({pair:renewedNonce}),redirect:'manual'});assert.equal(renewed.status,303);headers.Cookie=renewed.headers.get('set-cookie').split(';')[0];

 assert.equal(await(await post('source_file',{sourceId:claim.evidence[0].sourceId})).text(),original);
 const restarted=await(await post('ui_history')).json();assert.equal(restarted.state.decisions[0].id,claim.id);assert.equal(restarted.executions.length,0);assert.equal(restarted.usage.rows.length,0);
}
console.log('Protected container: authentication, one-time pairing, Secure cookie, cross-origin rejection, import/review/exact download passed. Model calls: 0.');
