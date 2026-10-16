// Drafts and pending mutation identities survive logout in their own namespace.
// Switching accounts never deletes an unfinished operation or reads its draft.
export function accountStorage(storage){
 let principal=null;
 const prefix=()=>{if(principal===null)throw Error('请先登录。');return 'synplex-account:'+principal+':';};
 const api={bind(id){if(typeof id!=='string'||!id.length)throw Error('账号尚未确认。');principal=id;},
  getItem:key=>storage.getItem(prefix()+key),setItem:(key,value)=>storage.setItem(prefix()+key,value),removeItem:key=>storage.removeItem(prefix()+key),
  key(index){return Array.from({length:storage.length},(_,i)=>storage.key(i)).filter(k=>k?.startsWith(prefix())).map(k=>k.slice(prefix().length))[index]??null;},
  get length(){return Array.from({length:storage.length},(_,i)=>storage.key(i)).filter(k=>k?.startsWith(prefix())).length;}};
 // Old single-owner drafts remain available only to the private local owner.
 for(let i=0;i<storage.length;i++){const key=storage.key(i);if(key?.startsWith('synplex-')&&!key.startsWith('synplex-account:')){const migrated='synplex-account:local-owner:'+key;if(storage.getItem(migrated)===null)storage.setItem(migrated,storage.getItem(key));}}
 return api;
}
