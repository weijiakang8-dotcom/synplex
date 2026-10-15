import { ProtocolError, validateWire } from '../contracts/validate.mjs';

/** @type {import('../contracts/repository.d.ts').ExperienceModule['propose']} */
export async function propose(repo, candidate, meta) {
  validateWire('CandidateInput', candidate);
  if (!meta || typeof meta !== 'object' || Array.isArray(meta) || Object.keys(meta).some(key => !['requestId', 'expectedStateRevision'].includes(key)) ||
      typeof meta.requestId !== 'string' || !meta.requestId.length || meta.requestId.length > 128 ||
      !Number.isSafeInteger(meta.expectedStateRevision) || meta.expectedStateRevision < 0 ||
      candidate.type !== 'lesson' || typeof candidate.condition !== 'string' || !candidate.condition.trim() ||
      !candidate.evidence.length || candidate.evidence.some(span => !span.quote.trim())) {
    throw new ProtocolError('validation_failed', '经验候选的适用条件、原文依据或请求信息不完整。',
      '补充一条经验、适用条件和准确的原文引用，并核对请求标识与版本。');
  }
  // Snapshot before yielding; repository owns atomic evidence/authority checks and
  // exact request replay before stale revision. Never normalize the payload or id.
  const savedCandidate = structuredClone(candidate);
  const savedMeta = { requestId: meta.requestId, expectedStateRevision: meta.expectedStateRevision };
  return repo.appendCandidates([savedCandidate], savedMeta);
}
