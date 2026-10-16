// Rebuildable projections only. Original records remain the source of truth.
import {primaryTopic,sourceRelevance} from '../../packages/ingestion/source-relevance.mjs';
export class SearchIndex {
 constructor(db) {
  this.db=db;
  db.exec(`
   CREATE TABLE IF NOT EXISTS search_documents (
    id INTEGER PRIMARY KEY, partition TEXT NOT NULL,
    source_id TEXT NOT NULL, parsed_id TEXT NOT NULL, block_id TEXT NOT NULL,
    body_text TEXT NOT NULL, normalized_text TEXT NOT NULL,
    UNIQUE(partition,parsed_id,block_id));
   CREATE TABLE IF NOT EXISTS search_occurrences (
    partition TEXT NOT NULL,occurrence_id TEXT NOT NULL,document_id INTEGER NOT NULL,
    occurrence_order INTEGER NOT NULL,block_order INTEGER NOT NULL,
    PRIMARY KEY(partition,occurrence_id,document_id));
   CREATE INDEX IF NOT EXISTS search_occurrences_order ON search_occurrences(partition,occurrence_order,block_order);
   CREATE INDEX IF NOT EXISTS search_occurrences_document ON search_occurrences(document_id,partition);
   CREATE VIRTUAL TABLE IF NOT EXISTS search_text USING fts5(normalized_text,content='search_documents',content_rowid='id',tokenize='trigram');
   CREATE TRIGGER IF NOT EXISTS search_documents_insert AFTER INSERT ON search_documents BEGIN
    INSERT INTO search_text(rowid,normalized_text) VALUES(new.id,new.normalized_text); END;
   CREATE TRIGGER IF NOT EXISTS search_documents_delete AFTER DELETE ON search_documents BEGIN
    INSERT INTO search_text(search_text,rowid,normalized_text) VALUES('delete',old.id,old.normalized_text); END;
   CREATE TABLE IF NOT EXISTS search_references (
    partition TEXT NOT NULL,claim_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,block_id TEXT NOT NULL,
    PRIMARY KEY(partition,claim_id,occurrence_id,block_id));
   CREATE INDEX IF NOT EXISTS search_references_block ON search_references(partition,occurrence_id,block_id);
   CREATE TABLE IF NOT EXISTS search_replacements (
    partition TEXT NOT NULL,prior_claim_id TEXT NOT NULL,claim_id TEXT NOT NULL,
    PRIMARY KEY(partition,prior_claim_id,claim_id));
   CREATE INDEX IF NOT EXISTS search_replacements_successor ON search_replacements(partition,claim_id,prior_claim_id);
   CREATE INDEX IF NOT EXISTS records_claim_status ON records(partition,kind,json_extract(body_json,'$.lifecycle'),json_extract(body_json,'$.reviewStatus')) WHERE kind='claim';
   CREATE INDEX IF NOT EXISTS records_metadata_source ON records(partition,kind,json_extract(body_json,'$.sourceId')) WHERE kind='source_metadata_revision';
   CREATE INDEX IF NOT EXISTS records_parsed_source ON records(partition,kind,json_extract(body_json,'$.sourceId')) WHERE kind='parsed';
   CREATE INDEX IF NOT EXISTS records_occurrence_source ON records(partition,kind,json_extract(body_json,'$.sourceId')) WHERE kind='occurrence';
   CREATE INDEX IF NOT EXISTS records_claim_revision_target ON records(partition,kind,json_extract(body_json,'$.claimId')) WHERE kind='claim_revision';
   CREATE INDEX IF NOT EXISTS records_review_target ON records(partition,kind,json_extract(body_json,'$.claimId'),json_extract(body_json,'$.after.reviewStatus')) WHERE kind='review';
   CREATE TABLE IF NOT EXISTS search_index_state (id INTEGER PRIMARY KEY CHECK(id=1),signature TEXT NOT NULL);
  `);
  this.ensureCurrent();
 }
 signature() {
  const row=this.db.prepare('SELECT COALESCE((SELECT max(rowid) FROM records),0) AS latest,COALESCE((SELECT sum(state_revision) FROM scopes),0) AS revision').get();
  return `2:${row.latest}:${row.revision}`;
 }
 checkpoint() {
  this.db.prepare('INSERT INTO search_index_state(id,signature) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET signature=excluded.signature').run(this.signature());
 }
 ensureCurrent(force=false) {
  const old=this.db.prepare('SELECT signature FROM search_index_state WHERE id=1').get();
  if(!force&&old?.signature===this.signature())return;
  const nested=this.db.isTransaction;
  if(!nested)this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.exec('DELETE FROM search_occurrences; DELETE FROM search_documents; DELETE FROM search_references; DELETE FROM search_replacements;');
   // Iterate one original event at a time; do not materialize the whole vault.
   for(const row of this.db.prepare("SELECT partition,body_json FROM records WHERE kind='occurrence' ORDER BY rowid").iterate())this.occurrence(row.partition,JSON.parse(row.body_json));
   for(const row of this.db.prepare("SELECT partition,body_json FROM records WHERE kind='claim' ORDER BY rowid").iterate())this.claim(row.partition,JSON.parse(row.body_json));
   this.checkpoint();
   if(!nested)this.db.exec('COMMIT');
  }catch(error){if(!nested)this.db.exec('ROLLBACK');throw error;}
 }
 read(partition,kind,id) {
  const row=this.db.prepare('SELECT rowid,body_json FROM records WHERE partition=? AND kind=? AND id=?').get(partition,kind,id);
  return row?{order:row.rowid,value:JSON.parse(row.body_json)}:null;
 }
 occurrence(partition,value) {
  this.db.prepare('DELETE FROM search_occurrences WHERE partition=? AND occurrence_id=?').run(partition,value.id);
  const parsed=this.read(partition,'parsed',value.parsedRevisionId),source=this.read(partition,'source',value.sourceId),occurrence=this.read(partition,'occurrence',value.id);
  if(!parsed||!source||!occurrence)return;
  const allowed=source.value.format==='application/x-ndjson'?this.read(partition,'occurrence_blocks',value.id)?.value.blockIds:null;
  const insert=this.db.prepare('INSERT OR IGNORE INTO search_documents(partition,source_id,parsed_id,block_id,body_text,normalized_text) VALUES(?,?,?,?,?,?)');
  const link=this.db.prepare('INSERT INTO search_occurrences VALUES(?,?,?,?,?)');
  parsed.value.blocks.forEach((block,index)=>{
   if(source.value.format==='application/x-ndjson'&&!allowed?.includes(block.id))return;
   insert.run(partition,value.sourceId,value.parsedRevisionId,block.id,block.text,block.text.toLocaleLowerCase());
   const document=this.db.prepare('SELECT id FROM search_documents WHERE partition=? AND parsed_id=? AND block_id=?').get(partition,value.parsedRevisionId,block.id);
   link.run(partition,value.id,document.id,occurrence.order,index);
  });
 }
 claim(partition,value) {
  this.db.prepare('DELETE FROM search_references WHERE partition=? AND claim_id=?').run(partition,value.id);
  this.db.prepare('DELETE FROM search_replacements WHERE partition=? AND claim_id=?').run(partition,value.id);
  const replacement=this.db.prepare('INSERT OR IGNORE INTO search_replacements VALUES(?,?,?)');
  for(const id of value.supersedes??[])replacement.run(partition,id,value.id);
  const insert=this.db.prepare('INSERT OR IGNORE INTO search_references VALUES(?,?,?,?)');
  for(const span of value.evidence??[])insert.run(partition,value.id,span.occurrenceId,span.blockId);
 }
 relatedClaims(partition,ids,withBodies=true){
  if(!ids.length)return [];
  return this.db.prepare(`WITH RECURSIVE related(id) AS (
   SELECT value FROM json_each(?)
   UNION SELECT e.claim_id FROM search_replacements e JOIN related r ON r.id=e.prior_claim_id WHERE e.partition=?
   UNION SELECT e.prior_claim_id FROM search_replacements e JOIN related r ON r.id=e.claim_id WHERE e.partition=?
  ) SELECT c.rowid,c.id,c.payload_hash${withBodies?',c.body_json':''} FROM records c JOIN related r ON r.id=c.id
   WHERE c.partition=? AND c.kind='claim' ORDER BY c.rowid`).all(JSON.stringify(ids),partition,partition,partition);
 }
 sourceClaims(partition,sourceId){
  const roots=this.db.prepare(`SELECT DISTINCT r.claim_id FROM search_references r
   JOIN search_occurrences o ON o.partition=r.partition AND o.occurrence_id=r.occurrence_id
   JOIN search_documents d ON d.partition=r.partition AND d.id=o.document_id AND d.block_id=r.block_id
   WHERE r.partition=? AND d.source_id=?`).all(partition,sourceId).map(r=>r.claim_id);
  return this.relatedClaims(partition,roots,false);
 }
 record(partition,kind,value) {
  if(kind==='occurrence')this.occurrence(partition,value);
  else if(kind==='occurrence_blocks'){
   const event=this.read(partition,'occurrence',value.id);if(event)this.occurrence(partition,event.value);
  }else if(kind==='claim')this.claim(partition,value);
 }
 ranked(partition,{terms,occurrenceIds,limit}) {
  this.ensureCurrent();
  const selected=occurrenceIds.length?JSON.stringify(occurrenceIds):null;
  const sources=this.db.prepare(`SELECT o.id,o.body_json,coalesce(json_extract(m.body_json,'$.title'),json_extract(f.body_json,'$.name'),'') title,
   (SELECT substr(d.body_text,1,4096) FROM search_occurrences l JOIN search_documents d ON d.id=l.document_id AND d.partition=l.partition WHERE l.partition=o.partition AND l.occurrence_id=o.id ORDER BY l.block_order LIMIT 1) preamble
   FROM records o LEFT JOIN records m ON m.partition=o.partition AND m.kind='source_metadata' AND m.id=json_extract(o.body_json,'$.sourceId')
   LEFT JOIN records f ON f.partition=o.partition AND f.kind='source_filename' AND f.id=json_extract(o.body_json,'$.sourceId')
   WHERE o.partition=? AND o.kind='occurrence'`).all(partition);
  const occurrences=new Map(sources.map(r=>[r.id,JSON.parse(r.body_json)])),topic=primaryTopic(occurrences);
  const policies=JSON.stringify(Object.fromEntries(sources.map(r=>[r.id,sourceRelevance(occurrences.get(r.id),r.title,topic,r.preamble??'')])));
  // A bounded term list; scan only this project's indexed text, never all tenants.
  // Include titles/paths, so a focused project note beats an incidental phrase.
  const weights=terms.map(()=>"(CASE WHEN instr(d.normalized_text,?)>0 THEN 1 ELSE 0 END + CASE WHEN instr(lower(coalesce(json_extract(m.body_json,'$.title'),f.name,'')),?)>0 THEN 4 ELSE 0 END)").join('+');
  if(!weights)return [];
  const rows=this.db.prepare(`WITH policies AS MATERIALIZED (SELECT key,value FROM json_each(?)), candidates AS (
   SELECT d.*,o.body_json occurrence_json,
    coalesce(json_extract(m.body_json,'$.title'),f.name,'项目资料') title,
    json_extract(policy.value,'$.path') path,json_extract(policy.value,'$.role') evidence_role,json_extract(policy.value,'$.priority') priority,
    (${weights}+json_extract(policy.value,'$.priority')) score
   FROM search_documents d
   JOIN search_occurrences l ON l.document_id=d.id AND l.partition=d.partition
   JOIN records o ON o.partition=d.partition AND o.kind='occurrence' AND o.id=l.occurrence_id
   JOIN policies policy ON policy.key=l.occurrence_id
   LEFT JOIN records m ON m.partition=d.partition AND m.kind='source_metadata' AND m.id=d.source_id
   LEFT JOIN (SELECT partition,id,json_extract(body_json,'$.name') name FROM records WHERE kind='source_filename') f ON f.partition=d.partition AND f.id=d.source_id
   WHERE d.partition=? AND (? IS NULL OR l.occurrence_id IN (SELECT value FROM json_each(?)))
   AND (? IS NOT NULL OR json_extract(policy.value,'$.eligible')=1)
  ), grouped AS (
   SELECT *,row_number() OVER(PARTITION BY source_id ORDER BY score DESC,id DESC) position FROM candidates WHERE score>priority
  ) SELECT * FROM grouped WHERE position<=6 ORDER BY score DESC,id DESC LIMIT ?`).all(policies,...terms.flatMap(t=>[t,t]),partition,selected,selected,selected,limit);
  return rows;
 }
 find(partition,query,offset) {
  this.ensureCurrent();
  const lower=query.query.toLocaleLowerCase(),long=Array.from(lower).length>=3;
  // Materialize matching ids once. Joining MATCH per occurrence repeats the
  // FTS lookup for every duplicate event when SQLite chooses the order index.
  const match=long?'d.id IN (SELECT rowid FROM search_text WHERE search_text MATCH ?) AND ':'';
  const statement=this.db.prepare(`
   SELECT d.*,links.occurrence_id,related.claim_json,o.body_json AS occurrence_json
   FROM search_documents d
   JOIN search_occurrences links ON links.document_id=d.id AND links.partition=d.partition
   JOIN records o ON o.partition=d.partition AND o.kind='occurrence' AND o.id=links.occurrence_id
   LEFT JOIN (
    SELECT e.partition,e.occurrence_id,e.block_id,c.body_json AS claim_json,c.rowid AS claim_order
    FROM search_references e JOIN records c ON c.partition=e.partition AND c.kind='claim' AND c.id=e.claim_id
    WHERE (?=1 OR (json_extract(c.body_json,'$.lifecycle')='active' AND json_extract(c.body_json,'$.reviewStatus')!='rejected'))
   ) related ON related.partition=d.partition AND related.occurrence_id=links.occurrence_id AND related.block_id=d.block_id
   WHERE ${match}d.partition=? AND instr(d.normalized_text,?)>0
    AND (? IS NULL OR links.occurrence_id IN (SELECT value FROM json_each(?)))
   ORDER BY links.occurrence_order,links.block_order,related.claim_order
   LIMIT ? OFFSET ?`);
  const ids=query.occurrenceIds===null?null:JSON.stringify(query.occurrenceIds);
  const params=[query.includeHistory?1:0,...(long?['"'+lower.replaceAll('"','""')+'"']:[]),partition,lower,ids,ids,query.limit+1,offset];
  return statement.all(...params);
 }
}
