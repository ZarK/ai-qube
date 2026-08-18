import { loginsMatch } from '@tjalve/qube-core';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import { getDefaults, loadConfig } from '../config/index.js';
import { resolveGitHubReviewPublisher, type GhExec } from '../providers/github_adapter_exports.js';
import type { ResolveReviewThreadResult } from '../core/review_item.js';
import { parsePrNumber } from './pr_gate.js';

export interface PrThreadResolveOptions {
  prNumber: number;
  threadIds: string[];
  all: boolean;
  includeOtherAuthors?: boolean;
  dryRun: boolean;
  repoRoot?: string;
  exec?: GhExec;
  publisherLogin?: string | null;
}

export interface PrThreadResolveResult extends ResolveReviewThreadResult {
  ok: true;
  command: 'pr thread resolve';
  all: boolean;
}

function githubLoginsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const withoutBotSuffix = (login: string | null | undefined): string | null => login?.replace(/\[bot\]$/i, '') ?? null;
  return loginsMatch(left, right) || loginsMatch(withoutBotSuffix(left), withoutBotSuffix(right));
}

export async function runPrThreadResolveService(options: PrThreadResolveOptions): Promise<PrThreadResolveResult> {
  const config = await loadConfig(options.repoRoot ?? process.cwd()) ?? getDefaults();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { cwd: options.repoRoot, exec: options.exec, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  const capabilities = provider.capabilities();
  if (!capabilities.resolveReviewThreads || !provider.resolveReviewThreads) {
    throw new Error('Configured review provider cannot resolve review threads. Next action: use a provider adapter with resolveReviewThreads support.');
  }
  let threadIds = options.threadIds;
  let skippedOtherAuthorIds: string[] = [];
  if (options.all) {
    const snapshot = await provider.loadPullRequestReview(options.prNumber);
    const resolvable = snapshot.item.conversations.filter(thread => !thread.resolved && thread.viewerCanResolve);
    let publisherLogin = options.publisherLogin
      ?? config.providers.review.publisher?.githubApp?.login
      ?? config.providers.review.publisher?.token?.login
      ?? null;
    if (options.publisherLogin == null && options.includeOtherAuthors !== true) {
      try {
        const resolved = await resolveGitHubReviewPublisher(config.providers.review.publisher ?? null, {
          cwd: options.repoRoot,
          exec: options.exec,
          mint: true,
        });
        publisherLogin = resolved.identity.login ?? publisherLogin;
      } catch {
        // Retain the trusted configured login when live identity resolution is unavailable.
      }
    }
    if (options.includeOtherAuthors === true) {
      threadIds = resolvable.map(thread => thread.id);
    } else {
      const matchesPublisher = (author: string | null | undefined): boolean => githubLoginsMatch(author, publisherLogin);
      threadIds = resolvable.filter(thread => matchesPublisher(thread.author)).map(thread => thread.id);
      skippedOtherAuthorIds = resolvable.filter(thread => !matchesPublisher(thread.author)).map(thread => thread.id);
    }
    if (threadIds.length === 0 && skippedOtherAuthorIds.length > 0) {
      return {
        ok: true,
        command: 'pr thread resolve',
        all: options.all,
        status: 'skipped',
        prNumber: options.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: skippedOtherAuthorIds,
        failedThreadIds: [],
        nextAction: `Skipped ${skippedOtherAuthorIds.length} thread(s) authored by other identities. Pass --include-other-authors to resolve them.`,
      };
    }
  }
  const result = await provider.resolveReviewThreads({
    prNumber: options.prNumber,
    threadIds,
    dryRun: options.dryRun,
  });
  const skippedThreadIds = [...new Set([...result.skippedThreadIds, ...skippedOtherAuthorIds])];
  return {
    ok: true,
    command: 'pr thread resolve',
    all: options.all,
    ...result,
    skippedThreadIds,
    nextAction: skippedOtherAuthorIds.length > 0
      ? `${result.nextAction} Skipped ${skippedOtherAuthorIds.length} thread(s) authored by other identities; pass --include-other-authors to resolve them.`
      : result.nextAction,
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
