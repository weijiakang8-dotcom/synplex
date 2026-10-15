// Adapted from Weave vault-sync: read-only notes, original bytes, explicit selection.
// No filesystem paths, executable links, vault writes or inferred facts.
export const OBSIDIAN_SOURCE='obsidian-markdown';
export function noteIdentity(vault,path){
 if(typeof vault!=='string'||!vault.trim()||vault.length>120||/[\\/\x00-\x1f]/.test(vault))throw Error('请给笔记库填写一个简短名称。');
 if(typeof path!=='string'||path.length>1000||!path.toLowerCase().endsWith('.md'))throw Error('请选择 Markdown 笔记。');
 const parts=path.split('/');
 if(parts.some(p=>!p||p==='..'||p==='.'||p.startsWith('.')||p==='node_modules'||/[\\\x00-\x1f]/.test(p)))throw Error('这份笔记的位置无法导入，请选择笔记库内的普通文件。');
 return {vault:vault.trim(),path};
}
export function readNoteIdentity(value){try{const x=JSON.parse(value);return noteIdentity(x.vault,x.path);}catch{return null;}}
export function noteTitle(path,text){
 const front=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
 const title=front?.match(/^title:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g,'');
 return (title||text.match(/^#\s+(.+)$/m)?.[1]||path.split('/').at(-1).replace(/\.md$/i,'')).trim().slice(0,160);
}
function cleanProse(text){return text.replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm,'');}
export function noteLinks(text){
 const prose=cleanProse(text),links=[];
 for(const m of prose.matchAll(/!?\[\[([^\]\n]+)\]\]|\[([^\]\n]+)\]\(([^)\n]+)\)/g)){
  const wiki=m[1]!==undefined,parts=(m[1]||'').split('|'),raw=wiki?parts[0]:m[3];
  let target;try{target=decodeURIComponent(raw.trim().replace(/^<|>$/g,''));}catch{continue;}
  if(/^[a-z][a-z0-9+.-]*:|^[/\\]/i.test(target))continue;
  const hash=target.indexOf('#'),anchor=hash<0?'':target.slice(hash+1);target=hash<0?target:target.slice(0,hash);
  if(!target||!wiki&&!/\.md$/i.test(target))continue;
  links.push({target,anchor,label:(wiki?(parts[1]||parts[0]):m[2]).slice(0,180),wiki});
  if(links.length===60)break;
 }
 return links;
}
function normalized(base,target){
 const parts=base?base.split('/'):[];
 for(const p of target.split('/')){if(p==='..'){if(!parts.length)return null;parts.pop();}else if(p&&p!=='.')parts.push(p);}
 return parts.join('/').replace(/\.md$/i,'');
}
export function resolveNoteLink(origin,link,notes){
 const available=notes.filter(n=>n.vault===origin.vault),target=link.target.replace(/\.md$/i,''),directory=origin.path.split('/').slice(0,-1).join('/');
 const exact=link.wiki?[normalized('',target),normalized(directory,target)]:[normalized(directory,target)];
 let matches=available.filter(n=>exact.includes(n.path.replace(/\.md$/i,'')));
 if(!matches.length&&link.wiki&&!target.includes('/'))matches=available.filter(n=>n.path.split('/').at(-1).replace(/\.md$/i,'')===target);
 return {status:matches.length===1?'found':matches.length?'ambiguous':'missing',matches};
}
