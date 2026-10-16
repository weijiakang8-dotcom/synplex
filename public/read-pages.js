// A stale read cursor is safe to discard. Never retry writes or model calls here.
export async function readPage(request,path,cursor){
 try{return {...await request(path,{cursor}),reset:false};}
 catch(error){
  if(error.status!==409||error.code!=='stale_context')throw error;
  return {...await request(path,{cursor:null}),reset:true};
 }
}
