# Experience proposals

`propose(repo, candidate, meta)` implements the frozen ExperienceModule signature and returns the repository's `MutationReply<Claim[]>` for exactly one lesson. It uses only the injected scoped repository; no model, database singleton, background worker, execution, or review grant is created.

The module validates the closed CandidateInput schema, requires `type: 'lesson'`, a nonblank applicability condition, at least one evidence span with readable quote, and valid closed MutationMeta. It snapshots candidate (including nested evidence and supersedes) and metadata synchronously before yielding. It does not trim, rewrite, downgrade evidenceKind, or substitute a request ID.

The actual repository enforces current authentication/write capability, exact owner/project/version/branch partition, source/parsed/occurrence linkage, block membership, UTF-16 boundaries, exact quote and SHA256, and trusted_evidence capability for direct_tool_receipt/independent_check. These checks happen atomically with the write. Repository-created claims are pending and receive the repository actor; uploaded instructions or self-reported success never create review authority. An explicitly authorized trusted caller's evidenceKind is preserved, not interpreted or independently certified by this module. All writes and reviews remain repository-owned.

There is deliberately no pre-write getState or queryEvidence. appendCandidates resolves an exact persisted request receipt before checking stale expectedStateRevision, while changed candidate content with the same request ID conflicts. Current authorization is still required for replay. Failed writes leave no semantic revision, claim, operation, or receipt. Real `forScope` itself requires read_memory; proposals additionally require write_memory.

A duplicate response is the original immutable mutation receipt, not a refreshed view of the claim. After human rejection, replay may return the original pending receipt while the stored claim remains rejected; clients must read current project/claim state for current review status. A new request ID denotes a new proposal and can create another pending claim: this module does not implement semantic deduplication or reinstate a rejected claim.

A nonblank condition is a caller-supplied applicability description, not proof that the proposed lesson is correct, generalizes, or is actionable in a real project. Semantic review, condition extraction, automatic synthesis, promotion/confirmation, outcome verification, experience ranking, UI and real host/business acceptance are outside this module. Evidence must already exist; this module does not import or search originals. The parser/occurrence attribution limitations of the ingestion stage still apply.

Run the isolated SQLite tests from the worktree root:

```sh
node --test --test-reporter=tap test/experience/*.test.mjs
```

Tests reuse the unchanged ingestion helper and real ingested originals. They cover repository attribution, UI/agent permissions, trusted evidence handling, malicious uploaded instructions/extra fields, blank condition/evidence, quote/hash/link/scope integrity, duplicate/stale/conflicting requests, rejection and SQLite restart, caller mutation during delayed admission, and transaction rollback. They do not invoke paid models or active hosts.
