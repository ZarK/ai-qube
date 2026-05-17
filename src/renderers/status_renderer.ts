import type { StatusResult } from '../app/status_service';

export function formatStatusHuman(result: StatusResult): string {
  const lines = [`Status: ${result.decision.state} (${result.decision.reasonCodes.join(', ')})`, result.decision.summary, `Next: ${result.decision.nextCommand}`];
  lines.push(`Queue: ${result.queue.summary.inProgress} active, ${result.queue.summary.ready} ready, ${result.queue.summary.blocked} blocked, ${result.queue.summary.drift} drift.`);
  if (result.currentBranch) lines.push(`Branch: ${result.currentBranch}${result.expectedBranch ? ` (expected ${result.expectedBranch.branchName})` : ''}`);
  if (result.review.warning) lines.push(`Review: ${result.review.warning}`);
  if (result.gates.configured > 0) lines.push(`Gates: ${result.gates.configured} configured, ${result.gates.requiredBlocking} blocking.`);
  return lines.join('\n');
}
