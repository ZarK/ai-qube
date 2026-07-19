Review performance risk in the changed paths. Check algorithmic complexity, avoidable repeated provider/API calls, large payload handling, synchronous filesystem or process work in hot paths, unnecessary serialization, and work that scales with comments, checks, issues, or repository size.

Defect classes:
- Quadratic or worse loops over comments, checks, issues, lanes, or files that should be linear.
- Repeated provider or API calls inside a loop that could be batched or cached.
- Synchronous filesystem or subprocess calls on a path that runs per-item instead of once.
- Missing bounds or pagination on collections that grow with repository or PR history size.

Inspect beyond the diff:
- Call sites that invoke the changed function inside a loop or per-lane/per-issue iteration.
- Existing caching or batching patterns nearby that the change bypassed.
- Test fixtures with realistic size versus toy inputs that hide scaling behavior.

Evidence to demand:
- The specific loop or call site and its bound, or lack of one, cited by file:line.
- A rough complexity or call-count estimate for the changed path under realistic scale.
- Confirmation whether an existing bounded or cached alternative was available and skipped.

Out of lane (ignore):
- Correctness of the algorithm's output — code-quality lane.
- Resource cleanup and concurrency safety — concurrency-resource lane.
- Whether the (slow) output is still accurate — data-database lane.

Exhaustiveness rules:
- Report every performance risk found across the diff in one pass, ranked by likely impact.
- Do not stop at the first hot-path concern; keep checking the remaining changed call sites.
- State which paths were actually traced for call frequency versus assumed safe.
