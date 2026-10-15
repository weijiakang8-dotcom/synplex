// Pure metadata shared by the browser and the original-file endpoint.
export const DOCUMENT_FORMATS = Object.freeze({
 pdf: 'application/pdf',
 docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
 doc: 'application/msword', rtf: 'application/rtf',
 odt: 'application/vnd.oasis.opendocument.text',
 pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
 xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
 xls: 'application/vnd.ms-excel',
 xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12'
});
export const SOURCE_FORMATS = Object.freeze(['text/plain', 'text/markdown', 'application/x-ndjson', ...Object.values(DOCUMENT_FORMATS)]);
export function documentExtension(format) {
 return Object.keys(DOCUMENT_FORMATS).find(extension => DOCUMENT_FORMATS[extension] === format) ?? null;
}
export function sourceExtension(format) {
 return documentExtension(format) ?? ({'text/plain':'txt', 'text/markdown':'md', 'application/x-ndjson':'jsonl'}[format] ?? 'bin');
}
export function uploadFormat(filename) {
 const extension = String(filename).toLowerCase().split('.').at(-1);
 const format = DOCUMENT_FORMATS[extension];
 if (format) return {format, sourceSystem:'user-document', formatVersion:'1'};
 if (['jsonl','ndjson'].includes(extension)) return {format:'application/x-ndjson', sourceSystem:'codex-native-session', formatVersion:'codex.session-jsonl/1'};
 if (['md','markdown'].includes(extension)) return {format:'text/markdown', sourceSystem:'user-markdown', formatVersion:'1'};
 return {format:'text/plain', sourceSystem:'user-text', formatVersion:'1'};
}
