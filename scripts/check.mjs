import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=new Set(process.argv.slice(2));
function run(command,argv){
  const result=spawnSync(command,argv,{cwd:root,stdio:'inherit',env:{...process.env,SYNPLEX_TEST_NO_MODELS:'1'}});
  if(result.error)throw result.error;
  if(result.status!==0){console.error(`检查子进程未完成：${command} ${argv[0]}，退出码=${result.status??'无'}，信号=${result.signal??'无'}`);process.exit(result.status??1);}
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
  const {auditLegacyAssets}=await import('./quality/legacy-assets.mjs');
  const results=await auditLegacyAssets(protectedFiles),failed=results.filter(r=>r.status!=='unchanged');
  if(failed.length){for(const r of failed)console.error(`${r.status==='changed'?'旧资产发生变化':'旧资产尚未核验'}：${r.path}${r.reason?'；'+r.reason:''}`);throw new Error(`旧资产核验未通过：${results.length-failed.length}份一致，${failed.length}份需处理；未修改任何旧文件。`);}
  process.stdout.write('711份旧资产指纹一致。\n');
}
if(!args.has('--assets-only')){
  for(const file of sources(root))run(process.execPath,['--check',file]);
  run('git',['diff','--check']);
  run(process.execPath,['scripts/quality/module-links.mjs']);
  run(process.execPath,['scripts/quality/maintainability.mjs','check']);
  if(!args.has('--static-only'))run(process.execPath,['--import','./scripts/testing/offline.mjs','--test']);
}
