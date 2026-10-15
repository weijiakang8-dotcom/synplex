import {artifactPreviewDialog} from './artifact-view.js';
import {saveVerifiedFile,notePreviewDialog} from './file-save.js';
import {errorText} from './user-copy.js';
import {traceError} from './runtime-status.js';
import {openMaterialQuestion} from './material-question.js';
import {expressionSelection,expressionPreview} from './project-expression.js';
import {EXPRESSION_VERSION_ACTIONS} from './expression-version-actions.js';
import {createSourcePreviewActions,SOURCE_PREVIEW_ACTIONS} from './source-preview.js';

const sameScope=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const savedMessage=result=>result.status==='cancelled'?'已取消保存':result.status==='saved'?'文件已保存到所选位置':'文件已交给浏览器下载，请查看下载文件夹。';
function show(context,html){const {dialog}=context;dialog.innerHTML=html;dialog.querySelector('#close-dialog').onclick=()=>dialog.close();if(!dialog.open)dialog.showModal();}
async function previewArtifact(button,c){
 const ticket=c.beginPreview();button.disabled=true;
 try{
  const preview=await c.request('ui_artifact_preview',{resultId:button.dataset.result,artifactId:button.dataset.id});
  if(!c.previewCurrent(ticket))return;
  show(c,artifactPreviewDialog(preview,c.esc));c.dialog.artifactExport={preview,scope:ticket.scope};
 }finally{button.disabled=false;}
}
async function previewNote(button,c){
 const ticket=c.beginPreview();button.disabled=true;
 try{
  const note=await c.request('ui_note_preview',{claimId:button.dataset.id});if(!c.previewCurrent(ticket))return;
  show(c,notePreviewDialog(note,c.esc));c.dialog.noteExport={note,scope:ticket.scope};
 }finally{button.disabled=false;}
}
async function readBytes(path,body,hash,{checkHeader=false}={}){
 const response=await fetch('/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',...body})});
 if(!response.ok){const value=await response.json(),message=value.code==='stale_context'?'内容或权限已有变化，请重新预览后再保存；原文件仍保留。':errorText(value);throw traceError(new Error(message),response);}
 if(checkHeader&&response.headers.get('X-Synplex-Content-Hash')!==hash)throw new Error('内容已有变化，请重新预览后保存。');
 return {bytes:await response.arrayBuffer(),sha256:hash};
}
async function saveArtifact(button,c){
 const selected=c.dialog.artifactExport,p=selected?.preview;
 if(!p||p.resultId!==button.dataset.result||p.artifactId!==button.dataset.id||!sameScope(selected.scope,c.getScope()))throw new Error('请重新预览这份成果。');
 button.disabled=true;
 try{const result=await saveVerifiedFile(p.name,()=>readBytes('artifact_file',{scope:selected.scope,resultId:p.resultId,artifactId:p.artifactId},p.sha256),{download:c.saveFile});c.notify(savedMessage(result));}finally{button.disabled=false;}
}
async function saveNote(button,c){
 const selected=c.dialog.noteExport,n=selected?.note;
 if(!n||n.claimId!==button.dataset.id||!sameScope(selected.scope,c.getScope()))throw new Error('请重新打开当前项目的记录。');
 button.disabled=true;
 try{const result=await saveVerifiedFile(n.name,()=>readBytes('ui_note_file',{scope:selected.scope,claimId:n.claimId,expectedSelectionHash:n.selectionHash},n.sha256,{checkHeader:true}),{download:c.saveFile});c.notify(savedMessage(result));}finally{button.disabled=false;}
}
function selectProject(button,c){
 if(!c.getHistory().projectExpressions)throw new Error('请更新工作台后再整理项目介绍。');
 const saved=c.dialog.projectExpression,selection=saved&&sameScope(saved.scope,c.getScope())?saved.selection:null;
 show(c,expressionSelection(c.getHistory(),c.getProjectTitle(),c.esc));
 if(c.getHistory().projectExpressionVersions)c.dialog.insertAdjacentHTML('beforeend','<button data-action="expression-versions">确认版本</button>');
 if(selection){const form=c.dialog.querySelector('#project-expression-form');form.elements.title.value=selection.title;form.elements.includeEvidence.checked=selection.includeEvidence;for(const box of form.querySelectorAll('[name=claim]'))box.checked=selection.claimIds.includes(box.value);}
}
async function previewProject(button,c){
 const form=c.dialog.querySelector('#project-expression-form');if(!form?.reportValidity())return;
 const data=new FormData(form),selection={title:String(data.get('title')),claimIds:data.getAll('claim'),includeEvidence:data.has('includeEvidence')};
 if(!selection.claimIds.length||selection.claimIds.length>30)throw new Error('请选择1至30条已确认记录。');
 const ticket=c.beginPreview();button.disabled=true;
 try{const preview=await c.request('ui_project_preview',selection);if(!c.previewCurrent(ticket))return;show(c,expressionPreview(preview,c.esc,{versions:c.getHistory().projectExpressionVersions}));c.dialog.projectExpression={preview,selection,scope:ticket.scope};
 const approved=c.dialog.querySelector('#expression-approved');if(approved)approved.onchange=()=>{c.dialog.querySelector('[data-action=approve-project-expression]').disabled=!approved.checked;};
 }finally{button.disabled=false;}
}
async function saveProject(button,c){
 const saved=c.dialog.projectExpression;
 if(!saved?.preview||!sameScope(saved.scope,c.getScope()))throw new Error('请重新预览当前项目的介绍。');
 button.disabled=true;
 try{const result=await saveVerifiedFile(saved.preview.name,()=>readBytes('ui_project_file',{scope:saved.scope,...saved.selection,expectedSelectionHash:saved.preview.selectionHash},saved.preview.sha256,{checkHeader:true}),{download:c.saveFile});c.notify(savedMessage(result));}finally{button.disabled=false;}
}
const handlers=Object.freeze({'artifact-preview':previewArtifact,'save-artifact-file':saveArtifact,'preview-note-file':previewNote,'save-note-file':saveNote,'ask-material':openMaterialQuestion,
 'project-expression':selectProject,'edit-project-file':selectProject,'preview-project-file':previewProject,'save-project-file':saveProject,...EXPRESSION_VERSION_ACTIONS});
export const FILE_ACTIONS=Object.freeze([...Object.keys(handlers),...SOURCE_PREVIEW_ACTIONS]);
export function createFileActions(context){
 const sourceActions=createSourcePreviewActions(context),actions={...handlers,...sourceActions};
 return {
  projectButton(history){return history.projectExpressions?'<button data-action="project-expression" data-ai-action="open_project_expression" title="选择已确认记录，整理一份可以保存到电脑的项目介绍">项目介绍</button>':'';},
  async handle(button){const action=button.dataset.action;if(!Object.hasOwn(actions,action))return false;await actions[action](button,context);return true;},
  offerNoteSave(record){
   if(context.canExport()&&record?.reviewStatus==='confirmed'&&record.lifecycle==='active')context.dialog.insertAdjacentHTML('beforeend',`<button data-action="preview-note-file" data-id="${context.esc(record.id)}" data-ai-action="preview_note_file" title="先预览这条已确认记录和出处，再保存到电脑">保存这条记录</button>`);
  },
 };
}
