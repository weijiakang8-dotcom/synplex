import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync,renameSync,realpathSync} from 'node:fs';
import {resolve,join,sep,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sha256} from '../../packages/contracts/validate.mjs';
import {canonicalTarget} from './paths.mjs';

const run=(binary,args,options={})=>{const r=spawnSync(binary,args,{encoding:'utf8',...options});if(r.error||r.status!==0)throw new Error('引擎环境检查或安装失败；原环境未改动，请保留安装记录核对。');return r.stdout;};
function lockInfo(backend){
 const file=join(realpathSync(resolve(backend)),'requirements.lock'),bytes=readFileSync(file);
 const pins=[...bytes.toString('utf8').matchAll(/^([a-zA-Z0-9_.-]+)==([^\s;]+)\s*$/gm)].map(([,name,version])=>({name,version}));
 if(pins.length<20||bytes.toString('utf8').split('\n').some(line=>line.trim()&&!line.startsWith('#')&&!/^\s+#/.test(line)&&!/^([a-zA-Z0-9_.-]+)==([^\s;]+)\s*$/.test(line)))throw new Error('依赖清单不是已经评估的完整固定版本，不能安装。');
 return {file,sha256:sha256(bytes),pins};
}
const normalize=name=>name.toLowerCase().replace(/[-_.]+/g,'-');
export function verifyEngineEnvironment(environment,backend){
 environment=realpathSync(resolve(environment));const file=join(environment,'synplex-environment.json'),s=lstatSync(file);
 if(s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid())throw new Error('引擎安装记录需要仅本人可读。');
 const saved=JSON.parse(readFileSync(file)),lock=lockInfo(backend);
 if(saved.format!=='synplex.engine-environment/1'||saved.status!=='complete'||saved.lockSha256!==lock.sha256||existsSync(join(environment,'install-incomplete.json')))throw new Error('引擎环境尚未安装完成，或依赖版本已经改变。');
 const python=join(environment,'bin/python'),rows=JSON.parse(run(python,['-I','-B','-c',`import importlib.metadata,json,sys; import fastapi,uvicorn,sqlalchemy,asyncpg,psycopg,celery,redis,langgraph,deepagents,docx,reportlab; print(json.dumps({'prefix':sys.prefix,'packages':{d.metadata['Name']:d.version for d in importlib.metadata.distributions()}}))`]));
 if(realpathSync(rows.prefix)!==environment)throw new Error('安装检查使用了其他环境。');
 const versions=new Map(Object.entries(rows.packages).map(([name,version])=>[normalize(name),version]));
 if(lock.pins.some(p=>versions.get(normalize(p.name))!==p.version))throw new Error('引擎依赖与固定版本不一致，保留原环境并重新建立独立环境。');
 return {format:saved.format,environment,python,lockSha256:lock.sha256,packagesVerified:lock.pins.length,modelCalls:0};
}
export function installEngineEnvironment({environment,backend,python,uv,pgBin}){
 backend=realpathSync(resolve(backend));environment=canonicalTarget(environment);const lock=lockInfo(backend);
 if(environment===backend||environment.startsWith(backend+sep)||backend.startsWith(environment+sep))throw new Error('引擎环境必须与源码分开。');
 if(existsSync(environment))return verifyEngineEnvironment(environment,backend);
 if(![python,uv,pgBin].every(x=>typeof x==='string'&&x.startsWith('/')))throw new Error('需要明确的Python、安装工具与数据库工具位置；不会改动共享安装。');
 mkdirSync(environment,{recursive:true,mode:0o700});
 const marker=join(environment,'install-incomplete.json');writeFileSync(marker,JSON.stringify({format:'synplex.engine-environment/1',lockSha256:lock.sha256,status:'installing'}),{mode:0o600,flag:'wx'});
 const env={PATH:pgBin+':'+process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,UV_NO_CONFIG:'1',UV_PYTHON_DOWNLOADS:'never',PYTHONDONTWRITEBYTECODE:'1'};
 const log=join(environment,'install.log');
 const command=(binary,args)=>{const r=spawnSync(binary,args,{env,encoding:'utf8',maxBuffer:4*1024*1024});writeFileSync(log,(r.stdout||'')+(r.stderr||''),{mode:0o600,flag:'a'});if(r.error||r.status!==0)throw new Error('独立引擎环境安装未完成，请核对安装记录；原环境未改动。');};
 // No shared cache, system-site-packages, resolver upgrade, or old venv mutation.
 command(uv,['--no-config','--no-cache','venv','--python',python,'--no-python-downloads','--allow-existing',environment]);
 command(uv,['--no-config','--no-cache','pip','sync','--python',join(environment,'bin/python'),lock.file]);
 command(uv,['--no-config','--no-cache','pip','check','--python',join(environment,'bin/python')]);
 writeFileSync(join(environment,'synplex-environment.json'),JSON.stringify({format:'synplex.engine-environment/1',status:'complete',lockSha256:lock.sha256,createdAt:new Date().toISOString(),modelCalls:0}),{mode:0o600,flag:'wx'});
 // Atomically change the marker name; keep evidence rather than deleting it.
 renameSync(marker,join(environment,'install-intent.json'));
 return verifyEngineEnvironment(environment,backend);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const [mode,environment,backend,python,uv,pgBin]=process.argv.slice(2);const result=mode==='verify'?verifyEngineEnvironment(environment,backend):mode==='install'?installEngineEnvironment({environment,backend,python,uv,pgBin}):null;if(!result)throw new Error('请选择install或verify，并提供独立目录与引擎源码位置。');console.log(JSON.stringify(result,null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
