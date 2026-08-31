import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { normalizeReviewFinding, reviewFindingKey, type ReviewRepositoryRef, type ReviewRoundDeltaInput } from '@tjalve/qube-core';
import type { Config } from '../config/index.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, gitDeltaPathsSync, verifyTrustedStoreChain, type LocalReviewLaneId } from '../local_review_evidence.js';
import { activeLocalReviewFocusesForConfig, reviewLanePublicationPolicy } from '../review_focus.js';
import { reviewRoundId } from '../review_round.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeProvider, ReviewForgeRoundSummaryPublishResult } from '../providers/review_forge_provider.js';
import { planFindingPublication, threadDispositionsFromPlans, type SynthesisLaneInput } from '../review_synthesis.js';
import { renderInlineCommentBody, renderRoundSummaryBody, type RoundSummaryLaneInput } from '../review_round_summary.js';
import { loadValidatedRoundLanes } from './pr_review_publish.js';
import type { PrGateExec } from './pr_gate.js';

const DEFAULT_REVIEW_NIT_CAP = 10;

function safeHeadSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function publishedEvidencePath(repoRoot: string, path: string): string | undefined {
  if (path.trim() === '') return undefined;
  if (!isAbsolute(path)) return path.replace(/\\/g, '/');
  const relativePath = relative(repoRoot, path);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined;
  return relativePath.replace(/\\/g, '/');
}

export function reviewRepositoryFromPullRequestUrl(url: string | undefined): ReviewRepositoryRef | undefined {
  if (!url) return undefined;
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/|$)/i.exec(url.trim());
  if (!match) return undefined;
  return { owner: match[1], name: match[2] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export const MAX_PRIOR_REVIEW_HEADS = 32;
const REVIEW_HEAD_SEGMENT = /^[a-f0-9]{7,64}$/i;

export function isPriorReviewHeadSegment(name: string, currentSeg: string): boolean {
  return name !== currentSeg && !name.includes('..') && REVIEW_HEAD_SEGMENT.test(name);
}

export function loadPriorRoundDelta(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, expectedLanes: readonly LocalReviewLaneId[]): ReviewRoundDeltaInput | undefined {
  const prDir = join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber));
  try {
    verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], prDir);
    if (!lstatSync(prDir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const currentSeg = safeHeadSegment(headSha);
  let names: string[];
  try {
    names = readdirSync(prDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isPriorReviewHeadSegment(entry.name, currentSeg))
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  if (names.length === 0 || names.length > MAX_PRIOR_REVIEW_HEADS) return undefined;
  let newest: { name: string; mtime: number } | null = null;
  for (const name of names) {
    const path = join(prDir, name);
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory()) continue;
      if (!newest || stats.mtimeMs > newest.mtime) newest = { name, mtime: stats.mtimeMs };
    } catch {
      // Skip unreadable sibling head directories.
    }
  }
  if (!newest) return undefined;
  try {
    verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], join(prDir, newest.name));
  } catch {
    return undefined;
  }
  const keys: string[] = [];
  for (const laneId of expectedLanes) {
    const evidencePath = join(prDir, newest.name, `${laneId}.json`);
    try {
      verifyTrustedStoreChain(repoRoot, ['.qube', 'aie', 'reviews'], evidencePath);
      if (!lstatSync(evidencePath).isFile()) continue;
      const parsed: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
      if (!isRecord(parsed) || !Array.isArray(parsed.findings)) continue;
      for (const item of parsed.findings) {
        if (!isRecord(item)) continue;
        try {
          const finding = normalizeReviewFinding({
            id: typeof item.id === 'string' ? item.id : undefined,
            severity: item.severity === 'blocking' ? 'blocking' : 'advisory',
            message: typeof item.message === 'string' ? item.message : '',
            ...(isRecord(item.location) && typeof item.location.path === 'string'
              ? { location: { path: item.location.path, line: typeof item.location.line === 'number' ? item.location.line : undefined, side: item.location.side === 'source' ? 'source' : 'destination' } }
              : {}),
          });
          keys.push(reviewFindingKey(laneId, finding));
        } catch {
          // Skip malformed prior findings.
        }
      }
    } catch {
      // Skip unreadable prior-head evidence.
    }
  }
  return {
    priorHeadSha: newest.name,
    priorFindingKeys: keys,
    commitRange: `${newest.name.slice(0, 12)}..${headSha.slice(0, 12)}`,
  };
}

export interface PrReviewSummaryPublishOptions {
  prNumber: number;
  issueNumber?: number;
  headSha?: string;
  dryRun?: boolean;
  repoRoot?: string;
  exec?: PrGateExec;
  expectedLanes?: readonly LocalReviewLaneId[];
  /** Expected lanes whose current-head evidence is a trusted-provider reuse marker with no local evidence file. */
  providerReuseRoutes?: readonly { lane: LocalReviewLaneId; route: import('@tjalve/qube-core').ReviewRouteProvenance }[];
  /** Owner/name used for file deep links in the round summary. */
  repository?: ReviewRepositoryRef;
  /** Paths changed by this PR head; see PrReviewPublishOptions.changedPaths for the same null/undefined/[] semantics. */
  changedPaths?: readonly string[] | null;
  deltaBaseRef?: string;
  nitCap?: number;
  laneSuppress?: Readonly<Record<string, readonly string[]>>;
  laneAdvisoryCaps?: Readonly<Record<string, number>>;
}

export interface PrReviewSummaryPublishResult {
  ok: true;
  command: 'pr review publish-summary';
  prNumber: number;
  publish: ReviewForgeRoundSummaryPublishResult;
}

export async function runPrReviewSummaryPublishWithProvider(provider: ReviewForgeProvider, options: PrReviewSummaryPublishOptions): Promise<PrReviewSummaryPublishResult> {
  if (!options.expectedLanes || options.expectedLanes.length === 0) {
    throw new Error('publish round review summary failed. Likely cause: no expected lane set was provided. Next action: resolve the active review lanes for this change before publishing the round summary.');
  }
  const declaredCapabilities = typeof provider.capabilities === 'function' ? provider.capabilities() : null;
  if ((declaredCapabilities && declaredCapabilities.publishRoundReviewSummary !== true) || !provider.publishRoundReviewSummary) {
    return {
      ok: true,
      command: 'pr review publish-summary',
      prNumber: options.prNumber,
      publish: {
        status: 'skipped',
        runId: null,
        marker: null,
        body: null,
        url: null,
        failure: null,
        nextAction: 'The configured review provider does not declare round review summary publishing; per-lane review publishing remains the provider-visible feedback surface.',
      },
    };
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const needsTarget = !options.headSha || !options.issueNumber || !options.repository;
  const target = needsTarget
    ? provider.loadPullRequestReviewTarget
      ? await provider.loadPullRequestReviewTarget(options.prNumber)
      : await provider.loadPullRequestReview(options.prNumber)
    : null;
  const headSha = options.headSha ?? target?.pr.headRefOid ?? '';
  const issueNumber = options.issueNumber ?? target?.closingIssueNumbers[0] ?? 0;
  const repository = options.repository ?? reviewRepositoryFromPullRequestUrl(target?.pr.url);
  if (issueNumber <= 0) {
    throw new Error('publish round review summary failed. Likely cause: no linked issue number was available. Next action: pass --issue or link a closing issue on the pull request.');
  }
  if (headSha === '') {
    throw new Error(`publish round review summary failed. Likely cause: pull request #${options.prNumber} did not report a head SHA. Next action: rerun once GitHub reports the current head.`);
  }

  const providedLaneIds = options.expectedLanes;
  const expectedLaneIds = [...new Set(providedLaneIds)];
  if (expectedLaneIds.length !== providedLaneIds.length) {
    throw new Error(`publish round review summary failed. Likely cause: the expected lane set contains duplicate lane ids (${providedLaneIds.join(', ')}). Next action: pass each expected lane exactly once.`);
  }
  const knownLaneIds = new Set<string>(COMPREHENSIVE_LOCAL_REVIEW_LANES);
  const unknownLaneIds = expectedLaneIds.filter(laneId => !knownLaneIds.has(laneId));
  if (unknownLaneIds.length > 0) {
    throw new Error(`publish round review summary failed. Likely cause: the expected lane set names unknown lane id(s) ${unknownLaneIds.join(', ')}. Next action: pass only configured review lane ids.`);
  }

  const providerReuseRouteMap = new Map((options.providerReuseRoutes ?? []).map(entry => [entry.lane, entry.route] as const));
  const { lanes: validatedLanes, missing } = loadValidatedRoundLanes(repoRoot, issueNumber, options.prNumber, headSha, expectedLaneIds, providerReuseRouteMap);
  if (missing.length > 0) {
    throw new Error(`publish round review summary failed. Likely cause: local review lane evidence is missing or invalid for ${missing.join(', ')}. Next action: rerun the missing lane reviews for the current head, then republish the round summary.`);
  }

  // Off-diff synthesis filtering binds to the resolved publish head, matching
  // the per-lane publish path; a failed delta observation fails closed rather
  // than silently classifying every advisory as on-diff.
  const changedPaths = options.changedPaths !== undefined
    ? options.changedPaths
    : options.deltaBaseRef
      ? gitDeltaPathsSync(repoRoot, options.deltaBaseRef, headSha)
      : undefined;
  if (changedPaths === null) {
    throw new Error('publish round review summary failed. Likely cause: the changed-path delta for this head could not be observed with git, so off-diff synthesis filtering cannot run truthfully. Next action: fetch the configured base branch and the PR head, then rerun publish.');
  }

  const synthesisLanes: SynthesisLaneInput[] = validatedLanes.map(lane => ({ laneId: lane.laneId, findings: lane.findings }));
  const plans = planFindingPublication(synthesisLanes, { changedPaths, nitCap: options.nitCap ?? DEFAULT_REVIEW_NIT_CAP, laneSuppress: options.laneSuppress, laneAdvisoryCaps: options.laneAdvisoryCaps });
  const planByLane = new Map(plans.map(plan => [plan.laneId, plan] as const));

  const roundSummaryLanes: RoundSummaryLaneInput[] = validatedLanes.map(lane => {
    const plan = planByLane.get(lane.laneId);
    return {
      laneId: lane.laneId,
      status: lane.status,
      recommendation: lane.recommendation,
      summary: lane.summary,
      findings: plan?.published ?? [],
      preconditions: lane.preconditions,
      evidenceHeadSha: lane.evidenceHeadSha,
      carriedForwardFromHeadSha: lane.carriedForwardFromHeadSha,
      origin: lane.origin,
      withheld: { duplicates: plan?.withheldDuplicates ?? 0, offDiff: plan?.withheldOffDiff ?? 0, byCap: plan?.withheldByCap ?? 0 },
      host: lane.host,
      model: lane.route.executed.reportedModel ?? lane.route.executed.transportModel ?? lane.route.executed.requestedModel,
      effort: lane.route.executed.effort,
      route: lane.route,
      profile: lane.profile,
      evidencePath: publishedEvidencePath(repoRoot, lane.path),
    };
  });

  const round = reviewRoundId({ prNumber: options.prNumber, headSha, expectedLanes: expectedLaneIds, issueNumber });
  // A missing capability yields null, same as a provider that genuinely could
  // not compute one; renderRoundSummaryBody then marks every finding
  // unanchored instead of guessing at diff coverage.
  const diffIndex = provider.loadReviewDiffIndex ? await provider.loadReviewDiffIndex(options.prNumber) : null;
  const renderInput = {
    prNumber: options.prNumber,
    issueNumber,
    headSha,
    round,
    expectedLanes: expectedLaneIds,
    lanes: roundSummaryLanes,
    repository,
    priorRound: loadPriorRoundDelta(repoRoot, issueNumber, options.prNumber, headSha, expectedLaneIds),
    rerunCommand: `aie pr gate ${options.prNumber}`,
  };
  const renderProfile = provider.id === 'gitlab' ? 'gitlab' : 'github';
  const render = renderRoundSummaryBody(renderInput, { diffIndex, transport: 'review-api', profile: renderProfile });
  const issueCommentRender = provider.id === 'gitlab'
    ? render
    : renderRoundSummaryBody(renderInput, { diffIndex, transport: 'issue-comment', profile: 'degraded' });
  const inlineFindings = render.inline.map(anchor => ({ laneId: anchor.laneId, finding: anchor.finding, commentBody: renderInlineCommentBody(anchor, { repository, headSha, profile: renderProfile }) }));
  const laneMarkers = validatedLanes.map(lane => `<!-- qube-pr-review:${JSON.stringify({
    version: 1,
    head: headSha,
    lane: lane.laneId,
    expectedLanes: expectedLaneIds,
    round,
    profile: lane.profile,
    runId: `${round}:${lane.laneId}`,
    issueNumber,
    prNumber: options.prNumber,
    host: lane.route.executed.host,
    route: lane.route,
    recommendation: lane.recommendation,
    status: lane.status,
    summary: lane.summary || `${lane.laneId} ${lane.status}`,
    inline: 'review-api',
    bodyFindingCount: lane.findings.length,
    blockingFindingCount: lane.findings.filter(finding => finding.severity === 'blocking').length,
  })} -->`).join('\n');
  const consolidatedBody = `${laneMarkers}\n${render.body}`;
  const issueCommentBody = `${laneMarkers}\n${issueCommentRender.body}`;

  const publish = await provider.publishRoundReviewSummary({
    dryRun: options.dryRun ?? false,
    prNumber: options.prNumber,
    headSha,
    round,
    issueNumber,
    expectedLanes: expectedLaneIds,
    verdict: render.verdict,
    body: consolidatedBody,
    issueCommentBody,
    marker: render.marker,
    inlineFindings,
    unanchoredFindingCount: render.unanchored.length,
    findingDigest: render.findingDigest,
    dispositions: threadDispositionsFromPlans(plans),
  });

  return { ok: true, command: 'pr review publish-summary', prNumber: options.prNumber, publish };
}

export async function runPrReviewSummaryPublishService(config: Config, options: PrReviewSummaryPublishOptions): Promise<PrReviewSummaryPublishResult> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const provider = await createReviewForgeProvider(config.providers.review.kind, { exec: options.exec, cwd: repoRoot, reviewAgents: config.reviewAgents, publisher: config.providers.review.publisher ?? null, ...config.providers.connections[config.providers.review.kind], ...config.providers.review.connection });
  const laneActivationPaths = options.changedPaths ?? gitDeltaPathsSync(repoRoot, `${config.baseRemote}/${config.baseBranch}`, options.headSha ?? 'HEAD') ?? undefined;
  const expectedLanes = options.expectedLanes ?? activeLocalReviewFocusesForConfig(config, laneActivationPaths);
  return runPrReviewSummaryPublishWithProvider(provider, {
    ...options,
    repoRoot,
    expectedLanes,
    changedPaths: options.changedPaths,
    deltaBaseRef: options.deltaBaseRef ?? `${config.baseRemote}/${config.baseBranch}`,
    nitCap: options.nitCap ?? config.reviewNitCap,
    ...reviewLanePublicationPolicy(config.reviewLanes),
  });
}

// The CLI must not report a failed provider publication as success; the
// runtime handler turns a non-null message into a failing command result.
export function prReviewSummaryPublishFailureMessage(result: PrReviewSummaryPublishResult): string | null {
  if (result.publish.status !== 'failed') return null;
  const cause = result.publish.failure ?? result.publish.nextAction ?? 'provider publication failed';
  return `Failed to publish round review summary for #${result.prNumber}. Likely cause: ${cause}.`;
}

export function formatPrReviewSummaryPublish(result: PrReviewSummaryPublishResult): string {
  return `PR review summary publish for #${result.prNumber}: ${result.publish.status}. ${result.publish.nextAction}`;
}
