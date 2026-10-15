// Free regression runs must not send authenticated model requests.
// Test servers bind loopback; externally hosted validation is a separate, budgeted operation.
if(process.env.SYNPLEX_TEST_NO_MODELS==='1'){
  const original=globalThis.fetch;
  globalThis.fetch=(input,options)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      throw new Error('免费检查禁止访问外部服务；真实模型验收需使用单独的预算流程。');
    return original(input,options);
  };
}
