import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { GhExec } from '../gh.js';
import type { ResolveReviewThreadResult } from '../core/review_item.js';
import { parsePrNumber } from './pr_gate.js';

export interface PrThreadResolveOptions {
  prNumber: number;
  threadIds: string[];
  all: boolean;
  dryRun: boolean;
  repoRoot?: string;
  exec?: GhExec;
}

export interface PrThreadResolveResult extends ResolveReviewThreadResult {
  ok: true;
  command: 'pr thread resolve';
  all: boolean;
}

export async function runPrThreadResolveService(options: PrThreadResolveOptions): Promise<PrThreadResolveResult> {
  const provider = await createReviewForgeProvider('github', { cwd: options.repoRoot, exec: options.exec });
  const capabilities = provider.capabilities();
  if (!capabilities.resolveReviewThreads || !provider.resolveReviewThreads) {
    throw new Error('Configured review provider cannot resolve review threads. Next action: use a provider adapter with resolveReviewThreads support.');
  }
  let threadIds = options.threadIds;
  if (options.all) {
    const snapshot = await provider.loadPullRequestReview(options.prNumber);
    threadIds = snapshot.item.conversations
      .filter(thread => !thread.resolved && thread.viewerCanResolve)
      .map(thread => thread.id);
  }
  const result = await provider.resolveReviewThreads({
    prNumber: options.prNumber,
    threadIds,
    dryRun: options.dryRun,
  });
  return {
    ok: true,
    command: 'pr thread resolve',
    all: options.all,
    ...result,
  };
}

export function formatPrThreadResolve(result: PrThreadResolveResult): string {
  const lines = [`PR #${result.prNumber} review thread resolve: ${result.status}.`];
  if (result.resolvedThreadIds.length > 0) lines.push(`Resolved: ${result.resolvedThreadIds.join(', ')}`);
  if (result.skippedThreadIds.length > 0) lines.push(`Skipped/planned: ${result.skippedThreadIds.join(', ')}`);
  if (result.failedThreadIds.length > 0) lines.push(`Failed: ${result.failedThreadIds.join(', ')}`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}

export { parsePrNumber };
