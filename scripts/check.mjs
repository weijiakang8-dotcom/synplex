import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=new Set(process.argv.slice(2));
function run(command,argv){
  const result=spawnSync(command,argv,{cwd:root,stdio:'inherit',env:{...process.env,SYNPLEX_TEST_NO_MODELS:'1'}});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
function sources(dir){
  return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    if(['node_modules','.git','.runtime','.collaboration'].includes(entry.name))return [];
    const path=join(dir,entry.name);
    return entry.isDirectory()?sources(path):entry.isFile()&&/\.(?:mjs|js)$/.test(path)?[path]:[];
  });
}
if(args.has('--assets')){
  const file=join(root,'.runtime/resource-audit/local-source-manifest.json');
  if(!existsSync(file))throw new Error('本机旧资产清单缺失，不能跳过资产核验。');
  const manifest=JSON.parse(readFileSync(file,'utf8'));
  const protectedFiles=manifest.files.filter(f=>['agenthub','synplex','weave'].includes(f.product));
  if(protectedFiles.length!==711)throw new Error('旧资产清单数量不符，请先核对基线。');
  for(const f of protectedFiles){
    if(!existsSync(f.path)||createHash('sha256').update(readFileSync(f.path)).digest('hex')!==f.sha256)
      throw new Error(`旧资产发生变化：${f.path}`);
  }
  process.stdout.write('711份旧资产指纹一致。\n');
}
if(!args.has('--assets-only')){
  for(const file of sources(root))run(process.execPath,['--check',file]);
  run('git',['diff','--check']);
  run(process.execPath,['scripts/quality/module-links.mjs']);
  run(process.execPath,['scripts/quality/maintainability.mjs','check']);
  if(!args.has('--static-only'))run(process.execPath,['--import','./scripts/testing/offline.mjs','--test']);
}
