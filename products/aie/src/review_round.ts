import { createHash } from 'node:crypto';

// A review round groups the lane publications that belong to one head-level
// review pass. The id is deterministic over the publication identity - PR,
// head, declared lane set, and issue - never a per-invocation nonce: lanes
// re-run individually across gate invocations at the same head, and a
// per-invocation id would fragment one logical round into several that can
// never complete. Determinism also lets markers that declared an expected
// lane set before the round field existed derive their round on read.
export function reviewRoundId(input: { prNumber: number; headSha: string; expectedLanes: readonly string[]; issueNumber: number }): string {
  const lanes = normalizedRoundLanes(input.expectedLanes);
  return createHash('sha256')
    .update(JSON.stringify({ prNumber: input.prNumber, headSha: input.headSha, expectedLanes: lanes, issueNumber: input.issueNumber }))
    .digest('hex')
    .slice(0, 16);
}

export function normalizedRoundLanes(expectedLanes: readonly string[]): string[] {
  return [...new Set(expectedLanes.map(lane => lane.trim()).filter(lane => lane !== ''))].sort();
}
