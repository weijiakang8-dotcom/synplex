import {ProtocolError,PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {sourceExtension} from '../../public/document-formats.js';
import {previewArtifact} from './artifact-preview.mjs';
import {noteExport} from './note-export.mjs';
import {projectExpression,validExpressionInput} from './project-expression.mjs';

const denied=()=>{throw new ProtocolError('scope_denied','访问被拒绝。','使用获准的本机连接。');};
const json=body=>({body});
const file=(bytes,name,extra={})=>({bytes,headers:{'Content-Type':'application/octet-stream','Content-Length':bytes.length,
 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}});
const read=(keys,handler,valid=i=>keys.every(k=>typeof i[k]==='string'),optional=[])=>({keys,handler,valid,optional});
const routes={
 ui_pending_page:read(['cursor'],({repository,auth,input:i})=>json(repository.pendingPage(auth,i.scope,i.cursor)),i=>i.cursor===null||typeof i.cursor==='string'&&i.cursor.length<=2048),
 ui_materials_page:read(['cursor'],({repository,auth,input:i})=>json(repository.materialPage(auth,i.scope,i.cursor)),i=>i.cursor===null||typeof i.cursor==='string'&&i.cursor.length<=2048),
 ui_import_status:read([],({repository,auth,input:i})=>json(repository.importStatus(auth,i.scope))),
 ui_project_revision:read([],({repository,auth,input:i})=>json(repository.revision(auth,i.scope))),
 ui_obsidian_notes:read([],({repository,auth,input:i})=>json(repository.obsidianNotes(auth,i.scope))),
 ui_expression_versions:read([],({repository,auth,input:i})=>json(repository.expressionVersions(auth,i.scope))),
 ui_expression_version:read(['versionId'],({repository,auth,input:i})=>json(repository.expressionVersion(auth,i.scope,i.versionId))),
 ui_result_versions:read(['resultId'],({repository,auth,input:i})=>json(repository.resultVersions(auth,i.scope,i.resultId))),
 ui_claim_detail:read(['claimId'],({repository,auth,input:i})=>json(repository.claimDetail(auth,i.scope,i.claimId))),
 ui_compare_claims:read(['beforeId','afterId'],({repository,auth,input:i})=>json(repository.compareClaims(auth,i.scope,i.beforeId,i.afterId))),
 ui_source_history:read(['sourceId'],({repository,auth,input:i})=>json(repository.sourceMetadataHistory(auth,i.scope,i.sourceId))),
 ui_task_plan:read(['planId'],({repository,auth,input:i})=>json(repository.taskPlan(auth,i.scope,i.planId))),
 ui_source_preview:read(['sourceId'],({repository,auth,input:i})=>json(repository.sourcePreview(auth,i.scope,i.sourceId,{cursor:i.cursor??null,summaryOnly:i.mode==='summary'})),
  i=>typeof i.sourceId==='string'&&(i.mode===undefined||i.mode==='summary')&&(i.cursor===undefined||i.cursor===null||typeof i.cursor==='string'&&i.cursor.length<=2048),['mode','cursor']),
 ui_source_brief:read(['sourceId'],({repository,auth,input:i})=>json(repository.sourceBrief(auth,i.scope,i.sourceId))),
 ui_artifact_preview:read(['resultId','artifactId'],async({repository,auth,input:i})=>{
  const preview=await previewArtifact(repository.artifactFile(auth,i.scope,i.resultId,i.artifactId));
  // Extraction yields. Revocation/fingerprint checks must happen after it.
  const current=repository.artifactFile(auth,i.scope,i.resultId,i.artifactId);
  if(current.receipt.sha256!==preview.sha256)denied();return json(preview);
 }),
 artifact_file:read(['resultId','artifactId'],({repository,auth,input:i})=>{
  const {receipt,bytes}=repository.artifactFile(auth,i.scope,i.resultId,i.artifactId);return file(bytes,receipt.name.replace(/[\\/]/g,'_'));
 }),
 source_file:read(['sourceId'],async({repository,auth,input:i})=>{
  const repo=await repository.forScope(auth,i.scope),{blob,bytes}=await repo.getBlob(i.sourceId);
  const name=`source-${blob.sha256.slice(0,12)}.${sourceExtension(blob.format)}`;
  return file(bytes,name,{'X-Synplex-Source-Format':blob.format,'Content-Disposition':`attachment; filename="${name}"`});
 }),
 ui_note_preview:read(['claimId'],({repository,auth,input:i})=>json(noteExport(repository,auth,i.scope,i.claimId))),
 ui_note_file:read(['claimId','expectedSelectionHash'],({repository,auth,input:i})=>{
  if(!/^[a-f0-9]{64}$/.test(i.expectedSelectionHash))denied();
  const note=noteExport(repository,auth,i.scope,i.claimId,i.expectedSelectionHash);
  return file(Buffer.from(note.text),note.name,{'Content-Type':'text/markdown; charset=utf-8','X-Synplex-Content-Hash':note.sha256});
 }),
 ui_project_preview:read(['claimIds','title','includeEvidence'],({repository,auth,input:i})=>json(projectExpression(repository,auth,i.scope,i)),validExpressionInput),
 ui_project_file:read(['claimIds','title','includeEvidence','expectedSelectionHash'],({repository,auth,input:i})=>{
  const preview=projectExpression(repository,auth,i.scope,i);
  return file(Buffer.from(preview.html),preview.name,{'Content-Type':'text/html; charset=utf-8','X-Synplex-Content-Hash':preview.sha256});
 },i=>validExpressionInput(i)&&/^[a-f0-9]{64}$/.test(i.expectedSelectionHash)),
};

// Fixed read-only dispatch; callers cannot choose repository method names.
// Transport/authentication/Origin checks remain in http.mjs; each repository
// method continues to enforce the current credential and exact project scope.
export async function handleReadRoute({path,repository,auth,input}){
 const name=path.replace(/^\/api\/v1\//,'');if(!Object.hasOwn(routes,name))return null;const route=routes[name];
 const required=[...route.keys,'protocolVersion','scope'],allowed=[...required,...route.optional];
 if(auth.kind!=='ui'||!input||required.some(k=>!Object.hasOwn(input,k))||Object.keys(input).some(k=>!allowed.includes(k))||input.protocolVersion!==PROTOCOL_VERSION||!route.valid(input))denied();
 return route.handler({repository,auth,input});
}
