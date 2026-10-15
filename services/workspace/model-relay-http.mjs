import {ProtocolError} from '../../packages/contracts/validate.mjs';
// Private service-to-service route. It accepts only a per-execution grant,
// never the human session cookie, a provider key or a UI-selected URL.
export async function handleModelRelay({req,res,path,relay,parseJSON,send}){
  if(!path.startsWith('/internal/model/v1/'))return false;
  if(!relay||req.method!=='POST'||req.headers.origin||req.headers.cookie||!/^Bearer [A-Za-z0-9_-]{43}$/.test(req.headers.authorization??'')){
    send(res,403,{error:{message:'本次执行连接未获授权。',type:'access_denied'}});return true;
  }
  const suffix=path.slice('/internal/model/v1'.length);
  if(!['/chat/completions','/responses'].includes(suffix)){send(res,404,{error:{message:'没有这项执行连接。'}});return true;}
  const controller=new AbortController(),abort=()=>controller.abort();req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
  try{
    const body=await parseJSON(req,1024*1024),result=await relay.call(req.headers.authorization.slice(7),suffix,body,controller.signal);
    if(!res.destroyed){res.writeHead(200,{'Content-Type':result.contentType,'Content-Length':result.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(result.bytes);}
  }catch(error){
    const budget=error instanceof ProtocolError&&error.code==='budget_exceeded';
    send(res,409,{error:budget?{message:'本次资料或请求次数超过连接限制，请检查模型容量和任务范围。',type:'budget_exceeded'}:{message:'这次模型请求尚需核对；不会自动重新提交。',type:'request_reconciliation_required'}});
  }
  finally{req.removeListener('aborted',abort);}return true;
}
