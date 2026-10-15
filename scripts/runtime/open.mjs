import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {settings,supervise,diagnose} from './workspace.mjs';
import {configureProduct,superviseProduct,productConfiguration} from './product.mjs';

export async function openConfigured(config,options){
 return existsSync(join(config.dataDir,'product-start.json'))?superviseProduct(config,options):supervise(config,options);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const config=settings();
  if(process.argv.includes('--check')){
   const result=await diagnose(config);for(const c of result.checks)console.log(`${c.name}：${c.status==='ready'?'就绪':'需要处理'}`);
   if(existsSync(join(config.dataDir,'product-start.json'))){productConfiguration(config);console.log('联合启动设置：已核对；尚未启动服务或执行任务。');}
   console.log(result.execution);process.exitCode=result.ready?0:1;
  }else if(process.argv[2]==='configure-product'){
   await configureProduct(config,{engineRoot:process.argv[3],python:process.argv[4]});console.log('联合启动入口已准备好；没有启动服务或执行任务。');
  }else{
   const managed=await openConfigured(config,{openBrowser:!process.argv.includes('--no-open'),onReady:event=>console.log(event.error||'工作台已就绪。关闭此窗口会正常退出本次启动的服务；任务不会自动重做。')});
   for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>managed.close());await managed.done;
   if(managed.state&&managed.state.status!=='ready'&&managed.state.status!=='starting_engine')process.exitCode=1;
  }
 }catch(error){console.error(error.message);process.exitCode=1;}
}
