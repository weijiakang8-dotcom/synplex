import { readFileSync, lstatSync } from 'node:fs';

const feedback=(code,message,nextAction,retry='never')=>Object.assign(new Error(message),{code,nextAction,retry,operationId:null});
export function validateScope(scope) {
  if(!scope||Object.keys(scope).sort().join(',')!=='branchId,projectId,versionId'||typeof scope.projectId!=='string'||!scope.projectId||
      [scope.versionId,scope.branchId].some(x=>x!==null&&(typeof x!=='string'||!x)))throw feedback('validation_failed','未配置准确的项目范围。','请由维护人员检查所选项目及其版本；未选择版本时使用默认版本。');
  return Object.freeze({projectId:scope.projectId,versionId:scope.versionId,branchId:scope.branchId});
}
export class WorkspaceConnector {
  constructor({endpoint,tokenFile,scope,timeoutMs=60_000}) {
    let url;try{url=new URL(endpoint);}catch{throw feedback('capability_unavailable','项目服务地址无效。','配置已启动的本机服务。');}
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.port)throw feedback('scope_denied','扩展只连接明确配置的本机服务。','使用本机独立端口，不转发到外部服务。');
    this.endpoint=url.origin;this.tokenFile=tokenFile;this.scope=validateScope(scope);this.timeoutMs=timeoutMs;
  }
  #token() {
    try {
      const stat=lstatSync(this.tokenFile);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw new Error();
      const token=readFileSync(this.tokenFile,'utf8').trim();
      if(!/^[A-Za-z0-9_-]{40,128}$/.test(token))throw new Error();
      return token;
    }catch{throw feedback('scope_denied','连接信息缺失或访问权限不正确。','使用当前项目的连接文件，并确保只有你能读取。');}
  }
  async call(name,args,signal) {
    if(!['get_project_state','find_evidence','prepare_task','record_result','propose_lesson','get_operation'].includes(name))throw feedback('validation_failed','扩展没有这项工具。','使用列出的项目记忆工具。');
    if(!args||typeof args!=='object'||Array.isArray(args))throw feedback('validation_failed','工具输入格式无效。','按工具格式提供参数。');
    const scope=args.scope??this.scope;
    if(JSON.stringify(validateScope(scope))!==JSON.stringify(this.scope))throw feedback('scope_denied','这次请求不属于扩展获准的项目。','切换到获准的专属连接，不扩大当前范围。');
    const input={...args,scope},body=JSON.stringify(input);
    if(Buffer.byteLength(body)>2*1024*1024)throw feedback('validation_failed','提交内容超过2兆。','缩小这次任务或使用资料上传入口。','after_input');
    let response;
    try {
      response=await fetch(`${this.endpoint}/api/v1/${name}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${this.#token()}`},
        body,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)});
      const chunks=[];let total=0;
      for await(const chunk of response.body){total+=chunk.length;if(total>8*1024*1024)throw new Error('bounded response');chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!response.ok) {
        if(!value||typeof value.code!=='string'||typeof value.message!=='string'||typeof value.nextAction!=='string')throw new Error('invalid response');
        throw feedback(value.code,value.message,value.nextAction,value.retry??'never');
      }
      return value;
    }catch(error){
      if(error.code&&error.nextAction)throw error;
      throw feedback('conflict','连接中断或响应无法核对，不能判断操作是否已经完成。',
        input.requestId?'保留本次提交的编号和内容，先查看已有处理记录；不要重新开始任务。':'稍后查看原任务进度，不要重新执行。','lookup_operation');
    }
  }
}
