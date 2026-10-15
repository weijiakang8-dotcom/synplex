import {randomBytes} from 'node:crypto';
import {ProtocolError,PROTOCOL_VERSION,sha256} from '../../packages/contracts/validate.mjs';
import {EXPRESSION_CSP} from './project-expression.mjs';

const ttlMs=3600_000;
const unavailable='这份介绍暂时不能打开。链接可能已到期、已停止查看，或工作台已重启。请联系作者重新核对并生成链接。';
const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store, max-age=0','Pragma':'no-cache',
 'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':EXPRESSION_CSP};

// Capabilities live only in this loopback server's memory, not in backups,
// receipts, logs or project context. A restart/restore cannot revive old URLs.
export function createExpressionLinks(repository,{clock=Date.now}={}){
 const links=new Map();
 return {
  clear:()=>links.clear(),
  mutate(path,auth,input){
   const methods={'/api/v1/ui_approve_expression':'approveExpression','/api/v1/ui_stop_expression':'stopExpression'};
   if(Object.hasOwn(methods,path))return {status:path==='/api/v1/ui_approve_expression'?201:200,body:repository[methods[path]](auth,input).value};
   if(path==='/api/v1/ui_expression_link')return {status:200,body:this.create(auth,input)};
   return null;
  },
  create(auth,input){
   if(auth.kind!=='ui'||!input||Object.keys(input).sort().join(',')!=='protocolVersion,scope,versionId'||input.protocolVersion!==PROTOCOL_VERSION||typeof input.versionId!=='string')
    throw new ProtocolError('scope_denied','不能生成这份介绍的查看链接。','从当前项目重新打开已确认的版本。');
   repository.expressionVersion(auth,input.scope,input.versionId,{forLink:true});
   for(const [key,v] of links)if(v.expiresAt<=clock())links.delete(key);
   if(links.size>=1000)throw new ProtocolError('capability_unavailable','本次打开的查看链接过多。','等旧链接到期后再生成。');
   const token=randomBytes(32).toString('hex'),expiresAt=clock()+ttlMs;
   links.set(sha256(Buffer.from(token)),{auth,scope:structuredClone(input.scope),id:input.versionId,expiresAt});
   return {path:'/view/'+token,expiresAt:new Date(expiresAt).toISOString(),notice:'仅限这台电脑，1小时内有效；停止查看、内容或权限改变、工作台重启后失效。'};
  },
  handle(req,res,url){
   if(!url.pathname.startsWith('/view/'))return false;
   let html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>介绍暂不可用</title><body><main><h1>介绍暂不可用</h1><p>${unavailable}</p></main></body></html>`,status=410;
   const match=/^\/view\/([a-f0-9]{64})$/.exec(url.pathname);
   if(req.method==='GET'&&match&&!url.search){
    const key=sha256(Buffer.from(match[1])),entry=links.get(key);
    if(entry&&entry.expiresAt>clock()){
     try{html=repository.expressionVersion(entry.auth,entry.scope,entry.id,{forLink:true}).html;status=200;}
     catch{links.delete(key);} // All invalid views have the same non-private reply.
    }else links.delete(key);
   }
   const bytes=Buffer.from(html);res.writeHead(status,{...headers,'Content-Length':bytes.length});res.end(bytes);return true;
  },
 };
}
