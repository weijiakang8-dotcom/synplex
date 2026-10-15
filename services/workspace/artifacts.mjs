import { ProtocolError,sha256 } from '../../packages/contracts/validate.mjs';
const fail=()=>{throw new ProtocolError('conflict','文件内容与成果回执不一致，尚未保存为已核对成果。','选择回执对应的原文件，核对内容后再提交。');};
export function verifyArtifact(repository,auth,scope,{resultId,artifactId,bytes}) {
  if(auth.kind!=='ui'||!(bytes instanceof Uint8Array)||bytes.byteLength>64*1024*1024)
    throw new ProtocolError('scope_denied','文件核对需要本人选择原文件。','从成果页选择文件，不能由资料授予权限。');
  const result=repository.read(auth,scope,'result',resultId),artifact=result?.artifacts.find(a=>a.id===artifactId);
  if(!artifact)fail();
  if(sha256(bytes)!==artifact.sha256||bytes.byteLength!==artifact.byteLength)fail();
  return repository.saveArtifactFile(auth,scope,resultId,artifact,bytes);
}
