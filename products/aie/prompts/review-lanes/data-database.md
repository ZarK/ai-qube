Review data and database sanity where applicable. Check schema assumptions, migration safety, query shape, transaction boundaries, indexing expectations, nullability, stale data, deduplication, and whether persisted evidence or metadata can drift from the source of truth.

Defect classes:
- Stale-head evidence: persisted state keyed to an old head or version silently reused for the current one.
- Malformed or partially written JSON left in a state that a later reader trusts as valid.
- Non-atomic writes that can leave a file half-written or readable mid-update.
- Deduplication or merge logic that drops or double-counts records.

Inspect beyond the diff:
- Every reader of the changed persisted shape for now-stale assumptions about required fields.
- Path layout and directory scoping for the new or changed state (issue/PR/head segmentation).
- Redaction and provider-visible leakage of local-only file paths or fields.

Evidence to demand:
- The exact file path layout and an example of the written JSON shape.
- Confirmation writes are atomic (temp file plus rename, or a guarded write) and cited by function.
- A case showing malformed or missing input is rejected rather than silently accepted.

Out of lane (ignore):
- Whether producers and callers use the same current public data contract.
- Concurrent access races — concurrency-resource lane.
- CI artifact packaging — release-ci-supply-chain lane.

Exhaustiveness rules:
- Report every data-integrity defect found in one pass, ranked by risk of silent corruption.
- Do not stop at the first stale-head or malformed-input gap; check every persisted shape touched.
- State which readers and writers of the persisted state were actually traced.
