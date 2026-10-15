import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {refreshUiLauncher} from './ui-launch.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const dataDir=resolve(process.env.SYNPLEX_WORKSPACE_DATA_DIR??resolve(root,'.runtime/workspace'));
try{
  const launchFile=await refreshUiLauncher(dataDir);
  console.log(JSON.stringify({launchFile,notice:'入口已刷新，五分钟内打开；已保存的任务不会重新执行。'}));
}catch{
  console.error('入口未刷新。请确认本机工作台已启动，使用相同的数据目录再运行连接命令。');
  process.exitCode=1;
}
