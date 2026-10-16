import {ProtocolError,sha256} from './validate.mjs';

// Inline return is deliberately bounded by the existing 2 MB tool transport.
// A host report plus matching bytes proves file identity, never task acceptance.
export function decodeResultFiles(request){
 const files=request.artifactFiles??[],seen=new Set();let total=0;
 return files.map(file=>{
  const artifact=request.result.artifacts.find(a=>a.id===file.artifactId);
  if(!artifact||seen.has(file.artifactId)||!file.base64||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64))
   throw new ProtocolError('validation_failed','成果文件内容或对应关系不正确。','从原成果重新读取文件，不修改旧回执。');
  const bytes=Buffer.from(file.base64,'base64');seen.add(file.artifactId);total+=bytes.length;
  if(total>1024*1024||bytes.length!==artifact.byteLength||sha256(bytes)!==artifact.sha256)
   throw new ProtocolError('conflict','成果文件大小或指纹与回执不一致。','每次接回的文件合计不超过1兆，并核对原文件。');
  return {artifact,bytes};
 });
}
