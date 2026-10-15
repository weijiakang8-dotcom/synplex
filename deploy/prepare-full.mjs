import {installInstance} from '../scripts/runtime/install-instance.mjs';
await installInstance({directory:'/var/lib/synplex',environment:'/opt/synplex-python',pgBin:'/usr/lib/postgresql/15/bin',valkey:'/usr/bin/redis-server'});
console.log('完整执行环境已核对；模型由工作台设置，没有发送模型请求。');
