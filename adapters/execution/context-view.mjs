import {payloadHash} from '../../packages/contracts/validate.mjs';

// Model-facing view of the complete frozen packet. Preserve every field and
// quotation; attach its reviewed use next to the text, not in a distant notice.
// The original contentHash identifies the stored packet, not this derived view.
export function executionContextView(packet){
 const current=new Set([...packet.facts,...packet.failures,...packet.lessons].flatMap(c=>c.evidence).map(payloadHash));
 const pending=new Set(packet.candidates.flatMap(c=>c.evidence).map(payloadHash));
 const materialUse=span=>current.has(payloadHash(span))?'已确认记录的引用；仅支持对应记录所确认的内容':pending.has(payloadHash(span))?'待核对线索；不能写成已确认事实':'仅供回看的原文；未获当前确认，不能写成当前结论';
 return {...structuredClone(packet),evidence:packet.evidence.map(span=>({materialUse:materialUse(span),...span})),
  evidencePolicy:'本视图保留完整工作说明并给原文标注状态。记录确认范围由facts/failures/lessons决定；确认一句话不代表整份材料都已确认。candidates和仅供回看的原文不得升级为已确认事实。可以作为建议时必须标明建议。contentHash是原始保存说明的指纹，不是本视图的指纹。'};
}
