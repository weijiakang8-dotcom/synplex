import {errorText} from './user-copy.js';

export function curationControls(history,esc){
 const latest=history.curations?.[0],incomplete=latest?.status==='prepared';
 return `<div class="button-row"><button type="button" data-curate-sources="${incomplete?esc(latest.id):''}" data-ai-id="sources:curate" data-ai-action="curate_sources" data-tip="使用所选模型分批整理项目重点，产生待核对记录；原文和人工判断保留">${incomplete?'查看整理进度':'整理重点'}</button><small data-curation-notice role="status">${latest?esc(latest.notice):'先按规则筛选，再由模型合并完整事件；会使用模型额度。'}</small></div>`;
}
export function bindSourceCuration({app,request,getScope,getHistory,getSelection,refresh,render,notify}){
 let running=false;
 async function run(button){
  if(running)return;running=true;button.disabled=true;const scope=structuredClone(getScope()),notice=app.querySelector('[data-curation-notice]');
  try{
   let result;
   if(button.dataset.curateSources)result=await request('ui_curate_state',{scope,id:button.dataset.curateSources});
   else{
    const models=await request('ui_models',{scope}),preferred=getSelection(),connection=models.connections.find(c=>c.id===preferred?.connectionId&&c.enabled)??models.connections.find(c=>c.enabled);
    if(!connection)throw Error('先添加可用模型，再整理资料。');
    const selection=preferred?.connectionId===connection.id?preferred:{connectionId:connection.id,model:connection.models[0].id,effort:null};
    result=await request('ui_curate_start',{scope,requestId:crypto.randomUUID(),expectedStateRevision:getHistory().state.stateRevision,selection});
   }
   while(['queued','running'].includes(result.status)){
    if(notice)notice.textContent='正在后台整理项目重点，离开页面也会继续。';
    await new Promise(resolve=>setTimeout(resolve,1000));result=await request('ui_curate_state',{scope,id:result.id});
   }
   if(JSON.stringify(scope)===JSON.stringify(getScope())){await refresh();render();notify(result.status==='completed'?`已将 ${result.inputCount} 条线索整理成 ${result.outputCount} 条待核对记录。`:result.notice);}
  }catch(error){notify(errorText(error));}
  finally{running=false;button.disabled=false;}
 }
 app.addEventListener('click',event=>{const button=event.target.closest('[data-curate-sources]');if(!button)return;event.stopImmediatePropagation();run(button);});
}
