import type { Config } from '../config/index.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, gitDeltaPathsSync, type LocalReviewLaneId } from '../local_review_evidence.js';
import { activeLocalReviewFocusesForConfig, reviewLanePublicationPolicy } from '../review_focus.js';
import { reviewRoundId } from '../review_round.js';
import { createReviewForgeProvider } from '../providers/review_forge_adapters.js';
import type { ReviewForgeProvider, ReviewForgeRoundSummaryPublishResult } from '../providers/review_forge_provider.js';
import { planFindingPublication, type SynthesisLaneInput } from '../review_synthesis.js';
import { renderInlineCommentBody, renderRoundSummaryBody, type RoundSummaryLaneInput } from '../review_round_summary.js';
import { loadValidatedRoundLanes } from './pr_review_publish.js';
import type { PrGateExec } from './pr_gate.js';

const DEFAULT_REVIEW_NIT_CAP = 10;

export interface PrReviewSummaryPublishOptions {
  prNumber: number;
  issueNumber?: number;
  headSha?: string;
  dryRun?: boolean;
  repoRoot?: string;
  exec?: PrGateExec;
  expectedLanes?: readonly LocalReviewLaneId[];
  /** Expected lanes whose current-head evidence is a trusted-provider reuse marker with no local evidence file. */
  providerReuseLanes?: readonly LocalReviewLaneId[];
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
  const repoRoot = options.repoRoot ?? process.cwd();
  const target = options.headSha && options.issueNumber
    ? null
    : provider.loadPullRequestReviewTarget
      ? await provider.loadPullRequestReviewTarget(options.prNumber)
      : await provider.loadPullRequestReview(options.prNumber);
  const headSha = options.headSha ?? target?.pr.headRefOid ?? '';
  const issueNumber = options.issueNumber ?? target?.closingIssueNumbers[0] ?? 0;
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

  const providerReuseLaneSet = new Set<LocalReviewLaneId>(options.providerReuseLanes ?? []);
  const { lanes: validatedLanes, missing } = loadValidatedRoundLanes(repoRoot, issueNumber, options.prNumber, headSha, expectedLaneIds, providerReuseLaneSet);
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
      withheld: { duplicates: plan?.withheldDuplicates ?? 0, offDiff: plan?.withheldOffDiff ?? 0, byCap: plan?.withheldByCap ?? 0 },
    };
  });

  const round = reviewRoundId({ prNumber: options.prNumber, headSha, expectedLanes: expectedLaneIds, issueNumber });
  // A missing capability yields null, same as a provider that genuinely could
  // not compute one; renderRoundSummaryBody then marks every finding
  // unanchored instead of guessing at diff coverage.
  const diffIndex = provider.loadReviewDiffIndex ? await provider.loadReviewDiffIndex(options.prNumber) : null;
  const render = renderRoundSummaryBody(
    { prNumber: options.prNumber, issueNumber, headSha, round, expectedLanes: expectedLaneIds, lanes: roundSummaryLanes },
    { diffIndex },
  );
  const inlineFindings = render.inline.map(anchor => ({ laneId: anchor.laneId, finding: anchor.finding, commentBody: renderInlineCommentBody(anchor) }));

  if (!provider.publishRoundReviewSummary) {
    return {
      ok: true,
      command: 'pr review publish-summary',
      prNumber: options.prNumber,
      publish: {
        status: 'disabled',
        runId: null,
        marker: render.marker,
        body: render.body,
        url: null,
        failure: null,
        nextAction: 'The configured review provider does not support round review summaries; per-lane review publishing remains the provider-visible feedback surface.',
      },
    };
  }

  const publish = await provider.publishRoundReviewSummary({
    dryRun: options.dryRun ?? false,
    prNumber: options.prNumber,
    headSha,
    round,
    issueNumber,
    expectedLanes: expectedLaneIds,
    verdict: render.verdict,
    body: render.body,
    marker: render.marker,
    inlineFindings,
    unanchoredFindingCount: render.unanchored.length,
    findingDigest: render.findingDigest,
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
