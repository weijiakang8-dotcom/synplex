import {selectEvent,SELECTION_VERSION} from '../../packages/ingestion/event-selection.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {sourceIdentity,primaryTopic} from '../../packages/ingestion/source-relevance.mjs';
const eligible=`WITH batch_claims AS MATERIALIZED (
 SELECT b.partition,json_extract(i.value,'$.id') claim_id FROM records b,json_each(b.body_json,'$.claims') i
 WHERE b.partition=? AND b.kind='source_curation' AND json_extract(b.body_json,'$.status')='completed'
), suppressed AS MATERIALIZED (
 SELECT DISTINCT s.group_key FROM batch_claims b
 JOIN candidate_selection s ON s.partition=b.partition AND s.claim_id=b.claim_id
), eligible AS (SELECT c.rowid ordering,c.body_json,s.reason,
 CASE WHEN COALESCE(json_extract(c.body_json,'$.condition'),'') LIKE '仅为原文规则候选%' THEN 1 ELSE 0 END raw,
 row_number() OVER (PARTITION BY s.group_key ORDER BY c.rowid) duplicate
 FROM candidate_selection s JOIN records c ON c.partition=s.partition AND c.kind='claim' AND c.id=s.claim_id
 WHERE s.partition=? AND s.selected=1 AND s.group_key NOT IN (SELECT group_key FROM suppressed)
 AND json_extract(c.body_json,'$.lifecycle')='active' AND json_extract(c.body_json,'$.reviewStatus')='pending') `;
// Rebuildable selection, separate from authoritative claims and human reviews.
export class CandidateSelection{
 constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS candidate_selection (
  partition TEXT NOT NULL,claim_id TEXT NOT NULL,signature TEXT NOT NULL,
  selected INTEGER NOT NULL,group_key TEXT NOT NULL,reason TEXT NOT NULL,
  PRIMARY KEY(partition,claim_id));
  CREATE INDEX IF NOT EXISTS candidate_selection_group ON candidate_selection(partition,selected,group_key);`);}
 ensure(partition){
  const occurrences=new Map(this.db.prepare("SELECT id,body_json FROM records WHERE partition=? AND kind='occurrence'").all(partition).map(r=>[r.id,JSON.parse(r.body_json)]));
  const topic=primaryTopic(occurrences),version=SELECTION_VERSION+':'+(topic||'unresolved')+':';
  const rows=this.db.prepare(`SELECT c.id,c.body_json,c.payload_hash, m.payload_hash metadata_hash, m.body_json metadata FROM records c
   LEFT JOIN records m ON m.partition=c.partition AND m.kind='source_metadata' AND m.id=json_extract(c.body_json,'$.evidence[0].sourceId')
   LEFT JOIN candidate_selection s ON s.partition=c.partition AND s.claim_id=c.id
   WHERE c.partition=? AND c.kind='claim' AND (s.signature IS NULL OR s.signature!=?||c.payload_hash||':'||COALESCE(m.payload_hash,'')) ORDER BY c.rowid`).iterate(partition,version);
  const write=this.db.prepare('INSERT INTO candidate_selection VALUES(?,?,?,?,?,?) ON CONFLICT(partition,claim_id) DO UPDATE SET signature=excluded.signature,selected=excluded.selected,group_key=excluded.group_key,reason=excluded.reason');
  for(const row of rows){
   const claim=JSON.parse(row.body_json),span=claim.evidence[0];
   const occurrence=occurrences.get(span?.occurrenceId);
   const sourcePath=sourceIdentity(occurrence||{}).path||'';
   const locked=row.metadata&&JSON.parse(row.metadata).locked;
   const choice=locked?{selected:true,group:row.id,reason:'保留已锁定资料的记录'}:selectEvent({claim,sourcePath,primaryTopic:topic});
   write.run(partition,row.id,version+row.payload_hash+':'+(row.metadata_hash||''),Number(choice.selected),payloadHash(choice.group||row.id),choice.reason);
  }
 }
 page(partition,offset){
  this.ensure(partition);
  const rows=this.db.prepare(eligible+'SELECT body_json,reason FROM eligible WHERE duplicate=1 ORDER BY raw,ordering DESC LIMIT 101 OFFSET ?').all(partition,partition,offset);
  const counts=this.db.prepare(eligible+'SELECT count(*) n,COALESCE(sum(CASE WHEN raw=0 THEN 1 ELSE 0 END),0) curated FROM eligible WHERE duplicate=1').get(partition,partition),total=counts.n;
  const raw=this.db.prepare("SELECT count(*) n FROM records WHERE partition=? AND kind='claim' AND json_extract(body_json,'$.lifecycle')='active' AND json_extract(body_json,'$.reviewStatus')='pending'").get(partition).n;
  return {items:rows.slice(0,100).map(r=>JSON.parse(r.body_json)),total,more:rows.length>100,selection:{version:SELECTION_VERSION,unreviewedFragments:raw,selectedEvents:total,curatedEvents:counts.curated,rawSignals:total-counts.curated,retainedInSources:raw-total,explanations:Object.fromEntries(rows.slice(0,100).map(r=>[JSON.parse(r.body_json).id,r.reason]))}};
 }
 all(partition){this.ensure(partition);return this.db.prepare(eligible+'SELECT body_json FROM eligible WHERE duplicate=1 ORDER BY ordering').all(partition,partition).map(r=>JSON.parse(r.body_json));}
}
