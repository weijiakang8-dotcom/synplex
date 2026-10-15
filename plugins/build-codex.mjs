import { mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScope } from '../adapters/codex/connector.mjs';
import {privateTokenPath,reserveBundle,completeBundle} from './bundle-paths.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildCodex(target=join(root,'.runtime','codex-marketplace'),connection=null){
 let configured;
 if(connection){
  const scope=validateScope(connection.scope),url=new URL(connection.endpoint);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||!url.port||url.search||url.hash||url.username||url.password)throw new Error('请使用当前项目的独立本机连接。');
  configured={scope,url,tokenFile:privateTokenPath(connection.agentTokenFile)};
 }
 target=reserveBundle(target,root);
const plugin=join(target,'plugins','synplex-workspace');
mkdirSync(plugin,{recursive:true});
cpSync(join(root,'plugins','codex','synplex-workspace'),plugin,{recursive:true});
mkdirSync(join(plugin,'scripts'),{recursive:true});
for(const name of ['connector.mjs','mcp.mjs','tools.json'])cpSync(join(root,'adapters','codex',name),join(plugin,'scripts',name));
mkdirSync(join(target,'.agents','plugins'),{recursive:true});
writeFileSync(join(target,'.agents','plugins','marketplace.json'),JSON.stringify({name:'synplex-workspace-local',interface:{displayName:'Synplex · 继续项目'},
  plugins:[{name:'synplex-workspace',source:{source:'local',path:'./plugins/synplex-workspace'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'},category:'Productivity'}]},null,2)+'\n');
// Store only paths and scope in a copied, host-recognized asset. No token body or user data enters the bundle.
if(configured) {
  const {scope,url,tokenFile}=configured;
  const manifestPath=join(plugin,'mcp.json'),mcp=JSON.parse(readFileSync(manifestPath,'utf8'));
  mcp.mcpServers['synplex-workspace'].env={SYNPLEX_WORKSPACE_URL:url.origin,SYNPLEX_WORKSPACE_SCOPE:JSON.stringify(scope),SYNPLEX_WORKSPACE_TOKEN_FILE:tokenFile};
  writeFileSync(manifestPath,JSON.stringify(mcp,null,2)+'\n');
}
completeBundle(target);return {marketplace:target,configured:Boolean(connection)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const connectionFile=process.argv[2],target=process.argv[3];console.log(JSON.stringify(buildCodex(target,connectionFile?JSON.parse(readFileSync(resolve(connectionFile),'utf8')):null)));}
