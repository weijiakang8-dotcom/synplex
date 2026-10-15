import { importSource } from '../../packages/ingestion/index.mjs';
import { ProtocolError } from '../../packages/contracts/validate.mjs';

// Accept only the explicitly supplied export. No file discovery, host DB or session access.
export async function importWeaveMaterial(repo, input, meta) {
  if (!input || typeof input !== 'object' || input.sourceSystem !== 'weave-explicit-export' || input.importOrigin !== 'user_upload') {
    throw new ProtocolError('validation_failed', '请选择明确获准的Weave导出资料。', '传入完整字节和导出版本，来源为weave-explicit-export、方式为user_upload。');
  }
  return importSource(repo, input, meta);
}
