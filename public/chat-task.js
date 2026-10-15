import {modelCostText} from './model-cost.js';
import {errorText} from './user-copy.js';
import {outputTablePreview} from './output-table.js';
import {effortLabel} from './execution-selection.js';

const labels={queued:'等待回复',running:'正在回复',completed:'已完成',stopped:'已停止',failed:'未发送',unknown:'需要核对',reviewed:'已保留记录'};
const storageKey=scope=>'synplex-chat:'+JSON.stringify(scope);
const read=(storage,key)=>{try{return JSON.parse(storage.getItem(key)||'null');}catch{return null;}};
const save=(storage,key,value)=>{try{storage.setItem(key,JSON.stringify(value));}catch{/* Server remains authoritative. */}};
function modelChoices(connections){return connections.filter(c=>c.enabled).flatMap(c=>c.models.map(m=>({...m,connectionId:c.id,connectionName:c.name,kind:c.kind})));}
function backgroundCard(value,esc){
  const packet=value.background;if(!packet)return '';
  const records=[...packet.facts,...packet.failures,...packet.lessons,...packet.candidates];
  return `<details class="chat-background"><summary>本次参考 · ${records.length} 条记录</summary>${records.map(c=>`<article><p>${esc(c.body)}</p><small>${c.reviewStatus==='confirmed'?'已确认':'待核对'} · ${esc(c.title)}</small></article>`).join('')||'<p class="subtle">没有加入项目记录。</p>'}${packet.unknowns.map(n=>`<p class="subtle">${esc(n)}</p>`).join('')}${value.historyLimited?'<p class="subtle">本次带入最近20轮完整对话，更早的记录仍保留。</p>':''}</details>`;
}
function messageMarkup(items,esc){
  return items.map(item=>`<article class="chat-turn" data-chat-request="${esc(item.id)}" data-ai-id="chat-request:${esc(item.id)}" data-ai-role="conversation_turn" data-ai-state="${esc(item.status)}"><section class="chat-user"><h3>你</h3><p class="excerpt">${esc(item.content)}</p></section><section class="chat-answer"><h3>Synplex <span class="tag">${labels[item.status]||'需要核对'}</span></h3>${item.answer?outputTablePreview({text:item.answer,name:'回复.md',mediaType:'text/markdown'},esc):`<p class="subtle" role="status">${['queued','running'].includes(item.status)?'正在等待回复…':'这次没有完整回复。'}</p>`}<small>${esc(item.notice)}</small>${['queued','running'].includes(item.status)?'<button type="button" data-chat-action="stop" data-ai-action="chat_stop">停止</button>':''}${item.status==='unknown'?'<p class="notice">这次回复与费用尚需核对。请先查看服务商记录，不要重新发送原问题。</p><button type="button" data-chat-action="review" data-ai-action="chat_review">已核对，保留记录</button>':''}${backgroundCard(item,esc)}${item.usage?`<details><summary>本次用量</summary><p>输入 ${item.usage.inputTokens??'未知'}，输出 ${item.usage.outputTokens??'未知'}。${esc(modelCostText(item.usage,item.selection.priceSnapshot,item.createdAt))}。</p></details>`:''}</section></article>`).join('');
}
function composer(state,choices,esc){
  const selected=choices.findIndex(m=>m.connectionId===state.selection?.connectionId&&m.id===state.selection?.model),choice=choices[selected];
  return `<form id="chat-form" data-ai-context="chat-composer"><label class="sr-only" for="chat-content">消息</label><textarea id="chat-content" name="content" maxlength="16000" rows="3" placeholder="说说你想了解或完成什么…" required>${esc(state.content||'')}</textarea><div class="chat-controls"><label>模型<select name="choice" required><option value="">选择模型</option>${choices.map((m,i)=>`<option value="${i}" ${i===selected?'selected':''}>${esc(m.connectionName)} · ${esc(m.name)}</option>`).join('')}</select></label>${choice?.capabilities.efforts.length?`<label>思考<select name="effort"><option value="">默认</option>${choice.capabilities.efforts.map(e=>`<option value="${esc(e)}" ${state.selection?.effort===e?'selected':''}>${esc(effortLabel(e))}</option>`).join('')}</select></label>`:''}<button type="button" data-open-model-settings data-tip="添加或管理自己的模型连接">模型设置</button><button class="primary" type="submit" ${!choices.length||state.sending?'disabled':''}>发送</button></div><p role="alert" aria-live="polite"></p><small class="subtle">Enter 发送，Shift + Enter 换行。对话不会执行外部操作。</small>${!choices.length?'<p class="notice">还没有可用的模型。请先打开“模型设置”，添加自己的连接；管理员也可以设置内置模型。</p>':''}</form>`;
}
export function createChatTask({app,request,getScope,getCapabilities,render,storage,esc,onUseConversation}){
  const states=new Map();let generation=0,timer=null;
  const key=()=>storageKey(getScope());
  function state(){const k=key();if(!states.has(k))states.set(k,{mode:'execute',content:'',conversationId:null,selection:null,...read(storage,k),items:[],conversations:[],choices:[],cursor:null});return states.get(k);}
  function persistFor(s,scope){save(storage,storageKey(scope),{mode:s.mode,content:s.content,conversationId:s.conversationId,selection:s.selection,pending:s.pending,createId:s.createId});}
  function persist(){persistFor(state(),getScope());}
  function stopPolling(){generation++;clearTimeout(timer);timer=null;}
  function formState(){
    const form=app.querySelector('#chat-form');if(!form||app.querySelector('#task-chat-panel')?.hidden)return;
    const s=state(),choice=s.choices[Number(form.elements.choice.value)];s.content=form.elements.content.value;
    if(form.elements.choice.options.length<2){persist();return;}
    if(form.elements.choice.value!==''&&choice)s.selection={connectionId:choice.connectionId,model:choice.id,effort:form.elements.effort?.value||null};else s.selection=null;
    persist();
  }
  function renderMessages(){
    const root=app.querySelector('#chat-messages');if(!root)return;const s=state(),open=new Set([...root.querySelectorAll('[data-chat-request] .chat-background[open]')].map(el=>el.closest('[data-chat-request]').dataset.chatRequest));
    root.innerHTML=s.items.length?messageMarkup(s.items,esc):'<div class="chat-empty"><h2>从一个问题开始</h2><p class="subtle">聊清想法，再切换“执行任务”得到真正的成果。</p></div>';
    for(const id of open)root.querySelector(`[data-chat-request="${CSS.escape(id)}"] .chat-background`)?.setAttribute('open','');
    const previous=app.querySelector('[data-chat-action=earlier]');if(previous)previous.hidden=!s.cursor;
    const send=app.querySelector('#chat-form [type=submit]');if(send)send.disabled=!s.choices.length||s.items.some(i=>['queued','running','unknown'].includes(i.status));
  }
  async function reload(token){
    const s=state(),scope=structuredClone(getScope());
    if(s.conversationId){const history=await request('ui_chat_history',{scope,conversationId:s.conversationId,cursor:null});if(token!==generation)return;if(!s.conversations.some(c=>c.id===history.conversation.id))s.conversations.unshift(history.conversation);renderConversations();s.items=history.items;s.cursor=history.cursor;renderMessages();}
    const active=s.items.some(i=>['queued','running'].includes(i.status));
    if(active&&token===generation)timer=setTimeout(()=>poll(token).catch(showError),500);
  }
  async function poll(token){
    const s=state(),item=s.items.find(i=>['queued','running'].includes(i.status));if(!item||token!==generation)return;
    const page=await request('ui_chat_events',{scope:structuredClone(getScope()),id:item.id,cursor:item.sequence});if(token!==generation)return;
    for(const event of page.events){item.answer+=event.delta;item.sequence=event.sequence;item.status=event.status;item.notice=event.notice;}
    if(item.sequence===page.sequence){item.status=page.status;item.notice=page.notice;item.usage=page.usage;item.costUsd=page.costUsd;}
    renderMessages();if(['queued','running'].includes(item.status)||item.sequence<page.sequence)timer=setTimeout(()=>poll(token).catch(showError),500);
  }
  function showError(error){const target=app.querySelector('#chat-form [role=alert]');if(target)target.textContent=errorText(error);}
  function renderConversations(){
    const s=state(),select=app.querySelector('#chat-conversation');if(!select)return;
    select.innerHTML='<option value="">新对话</option>'+s.conversations.map(c=>`<option value="${esc(c.id)}" ${s.conversationId===c.id?'selected':''}>${esc(c.title)}</option>`).join('');
    const more=app.querySelector('[data-chat-action=more-conversations]');if(more)more.hidden=!s.listCursor;
  }
  async function hydrate(token){
    const scope=structuredClone(getScope()),s=state();
    try{
      const [models,chats]=await Promise.all([request('ui_models',{scope}),request('ui_chat_list',{scope,cursor:null})]);if(token!==generation)return;
      s.choices=modelChoices(models.connections);s.conversations=chats.items;s.listCursor=chats.cursor;
      renderConversations();
      app.querySelector('#chat-composer').innerHTML=composer(s,s.choices,esc);await reload(token);
      if(s.pending)app.querySelector('#chat-form [role=alert]').innerHTML='上一条消息需要核对。<button type="button" data-chat-action="lookup" data-ai-action="chat_lookup">查看原消息</button>';
    }catch(error){if(token===generation)showError(error);}
  }
  async function send(form){
    formState();const s=state(),scope=structuredClone(getScope());if(!s.selection)throw Error('请先选择模型。');
    if(s.sending||s.pending)throw Error('上一条消息还需要核对。请先查看原消息，不要重复发送。');
    const content=s.content,selection=structuredClone(s.selection);s.sending=true;
    try{
      if(!s.conversationId){const createId=s.createId||crypto.randomUUID();s.createId=createId;persistFor(s,scope);const created=await request('ui_chat_create',{scope,requestId:createId});s.conversationId=created.id;s.createId=null;persistFor(s,scope);}
      const pending={conversationId:s.conversationId,requestId:crypto.randomUUID(),content,selection,excludedClaimIds:[]};s.pending=pending;persistFor(s,scope);
      try{await request('ui_chat_send',{scope,...pending});}catch(error){if(error.status>=400&&error.status<500){s.pending=null;persistFor(s,scope);}throw error;}
      s.pending=null;if(s.content===pending.content)s.content='';persistFor(s,scope);
      if(JSON.stringify(scope)!==JSON.stringify(getScope()))return;
      form.elements.content.value=s.content;stopPolling();await hydrate(generation);
    }finally{s.sending=false;}
  }

  async function earlier(kind,s,scope,token){
    if(kind==='more-conversations'){const page=await request('ui_chat_list',{scope,cursor:s.listCursor});if(token!==generation)return;s.conversations=[...s.conversations,...page.items.filter(c=>!s.conversations.some(old=>old.id===c.id))];s.listCursor=page.cursor;renderConversations();return;}
    if(kind==='earlier'){const page=await request('ui_chat_history',{scope,conversationId:s.conversationId,cursor:s.cursor});if(token!==generation)return;s.items=[...page.items,...s.items];s.cursor=page.cursor;renderMessages();return;}
  }
  function useConversation(s){
    if(!s.conversationId||!s.items.length||s.pending||s.items.some(i=>['queued','running','unknown'].includes(i.status)))throw Error('请先等回复结束，或核对未完成的回复。');
    onUseConversation({id:s.conversationId,title:s.conversations.find(c=>c.id===s.conversationId)?.title||'当前对话'});s.mode='execute';persist();render();
  }
  async function action(button){
    const s=state(),scope=structuredClone(getScope()),token=generation,id=button.closest('[data-chat-request]')?.dataset.chatRequest;
    if(button.dataset.chatAction==='use')return useConversation(s);
    if(button.dataset.chatAction==='new'){if(s.pending)throw Error('请先核对上一条消息，再新建对话。');formState();s.conversationId=null;s.items=[];persist();stopPolling();await hydrate(generation);renderMessages();return;}
    if(['more-conversations','earlier'].includes(button.dataset.chatAction))return earlier(button.dataset.chatAction,s,scope,token);
    if(button.dataset.chatAction==='lookup'){
      if(!s.pending)return;const value=await request('ui_chat_lookup',{scope,conversationId:s.pending.conversationId,requestId:s.pending.requestId});if(token!==generation)return;
      if(!value.request){app.querySelector('#chat-form [role=alert]').innerHTML='原消息尚未登记。<button type="button" data-chat-action="submit-original" data-ai-action="chat_submit_original">继续提交原消息</button>';return;}
      if(s.content===s.pending.content)s.content='';s.pending=null;persistFor(s,scope);if(token!==generation)return;stopPolling();await hydrate(generation);return;
    }
    if(button.dataset.chatAction==='submit-original'){if(!s.pending)return;await request('ui_chat_send',{scope,...s.pending});if(s.content===s.pending.content)s.content='';s.pending=null;persistFor(s,scope);if(token!==generation)return;stopPolling();await hydrate(generation);return;}
    if(button.dataset.chatAction==='stop')await request('ui_chat_stop',{scope,id});
    if(button.dataset.chatAction==='review'){if(!window.confirm('确认已经核对原回复？记录会保留，原问题不会重发；费用仍以服务商账单为准。'))return;await request('ui_chat_review',{scope,id,confirmed:true});}
    if(token!==generation)return;stopPolling();await reload(generation);
  }
  app.addEventListener('click',event=>{
    if(event.target.closest('[data-action=logout]')){stopPolling();for(const k of [...states.keys()])storage.removeItem(k);states.clear();return;}
    const mode=event.target.closest('[data-task-mode]'),button=event.target.closest('[data-chat-action]');if(!mode&&!button)return;
    event.preventDefault();event.stopImmediatePropagation();formState();
    if(mode){state().mode=mode.dataset.taskMode;persist();render();return;}
    button.disabled=true;action(button).catch(showError).finally(()=>{button.disabled=false;});
  });
  app.addEventListener('input',event=>{if(event.target.closest('#chat-form'))formState();});
  app.addEventListener('change',event=>{
    if(event.target.closest('#chat-form')){formState();if(event.target.name==='choice')app.querySelector('#chat-composer').innerHTML=composer(state(),state().choices,esc);}
    if(event.target.id==='chat-conversation'){formState();state().conversationId=event.target.value||null;state().items=[];persist();stopPolling();reload(generation).catch(showError);renderMessages();}
  });
  app.addEventListener('keydown',event=>{if(event.target.id!=='chat-content'||event.key!=='Enter'||event.shiftKey)return;event.preventDefault();event.stopImmediatePropagation();event.target.form.requestSubmit();});
  app.addEventListener('submit',event=>{
    if(event.target.id!=='chat-form')return;event.preventDefault();event.stopImmediatePropagation();const form=event.target,button=form.querySelector('[type=submit]');if(button.disabled)return;button.disabled=true;send(form).catch(showError).finally(()=>{button.disabled=false;});
  });
  return {
    refreshModels(){if(app.querySelector('#task-chat-panel')&&state().mode==='chat'){formState();stopPolling();return hydrate(generation);}},
    wrapTask(html,view){
      if(view!=='task'||!getCapabilities().chat)return html;
      const s=state();return `<div class="task-mode" role="group" aria-label="任务方式"><button type="button" data-task-mode="chat" data-ai-action="open_chat" aria-pressed="${s.mode==='chat'}">对话</button><button type="button" data-task-mode="execute" data-ai-action="open_execution" aria-pressed="${s.mode==='execute'}">执行任务</button></div><section id="task-chat-panel" ${s.mode==='chat'?'':'hidden'} data-ai-context="chat"><div class="chat-toolbar"><label>对话<select id="chat-conversation"><option value="">新对话</option></select></label><button type="button" data-chat-action="more-conversations" data-ai-action="chat_more_conversations" hidden>更早的对话</button><button type="button" data-chat-action="new" data-ai-action="chat_new">新对话</button><button type="button" data-chat-action="use" data-ai-action="chat_to_task" data-tip="把当前对话作为参考，再写下要做的任务">带入执行</button></div><button type="button" data-chat-action="earlier" data-ai-action="chat_earlier" hidden>更早的消息</button><div id="chat-messages" aria-live="polite"></div><div id="chat-composer">${composer(s,[],esc)}</div></section><section id="task-execute-panel" ${s.mode==='execute'?'':'hidden'}>${html}</section>`;
    },
    attach(){
      const panel=app.querySelector('#task-chat-panel');if(!panel){stopPolling();return;}
      stopPolling();
      if(state().mode==='chat')hydrate(generation);
    },
  };
}
