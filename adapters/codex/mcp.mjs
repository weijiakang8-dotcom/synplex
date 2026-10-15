import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { WorkspaceConnector, validateScope } from './connector.mjs';

let connector,configuredScope;
function client() {
  return connector??=new WorkspaceConnector({endpoint:process.env.SYNPLEX_WORKSPACE_URL,tokenFile:process.env.SYNPLEX_WORKSPACE_TOKEN_FILE,
    scope:configuredScope??=validateScope(JSON.parse(process.env.SYNPLEX_WORKSPACE_SCOPE??'null'))});
}
const definitions=JSON.parse(readFileSync(new URL('./tools.json',import.meta.url),'utf8'));
const supported=['2024-11-05','2025-03-26','2025-06-18'];
let initialized=false;
let negotiatedVersion='2025-06-18';
const calls=new Map();
const write=value=>process.stdout.write(JSON.stringify(value)+'\n');
const reply=(id,result)=>write({jsonrpc:'2.0',id,result});
const rpcError=(id,code,message)=>write({jsonrpc:'2.0',id,error:{code,message}});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{
  if(Buffer.byteLength(line)>2*1024*1024+4096){rpcError(null,-32600,'提交内容太大，请减少内容后再试。');return;}
  let message;try{message=JSON.parse(line);}catch{rpcError(null,-32700,'提交内容的格式无法读取。');return;}
  const validId=message&&(['string','number'].includes(typeof message.id)||message.id===null);
  if(!message||typeof message!=='object'||Array.isArray(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||message.id!==undefined&&!validId){rpcError(validId?message.id:null,-32600,'提交内容不完整或格式不正确。');return;}
  if(message.method==='notifications/cancelled'){calls.get(message.params?.requestId)?.abort();return;}
  if(message.id===undefined)return;
  if(message.method==='initialize') {
    initialized=true;negotiatedVersion=supported.includes(message.params?.protocolVersion)?message.params.protocolVersion:'2025-06-18';reply(message.id,{protocolVersion:negotiatedVersion,capabilities:{tools:{}},serverInfo:{name:'synplex-workspace',version:'0.1.0'}});return;
  }
  if(!initialized){rpcError(message.id,-32002,'请先连接项目，再使用这些功能。');return;}
  if(message.method==='ping'){reply(message.id,{});return;}
  if(message.method==='tools/list') {
    try {
      const scope=client().scope;
      const tools=definitions.map(tool=>({...tool,inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,scope:{...tool.inputSchema.properties.scope,const:scope}}}}));
      reply(message.id,{tools});
    }catch{rpcError(message.id,-32603,'请先连接你的 Synplex 项目。');}
    return;
  }
  if(message.method!=='tools/call'){rpcError(message.id,-32601,'没有这个操作，请选择可用功能。');return;}
  if(calls.has(message.id)){rpcError(message.id,-32600,'这次提交正在处理，请先查看进度，不要重复提交。');return;}
  const control=new AbortController();calls.set(message.id,control);
  void (async()=>{
    try{
      const value=await client().call(message.params?.name,message.params?.arguments??{},control.signal);
      reply(message.id,{content:[{type:'text',text:JSON.stringify(value)}],...(negotiatedVersion==='2025-06-18'?{structuredContent:value}:{})});
    }catch(error){
      const feedback={code:error.code??'capability_unavailable',message:error.code?error.message:'项目连接尚未配置。',nextAction:error.nextAction??'请连接当前项目，不要修改其他正在使用的工具。',retry:error.retry??'after_input',operationId:error.operationId??null};
      reply(message.id,{isError:true,content:[{type:'text',text:JSON.stringify(feedback)}]});
    }finally{calls.delete(message.id);}
  })();
});
lines.on('close',()=>{for(const call of calls.values())call.abort();});
