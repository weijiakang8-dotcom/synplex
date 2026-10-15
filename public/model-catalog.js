import {errorText} from './user-copy.js';
export function bindModelCatalog({form,api,esc,onChanged,connection=null}){
 let catalog=[],capacities={},generation=0;
 const status=form.querySelector('[data-model-catalog-status]'),button=form.querySelector('[data-model-catalog]');
 function capacity(row,id){
  const value=Object.hasOwn(capacities,id)?capacities[id]:null;
  if(Number.isSafeInteger(value)&&value>=1024&&value<=2_000_000)row.querySelector('[name=context]').value=value;
 }
 function apply(){
  for(const row of form.querySelectorAll('.model-row')){
   const field=row.querySelector('[name=model]');if(!field||!catalog.length)continue;
   const selected=field.value,ids=catalog.includes(selected)?catalog:[...(selected?[selected]:[]),...catalog],select=document.createElement('select');
   select.name='model';select.required=true;select.dataset.aiAction='choose_model_type';
   select.innerHTML='<option value="">选择型号</option>'+ids.map(id=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(id)}</option>`).join('')+'<option value="__manual__">手动填写其他型号…</option>';
   select.addEventListener('change',()=>{
    if(select.value==='__manual__'){const input=document.createElement('input');input.name='model';input.required=true;input.maxLength=160;input.placeholder='按服务商提供的名称填写';select.replaceWith(input);input.focus();return;}
    const name=row.querySelector('[name=modelName]');if(!name.value||catalog.includes(name.value))name.value=select.value;
    capacity(row,select.value);
   });field.replaceWith(select);capacity(row,selected);
  }
 }
 button.onclick=async()=>{
  const endpoint=form.elements.endpoint.value,secret=form.elements.secret.value;
  const reuse=!secret&&connection&&endpoint===connection.endpoint&&form.elements.protocol.value===connection.protocol;
  if(!endpoint||!secret&&!reuse){status.textContent='请先填写服务地址和访问密钥。';return;}
  const token=++generation;button.disabled=true;status.textContent='正在获取可用型号…';
  try{const input=reuse?{selection:{connectionId:connection.id,model:connection.models[0].id,effort:null}}:{endpoint,secret};const result=await api('ui_discover_models',input);if(token!==generation||!form.isConnected)return;catalog=result.models;capacities=result.capacities||{};apply();status.textContent=result.notice;onChanged?.(catalog);}
  catch(error){if(token===generation)status.textContent=errorText(error);}
  finally{if(token===generation)button.disabled=false;}
 };
 for(const name of ['endpoint','secret','protocol'])form.elements[name].addEventListener('input',()=>{generation++;catalog=[];capacities={};button.disabled=false;status.textContent='连接信息已变化，请重新获取型号。';});
 return {apply};
}
