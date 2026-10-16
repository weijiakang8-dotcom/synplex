import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {ChatService} from './chat-service.mjs';
import {createCurationRoutes} from './curation-routes.mjs';
import {exactObject,modelFailure} from './model-contract.mjs';

const requestId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-f\d-]{36}$/i.test(value);
const cursor=value=>value===null||Number.isSafeInteger(value)&&value>=0;
function valid(input,required,optional=[]){
  exactObject(input,['protocolVersion','scope',...required,...optional]);
  if(required.some(key=>!Object.hasOwn(input,key)))throw modelFailure('操作内容不完整，请重新打开对话。');
}
export function createChatRoutes({repository,execution,transport}){
  const slots=execution?{acquire:signal=>execution.acquireModelSlot(signal)}:undefined;
  const service=new ChatService({repository,slots,transport});
  const curation=createCurationRoutes(repository,service);
  const routes={
    ui_chat_create:{keys:['requestId'],check:i=>requestId(i.requestId),run:(s,i)=>s.create(i.requestId)},
    ui_chat_list:{keys:['cursor'],check:i=>cursor(i.cursor),run:(s,i)=>s.list(i.cursor)},
    ui_chat_lookup:{keys:['conversationId','requestId'],check:i=>id(i.conversationId)&&requestId(i.requestId),run:(s,i)=>({request:s.request(i.conversationId,i.requestId)})},
    ui_chat_history:{keys:['conversationId','cursor'],check:i=>id(i.conversationId)&&cursor(i.cursor),run:(s,i)=>s.history(i.conversationId,i.cursor)},
    ui_chat_events:{keys:['id','cursor'],check:i=>id(i.id)&&Number.isSafeInteger(i.cursor)&&i.cursor>=0,run:(s,i)=>s.events(i.id,i.cursor)},
    ui_chat_stop:{keys:['id'],check:i=>id(i.id),run:(_s,i,a)=>service.stop(a,i.scope,i.id)},
    ui_chat_review:{keys:['id','confirmed'],check:i=>id(i.id)&&i.confirmed===true,run:(s,i)=>s.acknowledge(i.id)},
    ui_chat_send:{keys:['conversationId','requestId','content','selection','excludedClaimIds'],check:i=>id(i.conversationId)&&requestId(i.requestId),run:(_s,i,a)=>service.send(a,i)},
  };
  return {
    async handle({path,auth,input}){
      const curated=await curation({path,auth,input});if(curated)return curated;
      const name=path.slice('/api/v1/'.length);if(!Object.hasOwn(routes,name))return null;
      const route=routes[name];valid(input,route.keys);
      if(auth.kind!=='ui'||input.protocolVersion!==PROTOCOL_VERSION||!route.check(input))throw modelFailure('没有这项对话操作，或内容不完整。');
      const store=repository.chat(auth,input.scope);return {body:await route.run(store,input,auth)};
    },
    close:()=>service.close(),
  };
}
