# Synplex shared contract — proposed SYNPLEX-J2

Version `synplex.workspace/1.0.0`, initial unpublished proposal revision J2. This additive correction keeps the six existing tools and Operation/ImportResponse structures unchanged; acceptance must identify J2 commit/hashes, not protocolVersion alone. `workspace.schema.json` defines strict JSON entities/requests; `repository.d.ts` defines exact injected module signatures. `validate.mjs` uses pinned Ajv 8.17.1 and ajv-formats 3.0.1. This is interface preparation, not an implemented repository/executor/plugin. DSH reviews this exact proposal before parallel implementation.

## Ownership

Codex owns contracts/domain, service/storage/migrations, package/AGENTS, common fixtures, AgentHub/Synplex/Codex adapters/plugins and integration. DSH owns ingestion/context/experience, Weave/DSH adapters and UI with their tests. Modules receive a scoped repository injected by the service; no second DB writer, direct SQL or old-product import with global DB state.

## Required repository/service semantics

1. Scope is exact project/version/branch. Null means explicit default, never wildcard. Owner/actor/capability/permissionRevision come from authenticated service context, never model JSON. A fixed authenticated local owner is permitted for MVP, not evidence of multi-tenant readiness.
2. Validated canonical JSON fingerprints are computed by the service. Array order matters. Blobs hash raw bytes. Error messages contain no raw data, secrets, headers or user text.
3. `MutationMeta` carries requestId and expectedStateRevision. `(owner,scope,method,requestId)` uniquely identifies an operation. Same input returns its original receipt; changed input conflicts. Duplicate lookup precedes stale-revision checking so genuine retries work. Atomic mutation writes rows/receipt/outbox or none. Semantic evidence/claim/review mutations increment stateRevision once; checkpoint/usage bookkeeping alone does not. Return new revision for next call.
4. Blob bytes are immutable and owner/scope-associated. Reusing bytes does not remove occurrences. `getBlob` checks scope association. `saveBlob` registers a staged source in that scope; a crash may leave retained staged bytes but not partially confirmed facts. No automatic orphan deletion in first release.
5. Parser revisions retain coverage/gaps/version. Partial parsing is disclosed. Block IDs are deterministic within source hash and parser version. Raw-byte ranges are provenance ranges, not assumed identical to normalized text offsets. Evidence points to exact parsed block text using UTF-16 code units and UTF-8 quote hash. Repository verifies source/revision/occurrence/block joins and ordered byte ranges.
6. Occurrence identity is `(owner,exact scope,externalSystem,formatVersion,sessionId,eventId)`. Same identity with different payloadHash is quarantined conflict; distinct event IDs retain distinct occurrences even with identical bytes. Sequence/time are data, not dedup heuristics. occurredAt may be null; recordedAt is service assigned. Late imported old material never automatically becomes current.
7. New candidate claims are pending; no caller-selected actor/review/lifecycle. Evidence and supersedes targets must belong to scope. Human confirmation of a claim is not independent business verification. Assistant statements remain labeled assistant statements. Only a controlled independent check establishes independently_checked trust; claimed performedBy or host text cannot grant it.
8. Review requires authenticated UI `review_memory` capability, optimistic revision, and service-issued authorizationId bound to actor/scope/operation. A model string is insufficient. Review/acceptance are not MCP tools. Preserve rejected/superseded decisions and prior results. Privacy deletion/retention is a separate explicitly authorized operation.
9. Query only authorized exact scope. includeHistory permits rejected/superseded records with status intact. Current confirmed facts/failures/lessons and pending/conflicts/unknowns are separate. Optional occurrence selection narrows scope. Measure short Chinese/code-name retrieval before promising semantic search.
10. Context packets are immutable, service-hashed and registered with stateRevision/permissionRevision. Goal, constraints and acceptance cannot be silently cut. Overflow returns budget_exceeded and a specific next action. Select reference excerpts with coverage disclosed. Sources remain data. Facts/failures/lessons contain active confirmed claims only; candidates/conflicts/unknowns are separate. Execution rechecks revision, grant, budget and capability. Stale snapshots remain historical, not silently edited.
11. Preparation does not execute or call models. host_assist/current_host never launches another agent. platform_owned/synplex uses platform executor; delegated/codex|dsh requires separate service-validated execution grant. Unknown capability returns capability_unavailable with setup/alternative guidance. One run has one executorOwner and at most one active owned attempt. Retries are explicit new attempts with failures preserved.
12. Execution and writeback statuses are independent. Success plus pending outbox only retries writeback. Unknown/timeout requires get_operation and executor receipt lookup, never blind re-execution. Cancel drains only owned attempt resources, never another active host.
13. Results append revisions. `(scope,runId,provider,eventId)` and fingerprint provide idempotency; changed event content conflicts. A correction is a new event with optional supersedesResultId. Late results append but cannot overwrite user edits/current state. Host artifacts remain reported until controlled file/hash checks. Output paths must lie in allowed roots; file/hash success alone is not business acceptance.
14. Usage records observation scope/provenance. Unknown is null, not zero. Repeated cumulative host snapshots are not summed as independent spend; retain raw observations and reconcile accounting windows. Estimates do not replace receipts. Include all failures/retries/reviewer time in benefit accounting.
15. Persist checkpoints atomically per chunk. Cache identity includes owner/scope, source/chunk hashes, parser/rule/prompt/model versions, permission/state revisions. Stale generated results may remain historical but cannot be applied after manual edits. Resume only missing safely unsettled chunks; unknown provider completion requires reconciliation before another paid call.

## HTTP/MCP mapping to implement

Loopback POST `/api/v1/{toolName}` uses the same schema as MCP. Reads require authentication too. Writes require scoped credentials and optimistic revision; browser Origin is checked when supplied, no public wildcard CORS. Body cap 2 MiB. Import has a separate UI upload endpoint preserving bytes. JSON Schema string limits count Unicode code points; evidence offsets separately use UTF-16 units.

| MCP tool | Request | Response |
| --- | --- | --- |
| get_project_state | GetStateRequest | ProjectState |
| find_evidence | FindEvidenceRequest | FindEvidenceResponse |
| prepare_task | PrepareTaskRequest | PrepareTaskResponse |
| record_result | RecordResultRequest | RecordResultResponse |
| propose_lesson | ProposeLessonRequest | ProposeLessonResponse |
| get_operation | GetOperationRequest | Operation |

No implicit execute/review/publish/full-session-capture MCP tool. Execute/cancel/review/acceptance are separate granted service/UI operations. Stdio MCP derives permissions from a dedicated scoped connection credential; local stdio alone is not authorization. No installation into active hosts.

UI import: POST `/api/v1/import_source` as multipart/form-data with `metadata` JSON following ImportMetadataRequest and `source` File. Dedicated upload cap: 64 MiB raw file, 2 MiB metadata, bounded parser limits; normal JSON endpoints keep the 2 MiB cap. The server assigns importOrigin=user_upload from this route; client cannot impersonate a hook. User paste uses a UTF-8 File through the same route. A persistent chunk queue is required for large imports. No retry may blindly start another extraction.

## J2 correction: retrieve completed asynchronous imports

DSH-R2 correctly found that J1's Operation.resultId had no typed retrieval route. Choose its option 1: preserve get_operation as a generic status-only tool, and add **UI-only read** POST `/api/v1/get_import_result`. Request: GetImportResultRequest (protocolVersion, exact scope, operationId). Response: ImportOperationResponse = `{operation: Operation, result: ImportResultSnapshot | null}`. Repo: `ScopedRepository.getImportResult(operationId): Promise<ImportOperationResponse>`. This method and route only read; no upload, worker start, parser/extraction call, stateRevision increment, new outbox entry, or review permission. No seventh MCP tool.

An accepted import operation has kind=import_source internally, executionStatus=not_started, writebackStatus=not_required. Operation.status describes ingestion, not agent execution. The service persists raw bytes, their scoped Blob and request/operation receipt **before acknowledging acceptance**. Post-admission failure/cancel retains the original. Pre-admission authentication, validation, body-limit or storage errors return an Error and do not claim a retained original or created operation. A crash with uncertain admission requires operation/request reconciliation, never a fabricated success.

Operation.resultId for this kind identifies an immutable ImportResultSnapshot, not a SourceBlob, ParsedRevision, Artifact or ResultRevision. Store snapshot and operation result pointer atomically. Snapshot fields: id, operationId, source, parsed (nullable only when failed/cancelled without a parsed revision), occurrences, warnings, outcome, error, recordedAt, contentHash. Content hash covers canonical validated JSON excluding contentHash. The original ImportResponse remains the **internal ingestion module response**, then the service builds/stores this snapshot. Source/parsed/occurrence joins and scopes are verified before publication. For partial/unsupported, retain a parsed coverage descriptor with unhandled gaps and the respective warning; its existence does not mean verified project facts.

Both initial upload admission and read query use ImportOperationResponse, with status fixed as follows:

| Case | Upload response | get_import_result response | Result/body meaning |
| --- | --- | --- | --- |
| Newly processed complete/partial/unsupported | 201 | 200 | result non-null; source/parsed/occurrences/warnings preserved; operation.status=succeeded; partial/unsupported may use needs_input for a settled actionable gap; outcome determines business feedback |
| Accepted queued/running | 202, Retry-After: 2 | 202, Retry-After: 2 | result=null, resultId=null; continue read polling only |
| Settled failed/cancelled after admission | 200 | 200 | non-null snapshot; raw source retained, parsed may be null; failed includes operation.error and snapshot.error; never present as business success |
| Unknown processing outcome | 200 | 200 | result=null, resultId=null; error.retry=lookup_operation; **stop automatic polling**, explain that receipts need reconciliation, do not re-upload/re-extract |
| Exact replay of an admitted upload request | 202 while queued/running, otherwise 200 | unchanged | Same original operation and stored snapshot; no extra parse/extraction/revision |
| Invalid/unauthorized upload before admission | 400/403/413/500 with Error | not applicable | No accepted operation/retained original is asserted |
| Invalid/unauthorized query | 400/403 with Error | same | No raw contents returned; wrong owner or project/version/branch denied |
| Missing/inconsistent terminal snapshot | 409 with conflict Error | same | Do not return an empty success or repair/reprocess from a read path |

Queries require trusted authenticated owner, scoped read_memory capability and the exact authorized scope, not an owner/actor supplied in JSON. An unrelated operation kind is rejected. get_operation stays HTTP 200 with Operation after authorized lookup and remains useful for uncertainty reconciliation; it does not promise an embedded result. An existing operationId is sufficient to read the final import; do not re-upload to obtain it. If upload acknowledgement was lost, an explicit same-request/same-raw-fingerprint replay returns the already admitted receipt before stale-revision checking, never reruns the worker. UI persists requestId before submission and operationId on admission.

`import-result.mjs` is a minimal executable reference projection for the query. Trusted AuthContext is augmented with authorizedScope by the already-authorized service/repository; readRecord accesses trusted storage only. It checks owner/scope/kind, snapshot pointer/hash/joins, coverage warnings and pending/terminal consistency, then returns a deep clone and HTTP status. It has no mutation or worker capability. Contract HTTP tests inject **synthetic disk receipts**, not production SQLite or DSH sessions. The actual repository/worker/upload/permissions pipeline still needs later implementation and integration checks.

Design references: [Google AIP-151](https://google.aip.dev/151) for operation/result/error and pre-admission validation; [Azure async operations](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/async-operations) for accepted polling and 202/200/Retry-After. Synplex is not claiming wire compatibility with these platforms. Their snapshots and hashes are in Obsidian.

Run: prepared → queued → running → succeeded/failed/cancelled/unknown. prepared/queued may become needs_input/cancelled. Unknown reconciles by receipt. Terminal attempts stay terminal; retries create new attempts. Host-assist may receive a receipt from prepared without pretending it observed all intermediate steps. Project-state changes need their own optimistic permitted mutation.

Errors: validation_failed→fix input; scope_denied→request access; unsupported_format→export supported format; partial_parse→retain source/show gaps; conflict→review conflict; stale_context→prepare new packet; budget_exceeded→revise explicit budget/required scope; capability_unavailable→enable/choose capable executor; writeback_pending→writeback_only. Execution timeout→lookup_operation. Client errors alone do not prove provider root cause.

## Verification boundaries

Fixtures are **synthetic Synplex-normalized inputs**, not native Codex/DSH exports. Native JSONL requires version-specific official schema and isolated-session samples. Unsupported versions retain bytes and report unsupported/partial. DSH pinned official source/docs are in Obsidian; public commit does not establish installed desktop version. Contract tests do not prove repository concurrency, host/UI integration, extraction quality or savings.

Run `npm ci --ignore-scripts` then `npm run test:contracts`. No paid model call.
