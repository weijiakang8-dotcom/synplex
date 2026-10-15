// Generated types from workspace.schema.json; repository API below is a proposed contract.
export type Scope = { projectId: string; versionId: string | null; branchId: string | null };
export type SourceBlob = { id: string; sha256: string; byteLength: number; format: "text/plain" | "text/markdown" | "application/x-ndjson" | "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/msword" | "application/rtf" | "application/vnd.oasis.opendocument.text" | "application/vnd.openxmlformats-officedocument.presentationml.presentation" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/vnd.ms-excel" | "application/vnd.ms-excel.sheet.macroEnabled.12"; createdAt: string };
export type Block = { id: string; text: string; rawStartByte: number; rawEndByte: number };
export type CoverageGap = { rawStartByte: number; rawEndByte: number; reason: string };
export type ParsedRevision = { id: string; sourceId: string; parserVersion: string; normalizedTextHash: string; blocks: Array<Block>; coverage: { status: "complete" | "partial" | "unsupported"; coveredBytes: number; totalBytes: number; gaps: Array<CoverageGap> }; recordedAt: string };
export type Occurrence = { id: string; sourceId: string; parsedRevisionId: string | null; externalSystem: string; formatVersion: string; sessionId: string | null; eventId: string; seq: number | null; importOrigin: "user_upload" | "user_paste" | "isolated_test" | "authorized_hook"; occurredAt: string | null; recordedAt: string; scope: Scope; payloadHash: string };
export type EvidenceSpan = { sourceId: string; parsedRevisionId: string; occurrenceId: string; blockId: string; start: number; end: number; offsetUnit: "utf16_code_unit"; quote: string; quoteHash: string };
export type CandidateInput = { type: "fact" | "decision" | "failure" | "lesson" | "unknown"; title: string; body: string; evidenceKind: "user_statement" | "assistant_statement" | "historical_tool_text" | "direct_tool_receipt" | "independent_check"; evidence: Array<EvidenceSpan>; occurredAt: string | null; supersedes: Array<string>; condition: string | null };
export type Claim = { type: "fact" | "decision" | "failure" | "lesson" | "unknown"; title: string; body: string; evidenceKind: "user_statement" | "assistant_statement" | "historical_tool_text" | "direct_tool_receipt" | "independent_check"; evidence: Array<EvidenceSpan>; occurredAt: string | null; supersedes: Array<string>; condition: string | null; id: string; lifecycle: "active" | "superseded" | "retracted"; reviewStatus: "pending" | "confirmed" | "rejected"; recordedAt: string; effectiveFrom: string | null; effectiveUntil: string | null; actorId: string };
export type Usage = { observationScope: "preparation_only" | "attempt" | "run" | "host_unavailable"; provider: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; costUsd: number | null; pricingRevision: string | null; provenance: "no_model_call" | "provider_receipt" | "invoice" | "estimate" | "unknown" };
export type ContextPacket = { id: string; protocolVersion: "synplex.workspace/1.0.0"; scope: Scope; stateRevision: number; permissionRevision: number; goal: string; constraints: Array<string>; acceptanceCriteria: Array<string>; facts: Array<Claim>; failures: Array<Claim>; lessons: Array<Claim>; candidates: Array<Claim>; conflicts: Array<string>; unknowns: Array<string>; evidence: Array<EvidenceSpan>; selectedOccurrenceIds: Array<string>; coverage: "complete" | "partial" | "needs_input"; budget: { maxInputTokens: number; reservedTokens: number; estimatedTokens: number; estimatorVersion: string }; contentHash: string; createdAt: string; executionOptions?: ExecutionOptions; taskInputs?: Array<{ resultId: string; resultHash: string; summary: string; artifacts: Array<Artifact>; role: "upstream" | "previous_version" | "conversation" }> };
export type Artifact = { id: string; name: string; uri: string; sha256: string; byteLength: number; mediaType: string; verification: "reported" | "hash_verified" | "unavailable" };
export type Check = { id: string; method: string; status: "passed" | "failed" | "not_run" | "unknown"; artifactIds: Array<string>; evidence: string; performedBy: string; recordedAt: string };
export type ResultInput = { eventId: string; attemptId: string; provider: string; summary: string; artifacts: Array<Artifact>; checks: Array<Check>; usage: Usage; supersedesResultId: string | null; occurredAt: string | null };
export type ResultRevision = { eventId: string; attemptId: string; provider: string; summary: string; artifacts: Array<Artifact>; checks: Array<Check>; usage: Usage; supersedesResultId: string | null; occurredAt: string | null; id: string; revision: number; payloadHash: string; actorId: string; recordedAt: string; trust: "host_reported" | "platform_receipt" | "independently_checked" };
export type Attempt = { id: string; runId: string; executorOwner: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"; resultRevisionIds: Array<string>; usage: Usage; createdAt: string; finishedAt: string | null };
export type Run = { id: string; scope: Scope; contextPacketId: string; requestId: string; mode: "host_assist" | "platform_owned" | "delegated"; executorOwner: string; status: "prepared" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "needs_input" | "unknown"; writebackStatus: "not_required" | "pending" | "saved" | "conflict"; attemptIds: Array<string>; createdAt: string };
export type Acceptance = { id: string; resultRevisionId: string; acceptedArtifactIds: Array<string>; criteria: Array<string>; actorId: string; authorizationId: string; recordedAt: string };
export type Operation = { id: string; requestId: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "needs_input" | "unknown"; executionStatus: "not_started" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"; writebackStatus: "not_required" | "pending" | "saved" | "conflict"; resultId: string | null; error: Error | null };
export type Error = { code: "validation_failed" | "scope_denied" | "unsupported_format" | "partial_parse" | "conflict" | "stale_context" | "budget_exceeded" | "capability_unavailable" | "writeback_pending"; message: string; nextAction: string; retry: "never" | "after_input" | "lookup_operation" | "writeback_only"; operationId: string | null };
export type ExecutionOptions = { model: string; effort: string };
export type PrepareTaskRequest = { protocolVersion: "synplex.workspace/1.0.0"; requestId: string; scope: Scope; expectedStateRevision: number; goal: string; constraints: Array<string>; acceptanceCriteria: Array<string>; mode: "host_assist" | "platform_owned" | "delegated"; executor: "current_host" | "synplex" | "codex" | "dsh"; selectedOccurrenceIds: Array<string>; maxInputTokens: number; executionOptions?: ExecutionOptions };
export type RecordResultRequest = { protocolVersion: "synplex.workspace/1.0.0"; requestId: string; scope: Scope; expectedStateRevision: number; runId: string; result: ResultInput };
export type ProposeLessonRequest = { protocolVersion: "synplex.workspace/1.0.0"; requestId: string; scope: Scope; expectedStateRevision: number; candidate: CandidateInput };
export type GetStateRequest = { protocolVersion: "synplex.workspace/1.0.0"; scope: Scope };
export type FindEvidenceRequest = { protocolVersion: "synplex.workspace/1.0.0"; scope: Scope; query: string; limit: number; includeHistory: boolean };
export type GetOperationRequest = { protocolVersion: "synplex.workspace/1.0.0"; scope: Scope; operationId: string };
export type ReviewRequest = { protocolVersion: "synplex.workspace/1.0.0"; requestId: string; scope: Scope; expectedStateRevision: number; claimId: string; reviewStatus: "confirmed" | "rejected" | "pending"; authorizationId: string };
export type ChunkCheckpoint = { id: string; sourceId: string; chunkHash: string; cacheKey: string; parserVersion: string; ruleVersion: string; promptVersion: string | null; model: string | null; permissionRevision: number; stateRevision: number; status: "pending" | "running" | "succeeded" | "failed" | "unknown"; candidateIds: Array<string>; attemptIds: Array<string>; usage: Usage };
export type ProjectState = { scope: Scope; stateRevision: number; permissionRevision: number; facts: Array<Claim>; decisions: Array<Claim>; failures: Array<Claim>; lessons: Array<Claim>; pending: Array<Claim>; conflicts: Array<string>; unknowns: Array<string> };
export type EvidenceHit = { claim: Claim | null; span: EvidenceSpan; occurrence: Occurrence };
export type FindEvidenceResponse = { items: Array<EvidenceHit>; cursor: string | null; stateRevision: number };
export type PrepareTaskResponse = { packet: ContextPacket; run: Run; operation: Operation };
export type RecordResultResponse = { result: ResultRevision; operation: Operation };
export type ProposeLessonResponse = { claim: Claim; operation: Operation };
export type ImportMetadataRequest = { protocolVersion: "synplex.workspace/1.0.0"; requestId: string; scope: Scope; expectedStateRevision: number; format: "text/plain" | "text/markdown" | "application/x-ndjson" | "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" | "application/msword" | "application/rtf" | "application/vnd.oasis.opendocument.text" | "application/vnd.openxmlformats-officedocument.presentationml.presentation" | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" | "application/vnd.ms-excel" | "application/vnd.ms-excel.sheet.macroEnabled.12"; sourceName?: string; sourceSystem: string; formatVersion: string; sessionId: string | null; eventId: string; occurredAt: string | null };
export type ImportResponse = { source: SourceBlob; parsed: ParsedRevision; occurrences: Array<Occurrence>; operationId: string; warnings: Array<Error> };
export type GetImportResultRequest = { protocolVersion: "synplex.workspace/1.0.0"; scope: Scope; operationId: string };
export type ImportResultSnapshot = { source: SourceBlob; parsed: ParsedRevision | null; occurrences: Array<Occurrence>; operationId: string; warnings: Array<Error>; id: string; outcome: "complete" | "partial" | "unsupported" | "failed" | "cancelled"; error: Error | null; recordedAt: string; contentHash: string };
export type ImportOperationResponse = { operation: Operation; result: ImportResultSnapshot | null };
export type Stored<T> = T & { ownerId: string };
// Bound by the trusted service; caller/LLM never chooses actor identity or capabilities.
export interface AuthContext { readonly actorId: string; readonly ownerId: string; readonly permissionRevision: number; readonly capabilities: ReadonlySet<string> }
export interface MutationMeta { requestId: string; expectedStateRevision: number }
export interface MutationReply<T> { value: T; stateRevision: number; operationId: string; duplicate: boolean }
export interface Page<T> { items: T[]; cursor: string | null; stateRevision: number }
export type OccurrenceInput = Omit<Occurrence, 'id' | 'recordedAt' | 'scope'>;
export type ParsedRevisionInput = Omit<ParsedRevision, 'id' | 'recordedAt'>;
export interface EvidenceQuery { query: string; limit: number; cursor: string | null; includeHistory: boolean; occurrenceIds: string[] | null }
export interface ScopedRepository {
 readonly scope: Readonly<Scope>;
 getState(): Promise<ProjectState>;
 saveBlob(input: { bytes: Uint8Array; format: SourceBlob['format'] }, meta: MutationMeta): Promise<MutationReply<SourceBlob>>;
 getBlob(sourceId: string): Promise<{ blob: SourceBlob; bytes: Uint8Array }>;
 getSourceMetadata(sourceId: string): Promise<{ id: string; revision: number; title: string; category: string; tags: string[]; locked: boolean }>;
 appendParsedRevisions(input: ParsedRevisionInput[], meta: MutationMeta): Promise<MutationReply<ParsedRevision[]>>;
 appendOccurrences(input: OccurrenceInput[], meta: MutationMeta): Promise<MutationReply<Occurrence[]>>;
 appendCandidates(input: CandidateInput[], meta: MutationMeta): Promise<MutationReply<Claim[]>>;
 queryEvidence(query: EvidenceQuery): Promise<Page<{ claim: Claim | null; span: EvidenceSpan; occurrence: Occurrence }>>;
 listOccurrences(query: { cursor: string | null; limit: number }): Promise<Page<Occurrence>>;
 getChunkCheckpoint(cacheKey: string): Promise<ChunkCheckpoint | null>;
 saveChunkCheckpoint(checkpoint: ChunkCheckpoint, meta: MutationMeta): Promise<MutationReply<ChunkCheckpoint>>;
 getOperation(operationId: string): Promise<Operation>;
 // Read-only retained import snapshot; never invokes ingestion or changes revision.
 getImportResult(operationId: string): Promise<ImportOperationResponse>;
}
export interface WorkspaceRepository {
 forScope(auth: AuthContext, scope: Scope): Promise<ScopedRepository>;
}
// Module entry points implemented by DSH, injected scoped repository only (no database singleton).
export interface IngestionModule {
 importSource(repo: ScopedRepository, input: { bytes: Uint8Array; format: SourceBlob['format']; sourceSystem: string; formatVersion: string; sessionId: string | null; eventId: string; occurredAt: string | null; importOrigin: Occurrence['importOrigin'] }, meta: MutationMeta): Promise<{ source: SourceBlob; parsed: ParsedRevision; occurrences: Occurrence[]; operationId: string; warnings: Error[] }>;
}
export interface ContextModule {
 prepareContext(repo: ScopedRepository, input: PrepareTaskRequest, options: { reservedTokens: number; estimatorVersion: string }): Promise<ContextPacket>;
}
export interface ExperienceModule {
 propose(repo: ScopedRepository, candidate: CandidateInput, meta: MutationMeta): Promise<MutationReply<Claim[]>>;
}

export type ReconcileUsageRequest = { protocolVersion: "synplex.workspace/1.0.0"; scope: Scope; requestId: string; expectedStateRevision: number; attemptId: string; costUsd: number; receiptReference: string; supersedesId: string | null };
