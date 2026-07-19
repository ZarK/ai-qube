Review concurrency and resource behavior. Check idempotency, duplicate requests, race conditions between PR head changes and recorded evidence, file write conflicts, process lifecycle handling, retry behavior, and cleanup of long-running or background work.

Defect classes:
- Lost-update races: two writers targeting the same lock, ledger, or evidence path without exclusion.
- Stale-lock reclamation that can displace a live holder.
- Unbounded waits or missing timeouts on subprocess, lock, or route-probe operations.
- Resource leaks: file handles, temp files, or child processes not cleaned up on the failure path.

Inspect beyond the diff:
- The locking or exclusion primitive used (mkdir lock, exclusive create) and its staleness/liveness check.
- Cleanup (finally/catch) paths for every new subprocess, lock, or temp-file acquisition.
- Interaction with existing concurrency limits (per-host, global) when new parallel work is added.

Evidence to demand:
- The exact exclusion mechanism and the code path that proves two writers cannot both win.
- Confirmation a hard deadline or bounded retry exists for any new wait loop.
- A trace of the cleanup path executing on both the success and the failure branch.

Out of lane (ignore):
- Whether the computed result is correct — code-quality or data-database lane.
- Whether the operation is fast enough — performance lane.
- Whether failures are reported clearly — error-observability lane.

Exhaustiveness rules:
- Report every race, leak, or unbounded-wait risk found in one pass, blockers first.
- Do not stop after the first lock or cleanup gap; check every new concurrent or long-running path.
- State which concurrent paths were actually exercised or reasoned about versus assumed safe.
