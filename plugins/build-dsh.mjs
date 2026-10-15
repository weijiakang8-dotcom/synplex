import { mkdirSync,writeFileSync,copyFileSync } from 'node:fs';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConnection,createBridge } from '../adapters/dsh/bridge.mjs';
import {privateTokenPath,reserveBundle,completeBundle} from './bundle-paths.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function buildDsh(target,connectionFile=null) {
  let config;
  if(connectionFile){config=readConnection(resolve(connectionFile));createBridge(config);privateTokenPath(config.tokenFile);}
  target=reserveBundle(target,root);
  for(const relative of ['adapters/dsh/extension.mjs','adapters/dsh/bridge.mjs','adapters/dsh/mcp.mjs','adapters/codex/connector.mjs','adapters/codex/tools.json']){
    const to=join(target,relative);mkdirSync(dirname(to),{recursive:true});copyFileSync(join(root,relative),to);
  }
  mkdirSync(join(target,'skills/project-continuity'),{recursive:true});
  copyFileSync(join(root,'plugins/codex/synplex-workspace/skills/project-continuity/SKILL.md'),join(target,'skills/project-continuity/SKILL.md'));
  copyFileSync(join(root,'adapters/dsh/README.md'),join(target,'README.md'));
  writeFileSync(join(target,'package.json'),JSON.stringify({name:'@synplex/dsh-workspace',version:'0.2.0',type:'module',
    description:'记住关键选择，带着项目背景继续工作。',main:'./adapters/dsh/extension.mjs',exports:{'.':'./adapters/dsh/extension.mjs','./cordis.patch.yml':'./cordis.patch.yml'},
    files:['adapters','skills','cordis.patch.yml','README.md','connection.json'],engines:{node:'>=22'},dsh:{bundle:{patch:'./cordis.patch.yml'}},
    peerDependencies:{'@deepseek-ai/dsh-mcp-client':'0.2.0-rc.2'}},null,2)+'\n');
  writeFileSync(join(target,'cordis.patch.yml'),"- insert:\n    - id: synplex-workspace\n      name: '@synplex/dsh-workspace'\n");
  if(config){
    // Only paths/scope, never credential bytes, are included in a private candidate.
    writeFileSync(join(target,'connection.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
  }
  completeBundle(target);return {target,configured:Boolean(connectionFile)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(buildDsh(process.argv[2]??join(root,'.runtime/dsh-extension'),process.argv[3])));
