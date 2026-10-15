import { sha256, payloadHash } from '../contracts/validate.mjs';
import {parseCodexSession,CODEX_SESSION_VERSION} from './codex-session.mjs';

export const PARSER_VERSION = 'synplex.ingestion/1.0.0';
export const TEXT_VERSION = '1';
// Reserved for future verified event imports; this stage does not import message events.
export const EVENT_VERSION = 'synplex.events/1';
export const CHUNK_UNITS = 8192;
export const TEXT_SOURCES = Object.freeze(['obsidian-markdown', 'user-text', 'user-markdown', 'weave-explicit-export', 'synplex-explicit-export', 'isolated-test']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function width(bytes, i) {
  const a = bytes[i];
  if (a < 0x80) return 1;
  const n = a >= 0xc2 && a <= 0xdf ? 2 : a >= 0xe0 && a <= 0xef ? 3 : a >= 0xf0 && a <= 0xf4 ? 4 : 0;
  if (!n || i + n > bytes.length) return 0;
  for (let j = 1; j < n; j++) if (bytes[i+j] < 0x80 || bytes[i+j] > 0xbf) return 0;
  if (a === 0xe0 && bytes[i+1] < 0xa0 || a === 0xed && bytes[i+1] > 0x9f || a === 0xf0 && bytes[i+1] < 0x90 || a === 0xf4 && bytes[i+1] > 0x8f) return 0;
  return n;
}
function utf8Runs(bytes) {
  const runs = [];
  let start = 0, valid = width(bytes, 0) > 0;
  for (let i = 0; i < bytes.length;) {
    const n = width(bytes, i), next = n > 0;
    if (next !== valid) { runs.push({ start, end: i, valid }); start = i; valid = next; }
    i += n || 1;
  }
  if (start < bytes.length) runs.push({ start, end: bytes.length, valid });
  return runs;
}
function splitText(text, markdown) {
  if (!markdown) return [text];
  const units = [];
  let pending = '', fence = null, math = false;
  const flush = () => { if (pending) units.push(pending); pending = ''; };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/);
    const formula = /^\s*\$\$\s*$/.test(line);
    const opening = marker && !fence && !math;
    if (opening) { flush(); fence = { char: marker[1][0], length: marker[1].length }; }
    else if (!fence && formula) { if (!math) flush(); math = !math; }
    else if (!fence && !math && (/^ {0,3}#{1,6} /.test(line) || !line.trim())) flush();
    pending += line;
    if (!opening && fence && marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) { fence = null; flush(); }
    else if (!fence && formula && !math) flush();
  }
  flush();
  return units;
}

export function parseBytes(bytes, format, formatVersion, sourceHash = sha256(bytes), sourceSystem = 'user-text') {
  if(format==='application/x-ndjson'&&sourceSystem==='codex-native-session'&&formatVersion===CODEX_SESSION_VERSION)return parseCodexSession(bytes,sourceHash);
  const blocks = [], gaps = [], roles = new Map(), records = [];
  const supported = TEXT_SOURCES.includes(sourceSystem) && ['text/plain','text/markdown'].includes(format) && formatVersion === TEXT_VERSION;
  const gap = (start, end, reason) => { if (start < end) gaps.push({ rawStartByte: start, rawEndByte: end, reason }); };
  if (!supported) gap(0, bytes.length, format === 'application/x-ndjson' ? 'event_occurrence_mapping_not_available' : 'unsupported_source_format_version');
  else for (const run of utf8Runs(bytes)) {
    if (!run.valid) { gap(run.start, run.end, 'invalid_or_truncated_utf8'); continue; }
    let start = run.start;
    for (const text of splitText(decoder.decode(bytes.subarray(run.start, run.end)), format === 'text/markdown')) {
      const end = start + Buffer.byteLength(text, 'utf8');
      const block = { id: `block:${payloadHash({ sourceHash, parser: PARSER_VERSION, format, formatVersion, start, end, text })}`, text, rawStartByte: start, rawEndByte: end };
      blocks.push(block); roles.set(block.id, null); start = end;
    }
  }
  const totalBytes = bytes.length, coveredBytes = totalBytes - gaps.reduce((sum, g) => sum + g.rawEndByte - g.rawStartByte, 0);
  return { blocks, roles, records, normalizedTextHash: payloadHash(blocks.map(b => b.text)),
    coverage: { status: !supported ? 'unsupported' : gaps.length ? 'partial' : 'complete', coveredBytes, totalBytes, gaps } };
}

export function evidenceChunks(block) {
  const chunks = [];
  for (let start = 0; start < block.text.length;) {
    let end = Math.min(start + CHUNK_UNITS, block.text.length);
    if (end < block.text.length && block.text.charCodeAt(end-1) >= 0xd800 && block.text.charCodeAt(end-1) <= 0xdbff) end--;
    chunks.push({ start, end, text: block.text.slice(start, end) }); start = end;
  }
  return chunks;
}
