import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve,join } from 'node:path';
import assert from 'node:assert/strict';
const home=resolve('.runtime/codex-install-check');
const child=spawn('codex',['app-server','--listen','stdio://'],{cwd:home,env:{...process.env,CODEX_HOME:home},stdio:['pipe','pipe','pipe']});
const pending=new Map();let next=0,stderr='';child.stderr.on('data',b=>stderr+=b);
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(new Error('Official host request timed out: '+method));},25_000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
try{
 await rpc('initialize',{clientInfo:{name:'synplex_isolated_acceptance',version:'0.2.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');
 const status=await rpc('mcpServerStatus/list',{limit:100,detail:'toolsAndAuthOnly'});
 const matching=(status.data??status.items??[]).filter(x=>x.name?.includes('synplex')||x.serverName?.includes('synplex'));
 const removed=process.argv.includes('--expect-removed');
 if(removed){assert.equal(matching.length,0,'Uninstalled plugin must remove its server');const skills=await rpc('skills/list',{cwds:[home],forceReload:true});assert.equal(JSON.stringify(skills).includes('project-continuity'),false);console.log(JSON.stringify({status:'passed',checks:['uninstalled server absent','uninstalled skill absent'],modelCalls:0}));}
 else{
 assert.ok(matching.length>0,'Installed plugin must actually expose its MCP server');
 const serialized=JSON.stringify(matching);
 for(const name of ['get_project_state','find_evidence','prepare_task','record_result','propose_lesson','get_operation'])assert.ok(serialized.includes(name),'Missing installed tool '+name);
 const skills=await rpc('skills/list',{cwds:[home],forceReload:true});assert.ok(JSON.stringify(skills).includes('project-continuity'),'Installed skill must be discoverable');
 console.log(JSON.stringify({status:'passed',checks:['real installed Codex plugin','official app-server MCP discovery','six connected tools','installed skill discovery'],modelCalls:0,
  limitation:'没有启动模型回合；不代表模型自主接续或业务交付验收。'}));
 }
}finally{child.stdin.end();child.kill('SIGTERM');for(const p of pending.values())clearTimeout(p.timer);}
