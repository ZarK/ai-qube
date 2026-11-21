import type { LaneEvidence } from './local_review_runner_support.js';

const STATUS_RANK: Record<string, number> = { failed: 3, 'needs-work': 2 };
const SEVERITY_ORDER = ['none', 'low', 'medium', 'high', 'critical'] as const;

function unique<T>(values: readonly T[], key: (value: T) => string = value => JSON.stringify(value)): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(value);
  }
  return kept;
}

/**
 * Merge a continuation run into the evidence of the earlier runs of the same
 * lane at the same head. The earlier runs left `continuedFiles` unread; the
 * continuation reviewed only those files. A blocking verdict from any run
 * wins. Otherwise the continuation's verdict stands, because the earlier
 * runs were inconclusive only for the files they did not read. Findings and
 * inspection records are kept from every run, and the earlier provenance,
 * which records the full-scope budget, stays the lane's provenance.
 */
export function mergeLaneContinuation(earlier: LaneEvidence, continuation: LaneEvidence, continuedFiles: number, scopeFiles: number): LaneEvidence {
  const blocking = [earlier, continuation]
    .filter(part => (STATUS_RANK[part.status] ?? 0) > 0)
    .sort((left, right) => (STATUS_RANK[right.status] ?? 0) - (STATUS_RANK[left.status] ?? 0))[0];
  let status = blocking?.status ?? continuation.status;
  if (status === 'passed' && continuation.notInspected.length > 0) status = 'inconclusive';
  const recommendation = status === 'passed' ? 'approve' : status === 'failed' || status === 'needs-work' ? 'request-changes' : 'inconclusive';
  const severityIndex = Math.max(SEVERITY_ORDER.indexOf(earlier.severity as typeof SEVERITY_ORDER[number]), SEVERITY_ORDER.indexOf(continuation.severity as typeof SEVERITY_ORDER[number]), 0);
  // A non-blocking merged verdict never carries a blocking severity.
  const severity = recommendation === 'request-changes' ? SEVERITY_ORDER[severityIndex] : SEVERITY_ORDER[Math.min(severityIndex, 2)];
  const note = `QUBE continued this lane over ${continuedFiles} changed file(s) an earlier run did not read; the verdict covers the ${scopeFiles - continuation.notInspected.length} of ${scopeFiles} changed files in scope that a run read.`;
  return {
    ...earlier,
    status,
    severity,
    recommendation,
    summary: `${earlier.summary} Continuation: ${continuation.summary} ${note}`,
    blockers: recommendation === 'request-changes' ? unique([...earlier.blockers, ...continuation.blockers], value => value) : [],
    findings: [...earlier.findings, ...continuation.findings],
    artifacts: unique([...earlier.artifacts, ...continuation.artifacts], artifact => JSON.stringify([artifact.kind, artifact.path])),
    commands: unique([...earlier.commands, ...continuation.commands], value => value),
    surfaces: unique([...earlier.surfaces, ...continuation.surfaces], value => value),
    contextReviewed: unique([...earlier.contextReviewed, ...continuation.contextReviewed]),
    toolsUsed: unique([...earlier.toolsUsed, ...continuation.toolsUsed], value => value),
    completeness: `${earlier.completeness} Continuation: ${continuation.completeness} ${note}`,
    preconditions: unique([...earlier.preconditions, ...continuation.preconditions], value => value),
    notInspected: [...continuation.notInspected],
  };
}
