import {bindModelCatalog} from './model-catalog.js';
import {modelPriceEditor,readModelPrice} from './model-price-editor.js';
import {errorText} from './user-copy.js';

export const modelSettingsButton=capabilities=>capabilities.modelConnections?'<button type="button" data-open-model-settings data-ai-id="model-settings" data-ai-role="action" data-ai-action="open_model_settings" data-tip="选择内置模型，或添加自己使用的模型连接">模型设置</button>':'';
const efforts=[['none','不思考'],['low','轻量'],['medium','标准'],['high','深入'],['xhigh','更深入'],['max','最深入']];
function modelRow(model,esc){
  const value=model||{id:'',name:'',capabilities:{tools:false,stream:true,efforts:[],contextWindow:32000}};
  return `<fieldset class="model-row" data-ai-context="model-type:${esc(value.id||crypto.randomUUID())}"><legend>型号</legend><label>型号名称<input name="model" required maxlength="160" value="${esc(value.id)}" placeholder="按服务商提供的名称填写"></label><label>显示名称<input name="modelName" required maxlength="80" value="${esc(value.name)}" placeholder="方便自己辨认的名称"></label><details><summary>型号能力</summary><p class="subtle">请按服务商说明填写；保存不代表已经验证。</p><label class="check"><input type="checkbox" name="tools" ${value.capabilities.tools?'checked':''}>可执行任务</label><label class="check"><input type="checkbox" name="stream" ${value.capabilities.stream?'checked':''}>逐字显示回复</label><label>参考资料容量<input type="number" name="context" min="1024" max="2000000" value="${value.capabilities.contextWindow}" required></label><span>可选思考程度</span><div class="button-row">${efforts.map(([id,label])=>`<label class="check"><input type="checkbox" name="effort" value="${id}" ${value.capabilities.efforts.includes(id)?'checked':''}>${label}</label>`).join('')}</div></details>${modelPriceEditor(value.pricing,esc)}<button type="button" data-model-remove data-ai-action="remove_model_type">移除型号</button></fieldset>`;
}
function editor(connection,admin,esc){
  return `<div class="dialog-header"><h2>${connection?'修改模型':'添加模型'}</h2><button type="button" data-model-back data-ai-action="back_to_models">返回</button></div><form id="model-settings-form" autocomplete="off"><label>连接名称<input name="name" maxlength="80" required value="${esc(connection?.name||'')}" placeholder="例如：我的常用模型"></label>${admin&&!connection?'<label>谁可以使用<select name="kind"><option value="personal">仅自己</option><option value="builtin">工作台内的用户</option></select></label>':''}<label>服务地址<input name="endpoint" type="url" required value="${esc(connection?.endpoint||'')}" placeholder="服务商提供的安全地址"></label><label>${connection?'更换密钥（选填）':'访问密钥'}<input name="secret" type="password" ${connection?'':'required'} minlength="8" maxlength="4096" autocomplete="new-password" spellcheck="false"></label><p class="subtle">密钥加密保存，不显示给其他用户。${connection?'不更换密钥可留空；更换服务地址或连接方式时需要重填。':''}</p><button type="button" data-model-catalog data-ai-action="fetch_available_models">获取可用型号</button><p class="subtle" data-model-catalog-status role="status">先填地址和密钥，再从账号开放的型号中选择。这里只查询型号，不生成回复。</p><div id="model-rows">${(connection?.models||[null]).map(m=>modelRow(m,esc)).join('')}</div><button type="button" id="add-model-row">添加其他型号</button><details><summary>更多设置</summary><label>连接方式<select name="protocol"><option value="chat-completions" ${connection?.protocol==='chat-completions'?'selected':''}>通用对话</option><option value="responses" ${connection?.protocol==='responses'?'selected':''}>新版对话</option></select></label><p class="subtle">分别对应服务商文档中的 Chat Completions 和 Responses。其他连接方式暂不开放。</p><label>每次回复长度上限<input name="maxOutputTokens" type="number" min="16" max="32768" value="${connection?.maxOutputTokens||4096}" required></label><p class="subtle">上限同时包含模型思考和最终内容。制作文件建议至少4096；提高上限不代表每次都会用满，费用按实际用量计算。</p></details><p role="alert" aria-live="polite"></p><div class="form-bottom"><span class="subtle">只保存，不发送试用请求。</span><button class="primary">保存连接</button></div></form>`;
}
function readConfig(form){
  const data=new FormData(form);
  const models=[...form.querySelectorAll('.model-row')].map(row=>({id:row.querySelector('[name=model]').value,name:row.querySelector('[name=modelName]').value,...readModelPrice(row),capabilities:{tools:row.querySelector('[name=tools]').checked,stream:row.querySelector('[name=stream]').checked,contextWindow:Number(row.querySelector('[name=context]').value),efforts:[...row.querySelectorAll('[name=effort]:checked')].map(input=>input.value)}}));
  return {name:String(data.get('name')),endpoint:String(data.get('endpoint')),protocol:String(data.get('protocol')),maxOutputTokens:Number(data.get('maxOutputTokens')),models};
}
function cards(connections,kind,admin,esc){
  const items=connections.filter(c=>c.kind===kind);
  return `<section><h3>${kind==='builtin'?'内置模型':'我的模型'}</h3>${items.length?items.map(c=>`<article class="record" data-model-id="${esc(c.id)}" data-ai-context="model-connection:${esc(c.id)}"><h4>${esc(c.name)} <span class="tag">${c.enabled?'已启用':'已停用'}</span></h4><p>${c.models.map(m=>esc(m.name)).join('、')}</p><p class="subtle">能力与费用以实际请求和服务商记录为准。</p><div class="button-row">${kind==='personal'||admin?`<button type="button" data-model-edit data-ai-action="edit_model">修改</button><button type="button" data-model-change="${c.enabled?'disable':'enable'}" data-ai-action="${c.enabled?'disable_model':'enable_model'}">${c.enabled?'停用':'启用'}</button><button type="button" data-model-change="delete" data-ai-action="delete_model">删除</button>`:''}${c.enabled?'<button type="button" data-model-probe data-ai-action="try_model">试用一次</button>':''}</div></article>`).join(''):'<p class="subtle">还没有连接。</p>'}</section>`;
}
export function bindModelSettings({app,dialog,request,getScope,esc,onChanged=()=>{}}){
  let currentScope=null,generation=0,connections=[],admin=false;
  const api=(path,body)=>request(path,{...body,scope:currentScope});
  const same=token=>generation===token&&JSON.stringify(getScope())===JSON.stringify(currentScope);
  const show=html=>{dialog.innerHTML=html;if(!dialog.open)dialog.showModal();};
  dialog.addEventListener('close',()=>{generation++;});
  async function list(){
    const token=++generation;
    show('<h2>模型设置</h2><p role="status">正在读取模型连接…</p><button type="button" id="close-model-settings">关闭</button>');
    dialog.querySelector('button').onclick=()=>dialog.close();
    try{
      const data=await api('ui_models',{});if(!same(token))return;connections=data.connections;admin=data.canManageBuiltin;
      show(`<div class="dialog-header"><h2>模型设置</h2><button type="button" id="close-model-settings">关闭</button></div><p>可使用内置模型，也可完全使用自己的连接。</p><button type="button" class="primary" id="new-model-connection">添加模型</button><p role="alert" aria-live="polite"></p>${cards(connections,'builtin',admin,esc)}${cards(connections,'personal',admin,esc)}`);
      dialog.querySelector('#close-model-settings').onclick=()=>dialog.close();
      dialog.querySelector('#new-model-connection').onclick=()=>edit(null);
      for(const card of dialog.querySelectorAll('[data-model-id]'))bindCard(card,connections.find(c=>c.id===card.dataset.modelId));
    }catch(error){if(same(token))show(`<h2>模型设置</h2><p role="alert">${esc(errorText(error))}</p><button type="button" id="close-model-settings">关闭</button>`);dialog.querySelector('#close-model-settings')?.addEventListener('click',()=>dialog.close());}
  }
  function edit(connection){
    generation++;show(editor(connection,admin,esc));const form=dialog.querySelector('form'),requestId=crypto.randomUUID();
    dialog.querySelector('[data-model-back]').onclick=list;
    const catalog=bindModelCatalog({form,api,esc,connection});
    dialog.querySelector('#add-model-row').onclick=()=>{form.querySelector('#model-rows').insertAdjacentHTML('beforeend',modelRow(null,esc));catalog.apply();};
    form.addEventListener('click',e=>{if(e.target.matches('[data-model-remove]')&&form.querySelectorAll('.model-row').length>1)e.target.closest('.model-row').remove();});
    form.onsubmit=async e=>{
      e.preventDefault();const token=generation,button=form.querySelector('[type=submit],button.primary');button.disabled=true;
      try{
        const data=new FormData(form);await api('ui_save_model',{requestId,id:connection?.id??null,revision:connection?.revision??null,kind:connection?.kind||String(data.get('kind')||'personal'),config:readConfig(form),secret:String(data.get('secret'))||(connection?null:'')});
        form.elements.secret.value='';if(same(token)){onChanged();await list();}
      }catch(error){form.querySelector('[role=alert]').textContent=errorText(error);}finally{button.disabled=false;}
    };
  }
  function bindCard(card,connection){
    card.querySelector('[data-model-edit]')?.addEventListener('click',()=>edit(connection));
    for(const button of card.querySelectorAll('[data-model-change]'))button.onclick=async()=>{
      if(button.dataset.modelChange==='delete'&&!window.confirm('删除这份模型连接？已有任务和用量记录会保留。'))return;
      const token=generation;button.disabled=true;try{await api('ui_change_model',{requestId:crypto.randomUUID(),id:connection.id,revision:connection.revision,action:button.dataset.modelChange});if(same(token)){onChanged();await list();}}catch(error){if(same(token))dialog.querySelector('[role=alert]').textContent=errorText(error);button.disabled=false;}
    };
    card.querySelector('[data-model-probe]')?.addEventListener('click',()=>probe(connection));
  }
  function probe(connection){
    generation++;const requestId=crypto.randomUUID();
    show(`<div class="dialog-header"><h2>试用一次</h2><button type="button" data-model-back data-ai-action="back_to_models">返回</button></div><form><label>型号<select name="model">${connection.models.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}</select></label><p>只发送一条简短请求，可能产生少量费用。不会自动重试或改用其他模型。</p><label class="check"><input type="checkbox" name="consent" required>我同意本次可能产生费用</label><p role="status" aria-live="polite"></p><button class="primary">开始试用</button></form>`);
    dialog.querySelector('[data-model-back]').onclick=list;const form=dialog.querySelector('form');
    form.onsubmit=async e=>{
      e.preventDefault();const button=form.querySelector('button');button.disabled=true;form.querySelector('[role=status]').textContent='正在等待模型回复…';
      try{const result=await api('ui_probe_model',{requestId,consent:form.elements.consent.checked,selection:{connectionId:connection.id,model:form.elements.model.value,effort:null}});form.querySelector('[role=status]').textContent=result.notice;}
      catch(error){form.querySelector('[role=status]').textContent=errorText(error);}finally{button.textContent='查看本次结果';button.disabled=false;}
    };
  }
  app.addEventListener('click',event=>{
    if(!event.target.closest('[data-open-model-settings]'))return;
    event.preventDefault();event.stopImmediatePropagation();currentScope=structuredClone(getScope());list();
  });
  return {open(){currentScope=structuredClone(getScope());return list();}};
}
