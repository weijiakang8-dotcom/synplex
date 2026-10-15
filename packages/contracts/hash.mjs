import {createHash} from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
// Called only after schema validation on JSON values; array order remains significant.
export const payloadHash = value => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));
