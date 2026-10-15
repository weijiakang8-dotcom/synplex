// Read-only aggregate over execution jobs, not pending memory-change outbox rows.
// Counts include all jobs in one already-authorized partition, not only the 100 UI cards.
export function prepareExecutionStatus(db){
 db.exec(`CREATE INDEX IF NOT EXISTS execution_question_operation ON records(partition,json_extract(body_json,'$.operationId')) WHERE kind='execution_question'`);
 db.exec(`CREATE INDEX IF NOT EXISTS execution_activity_operation ON records(partition,json_extract(body_json,'$.operationId')) WHERE kind='execution_activity'`);
}
export function readExecutionStatus(db,partition){
 const observedAt=new Date().toISOString();
 const rows=db.prepare(`WITH jobs AS (
  SELECT json_extract(o.body_json,'$.status') AS status,
   json_extract(o.body_json,'$.writebackStatus') AS writeback,
   COALESCE(json_extract(j.body_json,'$.cancelRequested'),0) AS stopping,
   json_extract(j.body_json,'$.leaseExpiresAt') AS lease,
   json_extract(a.body_json,'$.createdAt') AS admitted,
   (SELECT MIN(json_extract(q.body_json,'$.recordedAt')) FROM records q
    WHERE q.partition=j.partition AND q.kind='execution_question'
     AND json_extract(q.body_json,'$.operationId')=j.id AND json_extract(q.body_json,'$.status')='pending'
     AND json_extract(q.body_json,'$.expiresAt')>?) AS waitingSince,
   EXISTS(SELECT 1 FROM records q WHERE q.partition=j.partition AND q.kind='execution_question'
    AND json_extract(q.body_json,'$.operationId')=j.id AND json_extract(q.body_json,'$.status')='answered'
    AND json_extract(q.body_json,'$.delivery')='pending') AS answerUnsent
  FROM records j JOIN records o ON o.partition=j.partition AND o.kind='operation' AND o.id=j.id
  LEFT JOIN records a ON a.partition=j.partition AND a.kind='attempt' AND a.id=json_extract(j.body_json,'$.attemptId')
  WHERE j.partition=? AND j.kind='execution_job'
 ) SELECT COUNT(*) AS total,
  COALESCE(SUM(status='queued' AND stopping=0),0) AS queued,
  COALESCE(SUM(status='running' AND stopping=0 AND waitingSince IS NULL),0) AS running,
  COALESCE(SUM(status='running' AND stopping=0 AND waitingSince IS NOT NULL),0) AS waiting,
  COALESCE(SUM(status IN ('running','queued') AND stopping=1),0) AS stopping,
  COALESCE(SUM(status='unknown'),0) AS unknown,
  COALESCE(SUM(status='succeeded'),0) AS succeeded,
  COALESCE(SUM(status='failed'),0) AS failed,
  COALESCE(SUM(status='cancelled'),0) AS cancelled,
  COALESCE(SUM(status='needs_input'),0) AS needsInput,
  COALESCE(SUM(writeback='pending'),0) AS writebackPending,
  COALESCE(SUM(answerUnsent AND status IN ('running','unknown')),0) AS answersUnconfirmed,
  COALESCE(SUM(status='running' AND (lease IS NULL OR lease<=?)),0) AS observationExpired,
  MIN(CASE WHEN status='queued' THEN admitted END) AS oldestQueuedAt,
  MIN(CASE WHEN status='running' AND stopping=0 THEN waitingSince END) AS oldestWaitingAt
 FROM jobs`).get(observedAt,partition,observedAt);
 const {oldestQueuedAt,oldestWaitingAt,...counts}=rows;
 return {format:'synplex.execution-status/1',observedAt,counts,oldestQueuedAt,oldestWaitingAt};
}
