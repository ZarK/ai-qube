Review data and database sanity where applicable. Check schema assumptions, migration safety, query shape, transaction boundaries, indexing expectations, nullability, stale data, deduplication, and whether persisted evidence or metadata can drift from the source of truth.

For file-backed state, inspect path layout, atomicity expectations, stale-head handling, malformed JSON handling, redaction, and whether provider-visible data leaks local-only details.
