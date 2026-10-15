import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {verifyRelease} from '../runtime/release.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';

const target=resolve(process.argv[2]),manifest=verifyRelease(target);
const {settings,supervise}=await import(pathToFileURL(join(target,'scripts/runtime/workspace.mjs')));
const socket=createServer();await new Promise(yes=>socket.listen(0,'127.0.0.1',yes));const port=socket.address().port;await new Promise(yes=>socket.close(yes));
const dataDir=join(target,'.runtime','release-smoke-'+randomUUID()),config=settings({dataDir,port}),ready=[];
const managed=await supervise(config,{openBrowser:false,onReady:r=>ready.push(r)});
try{
 const deadline=Date.now()+20000;while(!ready.length&&Date.now()<deadline)await new Promise(yes=>setTimeout(yes,20));assert.ok(ready.length);assert.equal(ready[0].error,undefined);
 const connection=JSON.parse(readFileSync(join(dataDir,'connection.json'))),token=readFileSync(connection.uiTokenFile,'utf8').trim();
 const post=async(route,input)=>{const r=await fetch(config.endpoint+'/api/v1/'+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:config.scope,...input})});assert.ok(r.ok,route+' '+r.status);return r.json();};
 const meta={protocolVersion:'synplex.workspace/1.0.0',scope:config.scope,requestId:'release-smoke-import',expectedStateRevision:0,format:'text/markdown',sourceSystem:'user-markdown',formatVersion:'1',sessionId:null,eventId:'release-smoke-material',occurredAt:null};
 const text='决定：发行包要能在独立目录打开，不能声称完成了未验收的能力。',form=new FormData();form.append('metadata',JSON.stringify(meta));form.append('source',new Blob([text],{type:'text/markdown'}),'发行核对.md');
 const imported=await fetch(config.endpoint+'/api/v1/import_source',{method:'POST',headers:{Authorization:'Bearer '+token},body:form});assert.ok(imported.ok);const admission=await imported.json();
 let settled;for(let i=0;i<100;i++){settled=await post('get_import_result',{operationId:admission.operation.id});if(!['queued','running'].includes(settled.operation.status))break;await new Promise(yes=>setTimeout(yes,20));}assert.equal(settled.operation.status,'succeeded');
 const history=await post('ui_history',{}),claim=history.state.pending[0];assert.ok(claim);const review={requestId:'release-smoke-review',expectedStateRevision:history.state.stateRevision,claimId:claim.id,reviewStatus:'confirmed'},grant=await post('authorize_review',review);await post('review_claim',{...review,authorizationId:grant.authorizationId});
 const current=await post('ui_claim_detail',{claimId:claim.id});assert.equal(current.journey.current[0].id,claim.id);
 const raw=await fetch(config.endpoint+'/api/v1/source_file',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:meta.protocolVersion,scope:config.scope,sourceId:claim.evidence[0].sourceId})});assert.equal(raw.status,200);assert.equal(sha256(Buffer.from(await raw.arrayBuffer())),sha256(Buffer.from(text)));
 const final=await post('ui_history',{});assert.equal(final.executions.length,0);assert.equal(final.usage.rows.length,0);
 const evidence={releaseCommit:manifest.commit,contentHash:manifest.contentHash,platform:process.platform,arch:process.arch,checks:['relocated bundled runtime starts without importing old project sources','native document dependencies load','actual multipart import and exact original download','human confirmation and sourced change projection','no execution or model use'],modelCalls:0,fullDeliveryVerified:false};
 mkdirSync(join(target,'.runtime','evidence'),{recursive:true,mode:0o700});writeFileSync(join(target,'.runtime','evidence','release-smoke.json'),JSON.stringify(evidence,null,2),{mode:0o600});
 console.log(JSON.stringify(evidence));
}finally{await managed.close();}
