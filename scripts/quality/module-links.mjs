import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';

const roots=['services','packages','adapters','public','plugins','integrations','scripts/runtime','scripts/quality'];
const name=node=>node.name??node.value;
function names(pattern){
 if(!pattern)return [];
 if(pattern.type==='Identifier')return [pattern.name];
 if(pattern.type==='RestElement')return names(pattern.argument);
 if(pattern.type==='AssignmentPattern')return names(pattern.left);
 if(pattern.type==='ArrayPattern')return pattern.elements.flatMap(names);
 if(pattern.type==='ObjectPattern')return pattern.properties.flatMap(p=>names(p.type==='RestElement'?p.argument:p.value));
 return [];
}
function declarationNames(declaration){
 if(!declaration)return [];
 return declaration.type==='VariableDeclaration'?declaration.declarations.flatMap(d=>names(d.id)):names(declaration.id);
}
export function moduleBindings(source){
 const ast=parse(source,{ecmaVersion:'latest',sourceType:'module',locations:true}),imports=new Map(),exports=new Map(),stars=[],references=[];
 for(const node of ast.body){
  if(node.type==='ImportDeclaration'){
   references.push({source:node.source.value,line:node.loc.start.line});
   for(const s of node.specifiers)imports.set(s.local.name,{source:node.source.value,name:s.type==='ImportSpecifier'?name(s.imported):s.type==='ImportDefaultSpecifier'?'default':'*',line:node.loc.start.line});
  }
  if(node.type==='ExportNamedDeclaration'){
   for(const local of declarationNames(node.declaration))exports.set(local,{local});
   for(const s of node.specifiers)exports.set(name(s.exported),node.source?{source:node.source.value,name:name(s.local),line:node.loc.start.line}:{local:name(s.local)});
  }
  if(node.type==='ExportDefaultDeclaration')exports.set('default',{local:node.declaration.id?.name??'default'});
  if(node.type==='ExportAllDeclaration'){
   if(node.exported)exports.set(name(node.exported),{source:node.source.value,name:'*',line:node.loc.start.line});
   else stars.push({source:node.source.value,line:node.loc.start.line});
  }
  if(node.type.startsWith('Export')&&node.source)references.push({source:node.source.value,line:node.loc.start.line});
 }
 return {imports,exports,stars,references};
}
const targetPath=(path,specifier)=>specifier.startsWith('.')?resolve(dirname(path),specifier):null;
function importedTargets(modules,path,binding,visited){
 const target=targetPath(path,binding.source);
 if(!target)return new Set(['external:'+binding.source+'::'+binding.name]);
 if(!modules.has(target))return new Set();
 return binding.name==='*'?new Set([target+'::*']):resolveBinding(modules,target,binding.name,visited);
}
function resolveBinding(modules,path,requested,visited=new Set()){
 const id=path+'::'+requested;if(visited.has(id))return new Set();
 const next=new Set(visited).add(id),entry=modules.get(path);if(!entry)return new Set();
 const direct=entry.exports.get(requested);
 if(direct?.source)return importedTargets(modules,path,direct,next);
 if(direct){
  const imported=entry.imports.get(direct.local);
  return imported?importedTargets(modules,path,imported,next):new Set([path+'::'+direct.local]);
 }
 if(requested==='default')return new Set();
 const matches=new Set();for(const star of entry.stars)for(const match of importedTargets(modules,path,{...star,name:requested},next))matches.add(match);
 return matches;
}
function bindingProblems(modules,path){
 const entry=modules.get(path),problems=[];
 for(const reference of entry.references){
  const target=targetPath(path,reference.source);
  if(target&&!modules.has(target))problems.push({path,source:reference.source,line:reference.line,reason:'missing-module'});
 }
 const indirect=[...entry.exports.values()].filter(v=>v.source);
 for(const binding of [...entry.imports.values(),...indirect]){
  if(!targetPath(path,binding.source))continue;
  const count=importedTargets(modules,path,binding,new Set()).size;
  if(count!==1)problems.push({path,source:binding.source,name:binding.name,line:binding.line,reason:count?'ambiguous-export':'missing-export'});
 }
 return problems;
}
export function checkModuleLinks(sources){
 const modules=new Map([...sources].map(([path,source])=>[resolve(path),moduleBindings(source)]));
 return [...modules.keys()].flatMap(path=>bindingProblems(modules,path));
}
function files(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(directory,e.name)):e.isFile()&&/\.(?:mjs|js)$/.test(e.name)?[join(directory,e.name)]:[]);}
export function checkRepositoryLinks(root){
 const sources=roots.flatMap(p=>existsSync(join(root,p))?files(join(root,p)):[]).map(path=>[path,readFileSync(path,'utf8')]);
 return checkModuleLinks(new Map(sources)).map(problem=>({...problem,path:relative(root,problem.path)}));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),problems=checkRepositoryLinks(root);
 if(problems.length){console.error(JSON.stringify(problems,null,2));process.exitCode=1;}
 else console.log('本地静态模块及命名导入/转导出核对通过。未执行模块；外部依赖和动态导入另行验收。');
}
