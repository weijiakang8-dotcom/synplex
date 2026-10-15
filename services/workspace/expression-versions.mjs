import {ProtocolError,PROTOCOL_VERSION,sha256} from '../../packages/contracts/validate.mjs';
import {renderExpressionHtml} from './project-expression.mjs';

const fail=message=>{throw new ProtocolError('validation_failed',message,'重新预览完整内容后，再确认保存。');};
export function validateExpressionVersion(request,{stop=false}={}){
 const keys=['protocolVersion','scope','requestId','expectedStateRevision',...(stop?['versionId']:['title','claimIds','includeEvidence','expectedSelectionHash','approved'])];
 if(!request||Object.keys(request).sort().join(',')!==keys.sort().join(',')||request.protocolVersion!==PROTOCOL_VERSION)fail('提交内容不完整，尚未保存。');
 if(stop){if(typeof request.versionId!=='string'||!/^[-a-zA-Z0-9]{1,160}$/.test(request.versionId))fail('请选择要停止查看的版本。');}
 else if(request.approved!==true||typeof request.expectedSelectionHash!=='string'||!/^[a-f0-9]{64}$/.test(request.expectedSelectionHash))fail('请先核对预览，确认只展示选中的内容。');
}
export const expressionSummary=(version,status)=>({id:version.id,title:version.selection.title,count:version.selection.claimIds.length,
 includeEvidence:version.selection.includeEvidence,createdAt:version.createdAt,sha256:version.sha256,status});
export function requireExpressionBytes(version){
 if(typeof version.html!=='string'||Buffer.byteLength(version.html)>2*1024*1024||sha256(Buffer.from(version.html))!==version.sha256||renderExpressionHtml(version.content,{linked:true})!==version.html)
  throw new ProtocolError('conflict','这版介绍的内容暂时无法核对。','保留记录，检查备份后再生成查看链接。');
}
