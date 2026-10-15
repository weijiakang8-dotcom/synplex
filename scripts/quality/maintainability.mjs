import {readFileSync,readdirSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const roots=['services','packages','adapters','public','plugins','integrations','scripts/runtime','scripts/quality'];
const isFunction=n=>['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(n.type);
const children=n=>Object.values(n).flatMap(v=>Array.isArray(v)?v.filter(x=>x&&typeof x.type==='string'):v&&typeof v.type==='string'?[v]:[]);
const key=n=>n?.name??n?.value??'anonymous';
function label(node,parent){
 if(node.id?.name)return node.id.name;
 if(parent?.type==='VariableDeclarator')return key(parent.id);
 if(['MethodDefinition','Property','PropertyDefinition'].includes(parent?.type))return key(parent.key);
 if(parent?.type==='AssignmentExpression')return parent.left.property?key(parent.left.property):key(parent.left);
 if(parent?.type==='CallExpression')return (parent.callee.property?key(parent.callee.property):key(parent.callee))+':callback';
 return 'callback';
}
function decisions(node){
 if(['IfStatement','ConditionalExpression','CatchClause','ForStatement','ForInStatement','ForOfStatement','WhileStatement','DoWhileStatement','LogicalExpression','AssignmentPattern'].includes(node.type))return 1;
 if(node.type==='SwitchCase')return node.test?1:0;
 if(node.type==='AssignmentExpression'&&['&&=','||=','??='].includes(node.operator))return 1;
 if(['MemberExpression','CallExpression'].includes(node.type)&&node.optional)return 1;
 return 0;
}
function complexity(node){
 const visit=(n,first=false)=>!first&&isFunction(n)?0:decisions(n)+children(n).reduce((sum,c)=>sum+visit(c),0);
 return 1+visit(node,true);
}
export function analyzeSource(text,path){
 const ast=parse(text,{ecmaVersion:'latest',sourceType:'module',locations:true}),functions=[],imports=[],dynamicImports=[],names=new Map();
 const visit=(node,parent,owner='module')=>{
  let nextOwner=owner;
  if(isFunction(node)){
   const base=owner+'/'+label(node,parent),count=(names.get(base)??0)+1;names.set(base,count);nextOwner=base+(count>1?'#'+count:'');
   functions.push({id:path+'::'+nextOwner,line:node.loc.start.line,lines:node.loc.end.line-node.loc.start.line+1,complexity:complexity(node)});
  }
  if(['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)&&node.source)imports.push(node.source.value);
  if(node.type==='ImportExpression'){if(typeof node.source.value==='string')imports.push(node.source.value);else dynamicImports.push(node.loc.start.line);}
  for(const child of children(node))visit(child,node,nextOwner);
 };
 visit(ast,null);functions.push({id:path+'::module',line:1,lines:ast.loc.end.line,complexity:complexity(ast)});
 return {functions,imports:[...new Set(imports)],dynamicImports};
}
export function dependencyCycles(graph){
 let index=0;const indices=new Map(),low=new Map(),stack=[],active=new Set(),cycles=[];
 const visit=id=>{
  indices.set(id,index);low.set(id,index++);stack.push(id);active.add(id);
  for(const next of graph[id]??[]){
   if(!indices.has(next)){visit(next);low.set(id,Math.min(low.get(id),low.get(next)));}
   else if(active.has(next))low.set(id,Math.min(low.get(id),indices.get(next)));
  }
  if(low.get(id)===indices.get(id)){
   const group=[];let next;do{next=stack.pop();active.delete(next);group.push(next);}while(next!==id);
   if(group.length>1||graph[id]?.includes(id))cycles.push(group.sort());
  }
 };
 for(const id of Object.keys(graph).sort())if(!indices.has(id))visit(id);
 return cycles.sort((a,b)=>a.join(',').localeCompare(b.join(',')));
}
function sourceFiles(dir){return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?sourceFiles(join(dir,e.name)):e.isFile()&&/\.(mjs|js)$/.test(e.name)?[join(dir,e.name)]:[]);}
export function analyzeRepository(sourceRoot=root){
 const files=roots.flatMap(p=>existsSync(join(sourceRoot,p))?sourceFiles(join(sourceRoot,p)):[]).sort(),known=new Set(files),functions=[],graph={},unresolved=[],fileMetrics=[];
 for(const file of files){
  const path=relative(sourceRoot,file),text=readFileSync(file,'utf8'),report=analyzeSource(text,path);functions.push(...report.functions);graph[path]=[];
  for(const specifier of report.imports)if(specifier.startsWith('.')){
   const target=resolve(dirname(file),specifier);if(known.has(target))graph[path].push(relative(sourceRoot,target));else if(/\.(mjs|js)$/.test(target))unresolved.push({path,specifier});
  }
  fileMetrics.push({path,lines:text.split('\n').length,imports:report.imports.length,dynamicImportLines:report.dynamicImports});
 }
 return {method:'synplex.static-decisions/1',parser:'acorn@8.15.0',definition:'1 + branches, loops, non-default cases, catch, conditional/logical/default-parameter/optional-chain decisions; nested functions counted separately. Static imports only; dynamic expressions explicitly listed, not proven acyclic.',files:fileMetrics,functions: functions.sort((a,b)=>b.complexity-a.complexity||a.id.localeCompare(b.id)),cycles:dependencyCycles(graph),unresolved};
}
export function checkBudget(report,budget){
 const problems=[];
 for(const f of report.functions){const max=budget.exceptions[f.id]??budget.defaultMaximum;if(f.complexity>max)problems.push({id:f.id,line:f.line,complexity:f.complexity,maximum:max});}
 const allowed=new Set(budget.cycles.map(c=>c.join('|')));for(const cycle of report.cycles)if(!allowed.has(cycle.join('|')))problems.push({newCycle:cycle});
 if(report.unresolved.length)problems.push({unresolved:report.unresolved});return problems;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode='check',output]=process.argv.slice(2),report=analyzeRepository();
 if(mode==='report'){if(!output)throw Error('Specify an evidence file');mkdirSync(dirname(resolve(output)),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify({files:report.files.length,functions:report.functions.length,cycles:report.cycles.length,top:report.functions.slice(0,12)}));}
 else if(mode==='check'){const budget=JSON.parse(readFileSync(join(root,'scripts/quality/complexity-budget.json'),'utf8'));if(budget.method!==report.method)throw Error('Metric definition changed; review the budget before continuing');const problems=checkBudget(report,budget);if(problems.length){console.error(JSON.stringify(problems,null,2));process.exitCode=1;}else console.log('结构门禁通过：静态引用图没有新增循环，函数复杂度未突破登记上限。动态引用与历史高复杂度债务仍需单独核对。');}
 else throw Error('Use report or check');
}
