// Bounded display projection. Original blocks and evidence offsets never change.
import {createHash} from 'node:crypto';
import {ProtocolError} from '../../packages/contracts/validate.mjs';
export const SOURCE_PREVIEW_BYTES=24*1024;
const MAX_BLOCKS=40;
export function verifyPreviewSource(db,ownerId,source){
 const invalid=()=>{throw new ProtocolError('conflict','原件与保存的指纹不一致。','保留记录并核对备份，不能用预览重建原件。','never');};
 const size=db.prepare('SELECT length(bytes) AS size FROM raw_blobs WHERE owner_id=? AND sha256=?').get(ownerId,source.sha256);
 if(size?.size!==source.byteLength)invalid();
 const read=db.prepare('SELECT substr(bytes,?,65536) AS bytes FROM raw_blobs WHERE owner_id=? AND sha256=?'),hash=createHash('sha256');
 for(let offset=0;offset<size.size;offset+=65536){
  const row=read.get(offset+1,ownerId,source.sha256);if(!row?.bytes?.length)invalid();hash.update(row.bytes);
 }
 if(hash.digest('hex')!==source.sha256)invalid();
}
function completeUtf8(bytes,maximum){
 let end=Math.min(bytes.length,maximum);
 if(end<bytes.length)while(end>0&&(bytes[end]&0xc0)===0x80)end--;
 return bytes.subarray(0,end);
}
export function sourcePreviewHeader(db,partition,sourceId){
 const row=db.prepare(`SELECT id,json_remove(body_json,'$.blocks') AS header,
  json_array_length(body_json,'$.blocks') AS block_count FROM records
  WHERE partition=? AND kind='parsed' AND json_extract(body_json,'$.sourceId')=? ORDER BY rowid DESC LIMIT 1`).get(partition,sourceId);
 if(!row)return {parsed:null,blockCount:0,occurrenceId:null};
 const occurrence=db.prepare("SELECT id FROM records WHERE partition=? AND kind='occurrence' AND json_extract(body_json,'$.sourceId')=? AND json_extract(body_json,'$.parsedRevisionId')=? ORDER BY rowid DESC LIMIT 1").get(partition,sourceId,row.id);
 return {parsed:{...JSON.parse(row.header),blocks:[]},blockCount:row.block_count,occurrenceId:occurrence?.id??null};
}
export function sourcePreviewPage(db,partition,parsedId,offset){
 // SQL slices UTF-8 bytes, including NULs; do not transfer the entire source,
 // a giant block or all parsed JSON into the Node heap to take the first page.
 const rows=db.prepare(`WITH blocks AS (
  SELECT CAST(key AS INTEGER) AS block_order,value,
   length(CAST(json_extract(value,'$.text') AS BLOB)) AS bytes
  FROM json_each((SELECT body_json FROM records WHERE partition=? AND kind='parsed' AND id=?),'$.blocks')
 ), positioned AS (
  SELECT *,coalesce(sum(bytes) OVER(ORDER BY block_order ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS start_offset FROM blocks
 ) SELECT json_remove(value,'$.text') AS metadata,bytes,start_offset,
  substr(CAST(json_extract(value,'$.text') AS BLOB),max(1,? - start_offset + 1),
   min(bytes,max(0,? - start_offset))-max(0,? - start_offset)) AS fragment
 FROM positioned WHERE bytes>0 AND start_offset+bytes>? AND start_offset<?
 ORDER BY block_order LIMIT ?`).all(partition,parsedId,offset,offset+SOURCE_PREVIEW_BYTES+4,offset,offset,offset+SOURCE_PREVIEW_BYTES+4,MAX_BLOCKS+1);
 let used=0,nextOffset=offset;const blocks=[];
 for(const row of rows.slice(0,MAX_BLOCKS)){
  const bytes=completeUtf8(Buffer.from(row.fragment),SOURCE_PREVIEW_BYTES-used);if(!bytes.length)break;
  const start=Math.max(offset,row.start_offset),end=start+bytes.length;
  blocks.push({...JSON.parse(row.metadata),text:bytes.toString('utf8'),previewRange:{startByte:start-row.start_offset,endByte:end-row.start_offset,totalBytes:row.bytes}});
  used+=bytes.length;nextOffset=end;
  if(bytes.length<row.fragment.length)break;
 }
 const last=rows.at(-1),more=!!last&&(rows.length>MAX_BLOCKS||nextOffset<last.start_offset+last.bytes);
 return {blocks,nextOffset,more,displayBytes:used};
}
