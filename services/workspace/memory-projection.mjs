import {payloadHash,sha256} from '../../packages/contracts/validate.mjs';

const METHOD='synplex.extractive-brief/1';
const clip=(text,size)=>{let end=Math.min(text.length,size);if(end<text.length&&end>0&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;return {text:text.slice(0,end),complete:end===text.length};};
// These are navigation projections, never a substitute for originals or a
// model-written fact. Cache writes do not advance the user's project revision.
export class MemoryProjection {
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS source_briefs (
  partition TEXT NOT NULL,source_id TEXT NOT NULL,signature TEXT NOT NULL,
  content_hash TEXT NOT NULL,body_json TEXT NOT NULL,PRIMARY KEY(partition,source_id));`);}
 source({partition,permissionRevision,source,metadata,claimRows}){
  const parsed=this.db.prepare(`SELECT id,payload_hash,json_extract(body_json,'$.coverage') coverage,
   json_array_length(body_json,'$.blocks') block_count FROM records
   WHERE partition=? AND kind='parsed' AND json_extract(body_json,'$.sourceId')=? ORDER BY rowid DESC LIMIT 1`).get(partition,source.id);
  const event=this.db.prepare("SELECT id FROM records WHERE partition=? AND kind='occurrence' AND json_extract(body_json,'$.sourceId')=? ORDER BY rowid DESC LIMIT 1").get(partition,source.id);
  const signature=payloadHash({method:METHOD,permissionRevision,sourceHash:source.sha256,metadata,parsedHash:parsed?.payload_hash??null,eventId:event?.id??null,claimHashes:claimRows.map(r=>[r.id,r.payload_hash])});
  const cached=this.db.prepare('SELECT * FROM source_briefs WHERE partition=? AND source_id=?').get(partition,source.id);
  if(cached?.signature===signature){try{const body=JSON.parse(cached.body_json);if(payloadHash(body)===cached.content_hash)return {...body,cacheStatus:'hit'};}catch{/* rebuild only the derived cache */}}
  const excerpts=parsed?this.db.prepare(`SELECT d.block_id,substr(d.body_text,1,241) body_text,length(d.body_text) character_count,
    (SELECT occurrence_id FROM search_occurrences o WHERE o.partition=d.partition AND o.document_id=d.id ORDER BY occurrence_order DESC LIMIT 1) occurrence_id
    FROM search_documents d WHERE d.partition=? AND d.parsed_id=? ORDER BY d.id LIMIT 5`).all(partition,parsed.id).map(r=>{
      const excerpt=clip(r.body_text,240);return {text:excerpt.text,complete:r.character_count===Array.from(excerpt.text).length,evidence:{sourceId:source.id,parsedRevisionId:parsed.id,occurrenceId:r.occurrence_id,blockId:r.block_id,start:0,end:excerpt.text.length,offsetUnit:'utf16_code_unit',quote:excerpt.text,quoteHash:sha256(Buffer.from(excerpt.text))}};
    }):[];
  const claims=this.db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='claim' AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid").all(partition,JSON.stringify(claimRows.map(r=>r.id))).map(r=>JSON.parse(r.body_json)),confirmed=claims.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='confirmed'),pending=claims.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='pending'),historical=claims.filter(c=>c.lifecycle!=='active'||c.reviewStatus==='rejected');
  const list=items=>items.slice().reverse().slice(0,8).map(c=>({id:c.id,title:c.title,type:c.type,...clip(c.body,320),condition:c.condition,reviewStatus:c.reviewStatus,lifecycle:c.lifecycle,contentHash:payloadHash(c)}));
  const body={sourceId:source.id,method:METHOD,metadata,coverage:parsed?JSON.parse(parsed.coverage):null,blockCount:parsed?.block_count??0,excerpts,
   confirmed:list(confirmed),pending:list(pending),historical:list(historical),counts:{confirmed:confirmed.length,pending:pending.length,historical:historical.length},
   complete:confirmed.length<=8&&pending.length<=8&&historical.length<=8&&(parsed?.block_count??0)<=5&&excerpts.every(e=>e.complete),
   signature};
  this.db.prepare('INSERT INTO source_briefs VALUES(?,?,?,?,?) ON CONFLICT(partition,source_id) DO UPDATE SET signature=excluded.signature,content_hash=excluded.content_hash,body_json=excluded.body_json').run(partition,source.id,signature,payloadHash(body),JSON.stringify(body));
  return {...body,cacheStatus:'rebuilt'};
 }
}
