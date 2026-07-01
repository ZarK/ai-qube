import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createAction,
  createActionPlan,
  normalizeGateEvidence,
  normalizeProviderSource,
  normalizeReviewItem,
  normalizeReviewFinding,
  partitionReviewFindings,
  type Action,
  type ActionPlan,
  type ActionResult,
  type GateEvidence,
  type GateEvidenceReasonCode,
  type GateResult,
  type JsonObject,
  type JsonValue,
  type ResolveReviewThreadInput,
  type ResolveReviewThreadResult,
  type ReviewFeedback,
  type ReviewConversation,
  type ReviewFinding,
  type ReviewFindingSide,
  type ReviewForgeCapabilities,
  type ReviewForgePlanOptions,
  type ReviewForgePolicy,
  type ReviewMergeBlock,
  type ReviewForgeProvider,
  type ReviewItem,
  type ReviewItemKey,
} from '@tjalve/qube-core';

import {
  MARKER_PREFIX,
  QUBE_REVIEW_SERVICE_NAME,
  commentBodyFor,
  isNonActionableSummary,
  markerFor,
  normalizeHandle,
  resolveReviewAgent,
  reviewerId,
  reviewerMarkerBodyFor,
  sanitizeFeedbackText,
  triggerFor,
} from './github_review_agents.js';
import type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot, LoginResponse, RawAuthor, RawComment, RawIssueComment, RawPrView, RawReview, RawReviewComment, RawReviewRequest, RawStatusCheck, RawThreadNode, RawThreadResponse } from './github_review_types.js';
import { GhExecutionError, parseGhJson, redact, runGh, type GhRunResult } from './gh.js';

export type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot } from './github_review_types.js';
export { MARKER_PREFIX, QUBE_REVIEW_SERVICE_NAME, listGitHubReviewAgents, resolveReviewAgent } from './github_review_agents.js';

const PR_VIEW_FIELDS = 'number,title,state,url,headRefOid,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,reviews,latestReviews,statusCheckRollup,closingIssuesReferences';
const CURRENT_PR_FIELDS = 'number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft';
const LOCAL_REVIEW_MARKER_PREFIX = 'qube-local-review';
const LANE_REVIEW_MARKER_PREFIX = 'qube-pr-review';

export type GitHubLocalReviewRecommendation = 'approve' | 'request-changes' | 'pending' | 'inconclusive';
export type GitHubLocalReviewPublishStatus = 'disabled' | 'pending' | 'planned' | 'published' | 'skipped' | 'failed';

export interface GitHubLocalReviewPublishInput {
  enabled: boolean;
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  profile: string;
  status: string;
  recommendation: GitHubLocalReviewRecommendation;
  runner: string;
  host: string;
  evidencePath: string | null;
  issueNumbers: number[];
  lanes: string[];
  summary: string;
  findings: string[];
}

export interface GitHubLocalReviewPublishResult {
  status: GitHubLocalReviewPublishStatus;
  runId: string | null;
  marker: string | null;
  body: string | null;
  url: string | null;
  publishKind?: 'issue-comment' | 'pull-request-review';
  inlineCommentCount?: number;
  bodyFindingCount?: number;
  reviewUrl?: string | null;
  inlineCommentUrls?: string[];
  failure: string | null;
  nextAction: string;
}

interface LocalReviewMetadata {
  version: number;
  head: string;
  runner: string;
  host: string;
  profile: string;
  runId: string;
  evidence: string | null;
  recommendation: GitHubLocalReviewRecommendation;
  status: string;
  issueNumbers: number[];
  lanes: string[];
  inline: 'unsupported';
}

interface LocalReviewComment {
  metadata: LocalReviewMetadata;
  author: RawAuthor | null | undefined;
  body: string;
  url: string | null;
  stale: boolean;
}

interface LaneReviewMetadata {
  version: number;
  head: string;
  lane: string;
  profile: string;
  runId: string;
  issueNumber: number;
  prNumber: number;
  host: string;
  recommendation: GitHubLocalReviewRecommendation;
  status: string;
  summary: string;
  inline: 'issue-comment' | 'review-api' | 'unsupported';
  reviewId?: string | null;
  inlineCommentCount?: number;
  bodyFindingCount?: number;
  findingDigest?: string;
}

interface LaneReviewComment {
  metadata: LaneReviewMetadata;
  author: RawAuthor | null | undefined;
  body: string;
  url: string | null;
  stale: boolean;
}

export interface GitHubLaneReviewPublishInput {
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  lane: string;
  profile: string;
  status: string;
  recommendation: GitHubLocalReviewRecommendation;
  host: string;
  issueNumber: number;
  summary: string;
  findings: Array<ReviewFinding | string>;
  evidencePath: string | null;
}

export interface GitHubLaneReviewPublishResult {
  status: GitHubLocalReviewPublishStatus;
  runId: string | null;
  marker: string | null;
  body: string | null;
  url: string | null;
  publishKind?: 'issue-comment' | 'pull-request-review';
  inlineCommentCount?: number;
  bodyFindingCount?: number;
  reviewUrl?: string | null;
  inlineCommentUrls?: string[];
  failure: string | null;
  nextAction: string;
}

interface RawCheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; html_url?: string; details_url?: string; check_suite?: { id?: number } | null }
interface RawCheckRunsResponse { check_runs?: RawCheckRun[] }
interface RawCheckSuite { id?: number; status?: string; conclusion?: string | null; head_sha?: string | null }
interface RawCheckSuitesResponse { check_suites?: RawCheckSuite[] }
interface RawWorkflowRun { id?: number; name?: string; head_sha?: string | null; status?: string; conclusion?: string | null; html_url?: string; path?: string | null; workflow_id?: number }
interface RawWorkflowRunsResponse { workflow_runs?: RawWorkflowRun[] }
interface RawCreatedPullReview { id?: number | string; html_url?: string; url?: string }

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function isRawPrView(value: unknown): value is RawPrView {
  if (!isRecord(value)) return false;
  return typeof value.number === 'number' && typeof value.title === 'string' && typeof value.state === 'string' && typeof value.url === 'string';
}

function isRawReviewCommentArray(value: unknown): value is RawReviewComment[] | RawReviewComment[][] { return Array.isArray(value) && value.every(item => isRecord(item) || (Array.isArray(item) && item.every(isRecord))); }

function isRawIssueCommentArray(value: unknown): value is RawIssueComment[] | RawIssueComment[][] { return Array.isArray(value) && value.every(item => isRecord(item) || (Array.isArray(item) && item.every(isRecord))); }

function isRawPrCommentsView(value: unknown): value is { comments?: RawComment[] } { return isRecord(value) && (value.comments === undefined || Array.isArray(value.comments)); }

function isRawThreadResponse(value: unknown): value is RawThreadResponse { return isRecord(value); }

function isLoginResponse(value: unknown): value is LoginResponse { return isRecord(value) && typeof value.login === 'string' && value.login !== ''; }

function isRawCheckRunArray(value: unknown): value is RawCheckRunsResponse {
  return isRecord(value) && (value.check_runs === undefined || Array.isArray(value.check_runs));
}

function isRawCheckSuiteArray(value: unknown): value is RawCheckSuitesResponse {
  return isRecord(value) && (value.check_suites === undefined || Array.isArray(value.check_suites));
}

function isRawWorkflowRunArray(value: unknown): value is RawWorkflowRunsResponse {
  return isRecord(value) && (value.workflow_runs === undefined || Array.isArray(value.workflow_runs));
}

function isRawWorkflowRun(value: unknown): value is RawWorkflowRun {
  return isRecord(value) && typeof value.id === 'number';
}

function ensureGhSuccess(operation: string, result: GhRunResult): void {
  if (result.exitCode !== 0) throw new GhExecutionError(operation, result.exitCode, result.stderr || result.stdout);
}

function actorName(author: RawAuthor | null | undefined): string { return redact(author?.login ?? 'unknown'); }

function isResolvedProviderReviewSummary(text: string | undefined): boolean {
  const normalized = sanitizeFeedbackText(text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized.startsWith('**actionable comments posted:')) return true;
  if (/^\*\*\d+ issues? found\*\* across\b/.test(normalized)) return true;
  return false;
}

function summarize(text: string | undefined): string {
  const normalized = redact(sanitizeFeedbackText(text).replace(/\s+/g, ' ').trim());
  if (normalized === '') return 'No body text supplied.';
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function trustedMarkerComment(comment: RawComment, trustedAuthor: string | null): boolean {
  return trustedAuthor !== null && authorMatches(comment.author?.login ?? '', trustedAuthor) && (comment.body ?? '').includes(`<!-- ${MARKER_PREFIX}:`);
}

function hasMarker(comments: RawComment[], reviewer: string, headSha: string, trustedAuthor: string | null): boolean {
  return comments.some(comment => trustedMarkerComment(comment, trustedAuthor) && (comment.body ?? '').includes(markerFor(reviewer, headSha)));
}

function hasStaleMarker(comments: RawComment[], reviewer: string, headSha: string, trustedAuthor: string | null): boolean {
  if (hasMarker(comments, reviewer, headSha, trustedAuthor)) return false;
  const prefix = `<!-- ${MARKER_PREFIX}:${reviewerId(reviewer)}:`;
  return comments.some(comment => trustedMarkerComment(comment, trustedAuthor) && (comment.body ?? '').includes(prefix));
}

function authorMatches(author: string, reviewer: string): boolean {
  return author.toLowerCase().replace(/^@/, '') === reviewer.toLowerCase().replace(/^@/, '');
}

function isCurrentReview(reviews: RawReview[], reviewer: string, headSha: string): boolean {
  return reviews.some(review => authorMatches(review.author?.login ?? '', reviewer) && review.commit?.oid === headSha);
}

function hasStaleReview(reviews: RawReview[], reviewer: string, headSha: string): boolean {
  return reviews.some(review => authorMatches(review.author?.login ?? '', reviewer) && !!review.commit?.oid && review.commit.oid !== headSha);
}

function isPendingRequest(reviewRequests: string[], reviewer: string): boolean { return reviewRequests.some(request => authorMatches(request, reviewer)); }

function hostReviewAdapter(adapter: ReviewForgePolicy['adapter']): boolean {
  return adapter === 'local' || adapter === 'mixed' || adapter === 'shadow';
}

function configuredReviewerNames(policy: ReviewForgePolicy, activeLanes: readonly string[] = []): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const adapter = policy.adapter;
  const sources = adapter === 'local' ? [] : policy.reviewers;
  for (const rawName of sources) {
    const name = rawName.trim();
    if (name === '') continue;
    const id = reviewerId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    names.push(name);
  }
  if (hostReviewAdapter(adapter) && activeLanes.length > 0) {
    const hostId = reviewerId(QUBE_REVIEW_SERVICE_NAME);
    if (!seen.has(hostId)) names.push(QUBE_REVIEW_SERVICE_NAME);
  }
  return names;
}

function reviewRequestNames(raw: RawReviewRequest[] | undefined): string[] { return (raw ?? []).map(request => request.login ?? request.slug ?? request.name ?? '').filter(name => name !== '').map(redact); }

function closingIssueNumbers(raw: RawPrView): number[] {
  const numbers = (raw.closingIssuesReferences ?? [])
    .map(issue => issue.number)
    .filter((issueNumber): issueNumber is number => typeof issueNumber === 'number' && Number.isInteger(issueNumber) && issueNumber > 0);
  return [...new Set(numbers)].sort((left, right) => left - right);
}

function stableRunId(input: GitHubLocalReviewPublishInput): string {
  const issueNumbers = [...new Set(input.issueNumbers)].sort((left, right) => left - right);
  const lanes = [...new Set(input.lanes)].sort();
  return createHash('sha256')
    .update(JSON.stringify({
      head: input.headSha,
      runner: input.runner,
      host: input.host,
      profile: input.profile,
      lanes,
      status: input.status,
      recommendation: input.recommendation,
      evidencePath: input.evidencePath,
      issueNumbers,
      summary: input.summary,
      findings: input.findings,
    }))
    .digest('hex')
    .slice(0, 16);
}

function localReviewMarker(metadata: LocalReviewMetadata): string {
  return `<!-- ${LOCAL_REVIEW_MARKER_PREFIX}:${JSON.stringify(metadata)} -->`;
}

function parseLocalReviewMetadata(body: string | undefined): LocalReviewMetadata | null {
  const match = (body ?? '').match(/<!--\s*qube-local-review:(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.head !== 'string' || parsed.head.trim() === '') return null;
    if (typeof parsed.runner !== 'string' || parsed.runner.trim() === '') return null;
    if (typeof parsed.host !== 'string' || parsed.host.trim() === '') return null;
    if (typeof parsed.profile !== 'string' || parsed.profile.trim() === '') return null;
    if (typeof parsed.runId !== 'string' || parsed.runId.trim() === '') return null;
    if (parsed.recommendation !== 'approve' && parsed.recommendation !== 'request-changes' && parsed.recommendation !== 'pending' && parsed.recommendation !== 'inconclusive') return null;
    if (typeof parsed.status !== 'string' || parsed.status.trim() === '') return null;
    if (!Array.isArray(parsed.issueNumbers) || !parsed.issueNumbers.every(issue => Number.isSafeInteger(issue) && issue > 0)) return null;
    const lanes = Array.isArray(parsed.lanes) ? parsed.lanes.filter((lane): lane is string => typeof lane === 'string' && lane.trim() !== '').map(redact) : [];
    return {
      version: 1,
      head: redact(parsed.head),
      runner: redact(parsed.runner),
      host: redact(parsed.host),
      profile: redact(parsed.profile),
      runId: redact(parsed.runId),
      evidence: typeof parsed.evidence === 'string' && parsed.evidence.trim() !== '' ? redact(parsed.evidence) : null,
      recommendation: parsed.recommendation,
      status: redact(parsed.status),
      issueNumbers: parsed.issueNumbers,
      lanes,
      inline: 'unsupported',
    };
  } catch {
    return null;
  }
}

function trustedLocalReviewComment(comment: RawComment, trustedAuthor: string | null): LocalReviewMetadata | null {
  if (trustedAuthor === null || !authorMatches(comment.author?.login ?? '', trustedAuthor)) return null;
  return parseLocalReviewMetadata(comment.body);
}

function laneReviewMarker(metadata: LaneReviewMetadata): string {
  return `<!-- ${LANE_REVIEW_MARKER_PREFIX}:${JSON.stringify(metadata)} -->`;
}

function parseLaneReviewMetadata(body: string | undefined): LaneReviewMetadata | null {
  const match = (body ?? '').match(/<!--\s*qube-pr-review:(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.head !== 'string' || parsed.head.trim() === '') return null;
    if (typeof parsed.lane !== 'string' || parsed.lane.trim() === '') return null;
    if (typeof parsed.profile !== 'string' || parsed.profile.trim() === '') return null;
    if (typeof parsed.runId !== 'string' || parsed.runId.trim() === '') return null;
    const issueNumber = parsed.issueNumber;
    const prNumber = parsed.prNumber;
    if (typeof issueNumber !== 'number' || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) return null;
    if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber <= 0) return null;
    if (typeof parsed.host !== 'string' || parsed.host.trim() === '') return null;
    if (parsed.recommendation !== 'approve' && parsed.recommendation !== 'request-changes' && parsed.recommendation !== 'pending' && parsed.recommendation !== 'inconclusive') return null;
    if (typeof parsed.status !== 'string' || parsed.status.trim() === '') return null;
    if (typeof parsed.summary !== 'string' || parsed.summary.trim() === '') return null;
    const inline = parsed.inline === 'review-api' || parsed.inline === 'unsupported' ? parsed.inline : 'issue-comment';
    return {
      version: 1,
      head: redact(parsed.head),
      lane: redact(parsed.lane),
      profile: redact(parsed.profile),
      runId: redact(parsed.runId),
      issueNumber,
      prNumber,
      host: redact(parsed.host),
      recommendation: parsed.recommendation,
      status: redact(parsed.status),
      summary: redact(parsed.summary),
      inline,
      reviewId: typeof parsed.reviewId === 'number' || typeof parsed.reviewId === 'string' ? redact(String(parsed.reviewId)) : null,
      inlineCommentCount: typeof parsed.inlineCommentCount === 'number' && Number.isSafeInteger(parsed.inlineCommentCount) && parsed.inlineCommentCount >= 0 ? parsed.inlineCommentCount : undefined,
      bodyFindingCount: typeof parsed.bodyFindingCount === 'number' && Number.isSafeInteger(parsed.bodyFindingCount) && parsed.bodyFindingCount >= 0 ? parsed.bodyFindingCount : undefined,
      findingDigest: typeof parsed.findingDigest === 'string' && parsed.findingDigest.trim() !== '' ? redact(parsed.findingDigest) : undefined,
    };
  } catch {
    return null;
  }
}

function trustedLaneReviewComment(comment: RawComment, trustedAuthor: string | null): LaneReviewMetadata | null {
  if (trustedAuthor === null || !authorMatches(comment.author?.login ?? '', trustedAuthor)) return null;
  return parseLaneReviewMetadata(comment.body);
}

function laneReviewComments(comments: RawComment[], trustedAuthor: string | null, headSha: string): LaneReviewComment[] {
  const latest = new Map<string, LaneReviewComment>();
  for (const comment of comments) {
    const metadata = trustedLaneReviewComment(comment, trustedAuthor);
    if (!metadata) continue;
    latest.set(`${metadata.head}\0${metadata.lane}`, { metadata, author: comment.author, body: comment.body ?? '', url: comment.url ? redact(comment.url) : null, stale: metadata.head !== headSha });
  }
  return [...latest.values()];
}

function laneReviewReviews(reviews: RawReview[], trustedAuthor: string | null, headSha: string): LaneReviewComment[] {
  const latest = new Map<string, LaneReviewComment>();
  if (trustedAuthor === null) return [];
  for (const review of reviews) {
    if (!authorMatches(review.author?.login ?? '', trustedAuthor)) continue;
    const metadata = parseLaneReviewMetadata(review.body);
    if (!metadata) continue;
    latest.set(`${metadata.head}\0${metadata.lane}`, { metadata, author: review.author, body: review.body ?? '', url: review.url ? redact(review.url) : null, stale: metadata.head !== headSha });
  }
  return [...latest.values()];
}

function laneReviewRecords(input: { comments: RawComment[]; latestReviews: RawReview[]; trustedMarkerAuthor: string | null; headSha: string }): LaneReviewComment[] {
  const latest = new Map<string, LaneReviewComment>();
  for (const comment of laneReviewComments(input.comments, input.trustedMarkerAuthor, input.headSha)) {
    latest.set(`${comment.metadata.head}\0${comment.metadata.lane}`, comment);
  }
  for (const review of laneReviewReviews(input.latestReviews, input.trustedMarkerAuthor, input.headSha)) {
    latest.set(`${review.metadata.head}\0${review.metadata.lane}`, review);
  }
  return [...latest.values()];
}

function laneReviewSummary(comment: LaneReviewComment): string {
  return `QUBE review (${comment.metadata.lane}): ${comment.metadata.recommendation} — ${summarize(comment.body)}`;
}

function stableLaneRunId(input: GitHubLaneReviewPublishInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      head: input.headSha,
      lane: input.lane,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
    }))
    .digest('hex')
    .slice(0, 16);
}

function normalizeLaneFindings(input: GitHubLaneReviewPublishInput): ReviewFinding[] {
  return input.findings.map((finding, index) => typeof finding === 'string'
    ? normalizeReviewFinding({ id: `legacy-${index + 1}`, severity: input.recommendation === 'request-changes' ? 'blocking' : 'advisory', message: finding })
    : normalizeReviewFinding(finding));
}

function findingDigest(findings: readonly ReviewFinding[]): string {
  return createHash('sha256')
    .update(JSON.stringify(findings.map(finding => ({
      id: finding.id,
      severity: finding.severity,
      location: finding.location ?? null,
      message: sanitizePublishedText(finding.message),
      suggestion: finding.suggestion ? sanitizePublishedText(finding.suggestion) : null,
    }))))
    .digest('hex')
    .slice(0, 16);
}

function laneReviewBody(input: GitHubLaneReviewPublishInput, bodyFindingsInput?: readonly ReviewFinding[], inlineCount = 0): { body: string; marker: string; runId: string; bodyFindingCount: number; inlineCommentCount: number } {
  const runId = stableLaneRunId(input);
  const summary = sanitizePublishedText(input.summary);
  const allFindings = normalizeLaneFindings(input);
  const digest = findingDigest(allFindings);
  const bodyFindings = bodyFindingsInput ?? allFindings;
  const metadata: LaneReviewMetadata = {
    version: 1,
    head: input.headSha,
    lane: input.lane,
    profile: input.profile,
    runId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    host: input.host,
    recommendation: input.recommendation,
    status: input.status,
    summary,
    inline: 'review-api',
    inlineCommentCount: inlineCount,
    bodyFindingCount: bodyFindings.length,
    findingDigest: digest,
  };
  const marker = laneReviewMarker(metadata);
  const findings = bodyFindings.length === 0 ? ['- None recorded in the review body.'] : bodyFindings.map(item => `- ${findingBodyText(item, input.evidencePath)}`);
  const body = [
    marker,
    '',
    `QUBE review (${input.lane}): ${input.recommendation}`,
    '',
    'Summary:',
    summary,
    '',
    'Findings:',
    ...findings,
    inlineCount > 0 ? `- ${inlineCount} finding(s) were published as inline review comments on the PR diff.` : '- Inline findings: none.',
    '',
    'Metadata:',
    `- lane: ${redact(input.lane)}`,
    `- host: ${redact(input.host)}`,
    `- profile: ${redact(input.profile)}`,
    `- issue: #${input.issueNumber}`,
    `- run id: ${runId}`,
    `- finding digest: ${digest}`,
    `- publish kind: pull-request-review`,
    `- inline comments: ${inlineCount}`,
    input.evidencePath ? `- evidence: ${redact(input.evidencePath)}` : '- evidence: optional local audit only',
  ].join('\n');
  return { body, marker, runId, bodyFindingCount: bodyFindings.length, inlineCommentCount: inlineCount };
}

function matchingCurrentLaneReview(item: ReviewItem, input: GitHubLaneReviewPublishInput, runId: string): boolean {
  const value = item.trustedMetadata.trustedLaneReviews;
  if (!Array.isArray(value)) return false;
  const expectedFindingDigest = findingDigest(normalizeLaneFindings(input));
  return value.some(review => {
    if (!isRecord(review)) return false;
    if (review.stale === true) return false;
    if (review.inline !== 'review-api') return false;
    return review.head === input.headSha
      && review.lane === input.lane
      && review.runId === runId
      && review.recommendation === input.recommendation
      && review.status === input.status
      && review.summary === sanitizePublishedText(input.summary)
      && review.findingDigest === expectedFindingDigest;
  });
}

function laneReviewMetadata(comments: RawComment[], latestReviews: RawReview[], trustedMarkerAuthor: string | null, headSha: string): JsonObject[] {
  return laneReviewRecords({ comments, latestReviews, trustedMarkerAuthor, headSha }).map(comment => {
    const metadata = comment.metadata;
    return {
      head: metadata.head,
      lane: metadata.lane,
      profile: metadata.profile,
      runId: metadata.runId,
      issueNumber: metadata.issueNumber,
      prNumber: metadata.prNumber,
      host: metadata.host,
      recommendation: metadata.recommendation,
      status: metadata.status,
      summary: metadata.summary,
      inline: metadata.inline,
      reviewId: metadata.reviewId ?? null,
      inlineCommentCount: metadata.inlineCommentCount ?? 0,
      bodyFindingCount: metadata.bodyFindingCount ?? null,
      findingDigest: metadata.findingDigest ?? null,
      stale: metadata.head !== headSha,
      author: comment.author?.login ?? null,
      url: comment.url ? redact(comment.url) : null,
    };
  });
}

function laneMarkerReviews(rawPr: RawPrView): RawReview[] {
  return rawPr.reviews && rawPr.reviews.length > 0 ? rawPr.reviews : rawPr.latestReviews ?? [];
}

function localReviewComments(comments: RawComment[], trustedAuthor: string | null, headSha: string): LocalReviewComment[] {
  return comments.flatMap(comment => {
    const metadata = trustedLocalReviewComment(comment, trustedAuthor);
    if (!metadata) return [];
    return [{ metadata, author: comment.author, body: comment.body ?? '', url: comment.url ? redact(comment.url) : null, stale: metadata.head !== headSha }];
  });
}

function localReviewState(recommendation: GitHubLocalReviewRecommendation): string {
  if (recommendation === 'approve') return 'APPROVED';
  if (recommendation === 'request-changes') return 'CHANGES_REQUESTED';
  return 'PENDING';
}

function localReviewSummary(comment: LocalReviewComment): string {
  const summary = summarize(comment.body);
  return `QUBE local review ${comment.metadata.recommendation} for ${comment.metadata.profile}: ${summary}`;
}

function sanitizePublishedText(value: string): string {
  return redact(value)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'"`]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?token)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;&)]+)/gi, '$1$2[REDACTED]')
    .replace(/\\\\[A-Za-z0-9._$-]+\\[^\r\n)<>]+/g, '[local-path]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n)<>]+/g, '[local-path]')
    .replace(/(^|[\s(:`"'])\/(?:Users|home|tmp|var|private|mnt|Volumes|workspace|workspaces|code)\/[^\r\n)<>]+/g, '$1[local-path]');
}

const MAX_PUBLISHED_FINDING_LENGTH = 12000;

function truncatePublishedFinding(value: string, evidencePath: string | null): string {
  const text = sanitizePublishedText(value);
  if (text.length <= MAX_PUBLISHED_FINDING_LENGTH) return text;
  const detail = evidencePath ? `source retained at ${redact(evidencePath)}` : 'source retained in local evidence JSON';
  const suffix = ` [truncated because this single finding exceeded ${MAX_PUBLISHED_FINDING_LENGTH} characters; ${detail}]`;
  const limit = Math.max(0, MAX_PUBLISHED_FINDING_LENGTH - suffix.length);
  return `${text.slice(0, limit).trimEnd()}${suffix}`;
}

function findingBodyText(finding: ReviewFinding, evidencePath: string | null): string {
  const location = finding.location
    ? ` (${redact(finding.location.path)}${finding.location.line ? `:${finding.location.line}` : ''})`
    : '';
  const suggestion = finding.suggestion ? ` Suggestion: ${finding.suggestion}` : '';
  return truncatePublishedFinding(`${finding.severity}${location}: ${finding.message}${suggestion}`, evidencePath);
}

function localReviewBody(input: GitHubLocalReviewPublishInput): { body: string; marker: string; runId: string } {
  const runId = stableRunId(input);
  const issueNumbers = [...new Set(input.issueNumbers)].sort((left, right) => left - right);
  const lanes = [...new Set(input.lanes)].sort();
  const metadata: LocalReviewMetadata = {
    version: 1,
    head: input.headSha,
    runner: input.runner,
    host: input.host,
    profile: input.profile,
    runId,
    evidence: input.evidencePath,
    recommendation: input.recommendation,
    status: input.status,
    issueNumbers,
    lanes,
    inline: 'unsupported',
  };
  const marker = localReviewMarker(metadata);
  const findings = input.findings.length === 0 ? ['- None recorded.'] : input.findings.map(item => `- ${truncatePublishedFinding(item, input.evidencePath)}`);
  const issues = issueNumbers.length === 0 ? ['- No linked issue metadata was available.'] : issueNumbers.map(issue => `- issue #${issue}`);
  const body = [
    marker,
    '',
    `QUBE local review: ${input.recommendation}`,
    '',
    'Summary:',
    sanitizePublishedText(input.summary),
    '',
    'Findings:',
    ...findings,
    '',
    'Evidence reviewed:',
    ...issues,
    `- PR diff head ${redact(input.headSha)}`,
    input.evidencePath ? `- local evidence ${redact(input.evidencePath)}` : '- local evidence not recorded',
    '',
    'Metadata:',
    `- runner: ${redact(input.runner)}`,
    `- host: ${redact(input.host)}`,
    `- profile: ${redact(input.profile)}`,
    `- lanes: ${lanes.length === 0 ? 'none' : lanes.map(redact).join(', ')}`,
    `- run id: ${runId}`,
    '- inline comments: unsupported by this provider publisher; summary comment used',
  ].join('\n');
  return { body, marker, runId };
}

function publishedCommentUrl(result: GhRunResult): string | null {
  const match = `${result.stdout}\n${result.stderr}`.match(/https:\/\/[^\s<>"')]+/);
  return match ? redact(match[0]) : null;
}

function isCreatedPullReview(value: unknown): value is RawCreatedPullReview {
  return isRecord(value);
}

function publishedReviewUrl(result: GhRunResult): string | null {
  try {
    const parsed = parseGhJson<RawCreatedPullReview>(result.stdout, 'gh api create pull request review', isCreatedPullReview);
    const url = parsed.html_url ?? parsed.url ?? null;
    return typeof url === 'string' && url.trim() !== '' ? redact(url) : null;
  } catch {
    return publishedCommentUrl(result);
  }
}

function reviewEvent(recommendation: GitHubLocalReviewRecommendation): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' {
  if (recommendation === 'approve') return 'APPROVE';
  if (recommendation === 'request-changes') return 'REQUEST_CHANGES';
  return 'COMMENT';
}

function reviewPayloadPath(payload: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'qube-gh-review-'));
  const path = join(directory, 'payload.json');
  writeFileSync(path, `${JSON.stringify(payload)}\n`);
  return path;
}

function cleanupReviewPayload(path: string): void {
  try {
    rmSync(dirname(path), { recursive: true, force: true });
  } catch {
    // Best-effort cleanup only; publishing result is authoritative.
  }
}

interface ParsedDiffIndex {
  hasLine(path: string, line: number, side?: ReviewFindingSide): boolean;
}

function normalizeDiffPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^a\//, '').replace(/^b\//, '');
}

function parseUnifiedDiffIndex(diff: string): ParsedDiffIndex {
  const destinationLinesByPath = new Map<string, Set<number>>();
  const sourceLinesByPath = new Map<string, Set<number>>();
  let currentPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      currentPath = rawPath === '/dev/null' ? null : normalizeDiffPath(rawPath);
      if (currentPath && !destinationLinesByPath.has(currentPath)) destinationLinesByPath.set(currentPath, new Set());
      if (currentPath && !sourceLinesByPath.has(currentPath)) sourceLinesByPath.set(currentPath, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      continue;
    }
    if (!currentPath || newLine <= 0 || line.startsWith('diff --git') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) {
      destinationLinesByPath.get(currentPath)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      sourceLinesByPath.get(currentPath)?.add(oldLine);
      oldLine += 1;
    } else {
      destinationLinesByPath.get(currentPath)?.add(newLine);
      sourceLinesByPath.get(currentPath)?.add(oldLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return {
    hasLine(path: string, line: number, side: ReviewFindingSide = 'destination'): boolean {
      const linesByPath = side === 'source' ? sourceLinesByPath : destinationLinesByPath;
      return linesByPath.get(normalizeDiffPath(path))?.has(line) ?? false;
    },
  };
}

function inlineReviewComment(finding: ReviewFinding, evidencePath: string | null): JsonObject | null {
  const location = finding.location;
  if (!location || typeof location.line !== 'number') return null;
  const body = findingBodyText(finding, evidencePath);
  const side = location.side === 'source' ? 'LEFT' : 'RIGHT';
  const comment: Record<string, JsonValue> = {
    path: normalizeDiffPath(location.path),
    line: location.endLine ?? location.line,
    side,
    body,
  };
  if (location.endLine && location.endLine !== location.line) {
    comment.start_line = location.line;
    comment.start_side = side;
  }
  return comment;
}

function hasInlineFindingCandidates(findings: readonly ReviewFinding[]): boolean {
  return findings.some(finding => finding.location && typeof finding.location.line === 'number');
}

function localReviewPublishResult(input: Partial<GitHubLocalReviewPublishResult> & { status: GitHubLocalReviewPublishStatus; nextAction: string }): GitHubLocalReviewPublishResult {
  return {
    runId: input.runId ?? null,
    marker: input.marker ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
    ...(input.publishKind ? { publishKind: input.publishKind } : {}),
    ...(typeof input.inlineCommentCount === 'number' ? { inlineCommentCount: input.inlineCommentCount } : {}),
    ...(typeof input.bodyFindingCount === 'number' ? { bodyFindingCount: input.bodyFindingCount } : {}),
    ...(input.reviewUrl !== undefined ? { reviewUrl: input.reviewUrl } : {}),
    ...(input.inlineCommentUrls ? { inlineCommentUrls: input.inlineCommentUrls } : {}),
    failure: input.failure ?? null,
    status: input.status,
    nextAction: input.nextAction,
  };
}

function rawReviewDecision(value: string | null | undefined): string { return value && value.trim() !== '' ? value : 'UNKNOWN'; }

function mapReviewDecision(value: string | null | undefined): ReviewItem['reviewDecision'] { if (value === null || value === undefined || value === '') return 'none'; if (value === 'APPROVED') return 'approved'; if (value === 'CHANGES_REQUESTED') return 'changes-requested'; if (value === 'REVIEW_REQUIRED') return 'review-required'; return 'unknown'; }

function mapReviewState(raw: RawPrView): ReviewItem['state'] { if (raw.isDraft) return 'draft'; if (raw.state === 'OPEN') return 'open'; if (raw.state === 'MERGED') return 'merged'; if (raw.state === 'CLOSED') return 'closed'; return 'unknown'; }

function mapMergeability(raw: RawPrView): ReviewItem['mergeability'] {
  if (raw.mergeable === 'CONFLICTING' || raw.mergeStateStatus === 'DIRTY') return 'conflicting';
  if (raw.mergeStateStatus && ['BLOCKED', 'BEHIND', 'DRAFT', 'HAS_HOOKS', 'UNSTABLE'].includes(raw.mergeStateStatus)) return 'blocked';
  if (raw.mergeable === 'MERGEABLE' && raw.mergeStateStatus === 'CLEAN') return 'mergeable';
  return 'unknown';
}

function normalizePr(raw: RawPrView): GitHubReviewPullRequest {
  return {
    number: raw.number,
    title: redact(raw.title),
    state: raw.state,
    url: redact(raw.url),
    headRefOid: redact(raw.headRefOid ?? 'UNKNOWN'),
    reviewDecision: rawReviewDecision(raw.reviewDecision),
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    mergeable: raw.mergeable ?? 'UNKNOWN',
    isDraft: raw.isDraft ?? false,
  };
}

function checkResult(check: RawStatusCheck): GateResult {
  const conclusion = (check.conclusion ?? '').toUpperCase();
  const status = (check.status ?? '').toUpperCase();
  const state = (check.state ?? '').toUpperCase();
  if (conclusion === 'SUCCESS') return 'passed';
  if (conclusion === 'NEUTRAL') return 'passed';
  if (conclusion === 'SKIPPED') return 'skipped';
  if (conclusion === 'STALE') return 'stale';
  if (['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED'].includes(conclusion)) return 'failed';
  if (state === 'SUCCESS') return 'passed';
  if (state === 'FAILURE' || state === 'ERROR') return 'failed';
  if (state === 'PENDING') return 'unknown';
  if (status === 'COMPLETED' && conclusion === '') return 'unknown';
  return 'unknown';
}

function checkReasonCode(result: GateResult): GateEvidenceReasonCode {
  if (result === 'stale') return 'provider-check-stale';
  if (result === 'skipped') return 'provider-check-skipped';
  if (result === 'unknown') return 'provider-check-pending';
  return 'trusted-provider-result';
}

function checkName(check: RawStatusCheck, index: number): string {
  return check.name ?? check.context ?? `GitHub check ${index + 1}`;
}

function checkTime(check: RawStatusCheck): string {
  return check.completedAt ?? check.startedAt ?? check.createdAt ?? '';
}

function latestChecks(raw: RawStatusCheck[] | undefined): RawStatusCheck[] {
  const byName = new Map<string, RawStatusCheck>();
  for (const [index, check] of (raw ?? []).entries()) {
    const name = checkName(check, index);
    const current = byName.get(name);
    if (!current || checkTime(check) >= checkTime(current)) byName.set(name, check);
  }
  return [...byName.values()];
}

function normalizeCheckName(value: string): string {
  return value.trim().toLowerCase();
}

function runIdFromUrl(url: string | undefined): string | null {
  const match = (url ?? '').match(/\/actions\/runs\/(\d+)/);
  return match ? match[1] : null;
}

function checkRunId(run: RawCheckRun | RawWorkflowRun): string | null {
  return typeof run.id === 'number' ? String(run.id) : null;
}

function explicitCheckName(check: RawStatusCheck): string | null {
  const name = check.name ?? check.context ?? null;
  return typeof name === 'string' && name.trim() !== '' ? name : null;
}

function uniqueStrings(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))];
}

function checkMatchesRun(check: RawStatusCheck, run: RawCheckRun): boolean {
  const name = explicitCheckName(check);
  return name !== null && normalizeCheckName(run.name ?? '') === normalizeCheckName(name);
}

function checkMatchesWorkflowRun(check: RawStatusCheck, run: RawWorkflowRun): boolean {
  const detailRunId = runIdFromUrl(check.detailsUrl ?? check.targetUrl);
  const runId = checkRunId(run);
  if (detailRunId !== null && runId === detailRunId) return true;
  if (check.workflowName && normalizeCheckName(run.name ?? '') === normalizeCheckName(check.workflowName)) return true;
  const name = explicitCheckName(check);
  return name !== null && normalizeCheckName(run.name ?? '') === normalizeCheckName(name);
}

function diagnosticSummary(status: GitHubCiDiagnosticStatus, checkNameValue: string, currentHeadRunIds: string[], staleRunIds: string[]): string {
  if (status === 'missing-current-head-run') return `${checkNameValue} has no check run or workflow run for the current PR head.`;
  if (status === 'stale-old-head-run') return `${checkNameValue} points at old-head workflow run(s): ${staleRunIds.join(', ')}.`;
  if (status === 'failed-current-head-run') return `${checkNameValue} failed on current-head run(s): ${currentHeadRunIds.join(', ') || 'unknown'}.`;
  if (status === 'skipped-current-head-run') return `${checkNameValue} was skipped on the current PR head.`;
  if (status === 'pending-current-head-run') return `${checkNameValue} has a current-head run that is still pending.`;
  if (status === 'mapped') return `${checkNameValue} maps to current-head CI evidence.`;
  return `${checkNameValue} CI mapping is unknown.`;
}

function diagnosticNextAction(status: GitHubCiDiagnosticStatus, workflowDispatchSupported: boolean | null): string {
  if (status === 'missing-current-head-run') {
    if (workflowDispatchSupported === true) return 'Trigger a workflow_dispatch run for the current PR branch or push a new commit, then rerun `aie pr view <pr> --json`.';
    if (workflowDispatchSupported === false) return 'Push a new commit to the PR branch to trigger GitHub Actions for the current head; do not rerun old-head workflow runs as current evidence.';
    return 'Trigger CI for the current PR head, then rerun `aie pr view <pr> --json`; do not treat old-head runs as current evidence.';
  }
  if (status === 'stale-old-head-run') return 'Do not rerun the stale old-head workflow run as merge evidence; trigger CI for the current head by pushing a new commit or using workflow_dispatch when available.';
  if (status === 'failed-current-head-run') return 'Rerun failed jobs for the current-head workflow run or push a fix commit, then rerun `aie pr view <pr> --json`.';
  if (status === 'skipped-current-head-run') return 'Inspect the workflow skip condition and confirm the check is not required for this PR before merge.';
  if (status === 'pending-current-head-run') return 'Wait for the current-head CI run to finish, then rerun `aie pr view <pr> --json`.';
  if (status === 'mapped') return 'No CI retrigger needed for this check.';
  return 'Inspect GitHub check details and rerun `aie pr view <pr> --json` after the state changes.';
}

function diagnosticReasonCode(status: GitHubCiDiagnosticStatus, mappedToCurrentHeadWorkflowRun: boolean): GitHubCiDiagnosticReasonCode {
  if (status === 'missing-current-head-run') return 'missing-current-head-ci-run';
  if (status === 'stale-old-head-run') return 'stale-old-head-ci-run';
  if (status === 'failed-current-head-run') return 'current-head-check-run-failed';
  if (status === 'skipped-current-head-run') return 'current-head-check-run-skipped';
  if (status === 'pending-current-head-run') return 'current-head-check-run-pending';
  if (status === 'unknown') return 'ci-mapping-unknown';
  return mappedToCurrentHeadWorkflowRun ? 'current-head-workflow-run-found' : 'current-head-check-run-found';
}

function ciDiagnosticMetadata(diagnostic: GitHubCiDiagnostic): JsonObject {
  return {
    checkName: diagnostic.checkName,
    status: diagnostic.status,
    reasonCode: diagnostic.reasonCode,
    currentHeadSha: diagnostic.currentHeadSha,
    mappedToCurrentHeadCheckRun: diagnostic.mappedToCurrentHeadCheckRun,
    mappedToCurrentHeadWorkflowRun: diagnostic.mappedToCurrentHeadWorkflowRun,
    currentHeadSuiteIds: diagnostic.currentHeadSuiteIds,
    currentHeadRunIds: diagnostic.currentHeadRunIds,
    staleRunIds: diagnostic.staleRunIds,
    workflowDispatchSupported: diagnostic.workflowDispatchSupported,
    summary: diagnostic.summary,
    nextAction: diagnostic.nextAction,
  };
}

function buildCiDiagnostics(input: { checks: RawStatusCheck[]; headSha: string; checkRuns: RawCheckRun[]; checkSuites: RawCheckSuite[]; workflowRuns: RawWorkflowRun[]; staleRuns: RawWorkflowRun[]; workflowDispatchSupported: boolean | null }): GitHubCiDiagnostic[] {
  const currentHeadSuiteIds = uniqueStrings(input.checkSuites.filter(suite => !suite.head_sha || suite.head_sha === input.headSha).map(suite => typeof suite.id === 'number' ? String(suite.id) : null));
  return input.checks.map((check, index) => {
    const name = checkName(check, index);
    const result = checkResult(check);
    const currentCheckRuns = input.checkRuns.filter(run => checkMatchesRun(check, run));
    const currentWorkflowRuns = input.workflowRuns.filter(run => checkMatchesWorkflowRun(check, run));
    const detailRunId = runIdFromUrl(check.detailsUrl ?? check.targetUrl);
    const staleRuns = input.staleRuns.filter(run => {
      const runId = checkRunId(run);
      return run.head_sha !== input.headSha && (runId === detailRunId || checkMatchesWorkflowRun(check, run));
    });
    const mappedToCurrentHeadCheckRun = currentCheckRuns.length > 0;
    const mappedToCurrentHeadWorkflowRun = currentWorkflowRuns.length > 0;
    const mapped = mappedToCurrentHeadCheckRun || mappedToCurrentHeadWorkflowRun;
    let status: GitHubCiDiagnosticStatus = 'mapped';
    if (result === 'failed' && mapped) status = 'failed-current-head-run';
    else if (result === 'skipped' && mapped) status = 'skipped-current-head-run';
    else if (result === 'unknown' && mapped) status = 'pending-current-head-run';
    else if (!mapped && staleRuns.length > 0) status = 'stale-old-head-run';
    else if (!mapped && result === 'unknown') status = 'missing-current-head-run';
    else if (!mapped) status = 'unknown';
    const currentHeadRunIds = uniqueStrings([...currentCheckRuns.map(checkRunId), ...currentWorkflowRuns.map(checkRunId)]);
    const staleRunIds = uniqueStrings(staleRuns.map(checkRunId));
    return {
      checkName: redact(name),
      status,
      reasonCode: diagnosticReasonCode(status, mappedToCurrentHeadWorkflowRun),
      currentHeadSha: input.headSha,
      mappedToCurrentHeadCheckRun,
      mappedToCurrentHeadWorkflowRun,
      currentHeadSuiteIds,
      currentHeadRunIds,
      staleRunIds,
      workflowDispatchSupported: input.workflowDispatchSupported,
      summary: diagnosticSummary(status, redact(name), currentHeadRunIds, staleRunIds),
      nextAction: diagnosticNextAction(status, input.workflowDispatchSupported),
    };
  });
}

function checks(raw: RawStatusCheck[] | undefined, ciDiagnostics: GitHubCiDiagnostic[] = []): GateEvidence[] {
  const diagnosticsByName = new Map(ciDiagnostics.map(diagnostic => [diagnostic.checkName, diagnostic]));
  return latestChecks(raw).map((check, index) => {
    const result = checkResult(check);
    const name = checkName(check, index);
    const diagnostic = diagnosticsByName.get(redact(name));
    return normalizeGateEvidence({
      key: `github-check:${name}`,
      name: redact(name),
      stage: 'pre-merge',
      result,
      source: 'provider-check',
      trust: 'trusted-provider',
      command: null,
      providerRunId: null,
      path: check.detailsUrl ? redact(check.detailsUrl) : check.targetUrl ? redact(check.targetUrl) : null,
      summary: `GitHub check status=${check.status ?? check.state ?? 'UNKNOWN'} conclusion=${check.conclusion ?? 'UNKNOWN'}.`,
      recordedAt: check.completedAt ?? check.startedAt ?? check.createdAt ?? null,
      reasonCode: checkReasonCode(result),
      stale: result === 'stale',
      metadata: { status: check.status ?? null, state: check.state ?? null, conclusion: check.conclusion ?? null, workflowName: check.workflowName ?? null, ciDiagnostic: diagnostic ? ciDiagnosticMetadata(diagnostic) : null },
    });
  });
}

function isStaleChangeRequest(review: RawReview, headRefOid: string, unresolvedThreads: RawThreadNode[]): boolean {
  return review.state === 'CHANGES_REQUESTED' && !!review.commit?.oid && review.commit.oid !== headRefOid && unresolvedThreads.length === 0;
}

function threadComments(thread: RawThreadNode) {
  return thread.comments?.nodes ?? [];
}

function latestThreadComment(thread: RawThreadNode) {
  return threadComments(thread).at(-1) ?? null;
}

function feedback(raw: { comments: RawComment[]; latestReviews: RawReview[]; reviewComments: RawReviewComment[]; unresolvedThreads: RawThreadNode[]; trustedMarkerAuthor: string | null; headRefOid: string }): ReviewFeedback[] {
  const items: ReviewFeedback[] = [];
  for (const localReview of localReviewComments(raw.comments, raw.trustedMarkerAuthor, raw.headRefOid)) {
    if (localReview.stale) continue;
    items.push({
      source: 'comment',
      author: actorName(localReview.author),
      state: localReviewState(localReview.metadata.recommendation),
      summary: localReviewSummary(localReview),
      url: localReview.url,
      trust: 'untrusted',
    });
  }
  for (const laneReview of laneReviewRecords({ comments: raw.comments, latestReviews: raw.latestReviews, trustedMarkerAuthor: raw.trustedMarkerAuthor, headSha: raw.headRefOid })) {
    if (laneReview.stale) continue;
    items.push({
      source: laneReview.metadata.inline === 'review-api' ? 'review' : 'comment',
      author: actorName(laneReview.author),
      state: localReviewState(laneReview.metadata.recommendation),
      summary: laneReviewSummary(laneReview),
      url: laneReview.url,
      trust: 'untrusted',
    });
  }
  for (const review of raw.latestReviews) {
    const state = review.state ?? 'UNKNOWN';
    if (raw.trustedMarkerAuthor !== null && authorMatches(review.author?.login ?? '', raw.trustedMarkerAuthor) && parseLaneReviewMetadata(review.body)) continue;
    if (isStaleChangeRequest(review, raw.headRefOid, raw.unresolvedThreads)) continue;
    if (raw.unresolvedThreads.length === 0 && isResolvedProviderReviewSummary(review.body)) continue;
    if (state === 'CHANGES_REQUESTED' || (state === 'COMMENTED' && !isNonActionableSummary(review.body, review.author?.login))) items.push({ source: 'review', author: actorName(review.author), state, summary: summarize(review.body), url: review.url ? redact(review.url) : null, trust: 'untrusted' });
  }
  for (const comment of raw.comments) {
    const body = comment.body ?? '';
    if (trustedLocalReviewComment(comment, raw.trustedMarkerAuthor)) continue;
    if (trustedLaneReviewComment(comment, raw.trustedMarkerAuthor)) continue;
    if ((!trustedMarkerComment(comment, raw.trustedMarkerAuthor) || !body.includes(`<!-- ${MARKER_PREFIX}:`)) && !isNonActionableSummary(body, comment.author?.login)) items.push({ source: 'comment', author: actorName(comment.author), summary: summarize(comment.body), url: comment.url ? redact(comment.url) : null, state: null, trust: 'untrusted' });
  }
  for (const thread of raw.unresolvedThreads) {
    const latest = latestThreadComment(thread);
    items.push({ source: 'thread', author: actorName(latest?.author), summary: summarize(latest?.body), url: latest?.url ? redact(latest.url) : null, state: null, trust: 'untrusted' });
  }
  return items;
}

function threadPath(thread: RawThreadNode): string | null {
  return threadComments(thread).map(comment => comment.path).find((path): path is string => typeof path === 'string' && path.trim() !== '') ?? null;
}

function threadLine(thread: RawThreadNode, key: 'line' | 'originalLine'): number | null {
  return threadComments(thread).map(comment => comment[key]).find((line): line is number => typeof line === 'number' && Number.isSafeInteger(line) && line > 0) ?? null;
}

function reviewConversations(threads: RawThreadNode[]): ReviewConversation[] {
  return threads.map(thread => {
    const latest = latestThreadComment(thread);
    return {
      providerId: 'github',
      id: thread.id ?? 'unknown-thread',
      resolved: thread.isResolved === true,
      outdated: thread.isOutdated === true || threadComments(thread).some(comment => comment.outdated === true),
      viewerCanResolve: thread.viewerCanResolve === true,
      path: threadPath(thread),
      line: threadLine(thread, 'line'),
      originalLine: threadLine(thread, 'originalLine'),
      author: actorName(latest?.author),
      summary: summarize(latest?.body),
      url: latest?.url ? redact(latest.url) : null,
    };
  });
}

function mergeBlockers(raw: { pr: GitHubReviewPullRequest; unresolvedThreads: RawThreadNode[]; checks: GateEvidence[] }): ReviewMergeBlock[] {
  const blockers: ReviewMergeBlock[] = [];
  if (raw.unresolvedThreads.length > 0) {
    blockers.push({
      reason: 'unresolved-review-thread',
      summary: `GitHub merge is blocked by ${raw.unresolvedThreads.length} unresolved code conversation${raw.unresolvedThreads.length === 1 ? '' : 's'}.`,
      url: raw.pr.url,
    });
  }
  if (raw.pr.isDraft) blockers.push({ reason: 'draft', summary: 'GitHub merge is blocked while the pull request is a draft.', url: raw.pr.url });
  if (raw.pr.reviewDecision === 'REVIEW_REQUIRED') blockers.push({ reason: 'review-required', summary: 'GitHub reports a required review is still missing.', url: raw.pr.url });
  if (raw.pr.reviewDecision === 'CHANGES_REQUESTED') blockers.push({ reason: 'changes-requested', summary: 'GitHub reports requested changes on the pull request.', url: raw.pr.url });
  if (raw.checks.some(check => check.result === 'unknown')) blockers.push({ reason: 'checks-pending', summary: 'One or more GitHub checks are still pending or unknown.', url: raw.pr.url });
  if (raw.checks.some(check => check.result === 'failed')) blockers.push({ reason: 'checks-failed', summary: 'One or more GitHub checks failed.', url: raw.pr.url });
  if (raw.pr.mergeable === 'CONFLICTING') blockers.push({ reason: 'conflict', summary: 'GitHub reports merge conflicts.', url: raw.pr.url });
  if (raw.pr.mergeStateStatus === 'BLOCKED' && blockers.length === 0) blockers.push({ reason: 'merge-state-blocked', summary: 'GitHub reports mergeStateStatus=BLOCKED; inspect provider details for repository rules.', url: raw.pr.url });
  return blockers;
}

function metadata(raw: { pr: GitHubReviewPullRequest; reviewRequests: string[]; comments: RawComment[]; latestReviews: RawReview[]; laneReviews: RawReview[]; unresolvedThreads: RawThreadNode[]; unavailable: string[]; trustedMarkerAuthor: string | null; checks: GateEvidence[] }): JsonObject {
  const localReviews = raw.comments.flatMap(comment => {
    const metadata = parseLocalReviewMetadata(comment.body);
    if (!metadata) return [];
    return [{
      metadata,
      author: comment.author,
      body: comment.body ?? '',
      url: comment.url ? redact(comment.url) : null,
      stale: metadata.head !== raw.pr.headRefOid,
    }];
  }).map(comment => ({
    head: comment.metadata.head,
    runner: comment.metadata.runner,
    host: comment.metadata.host,
    profile: comment.metadata.profile,
    runId: comment.metadata.runId,
    evidence: comment.metadata.evidence,
    recommendation: comment.metadata.recommendation,
    status: comment.metadata.status,
    issueNumbers: comment.metadata.issueNumbers,
    lanes: comment.metadata.lanes,
    inline: comment.metadata.inline,
    stale: comment.stale,
    author: comment.author?.login ?? null,
    url: comment.url,
  }));
  const trustedLocalReviews = raw.comments.flatMap(comment => {
    const metadata = trustedLocalReviewComment(comment, raw.trustedMarkerAuthor);
    if (!metadata) return [];
    return [{
      head: metadata.head,
      runner: metadata.runner,
      host: metadata.host,
      profile: metadata.profile,
      runId: metadata.runId,
      evidence: metadata.evidence,
      recommendation: metadata.recommendation,
      status: metadata.status,
      issueNumbers: metadata.issueNumbers,
      lanes: metadata.lanes,
      inline: metadata.inline,
      stale: metadata.head !== raw.pr.headRefOid,
      author: comment.author?.login ?? null,
      url: comment.url ? redact(comment.url) : null,
    }];
  });
  const trustedLaneReviews = laneReviewMetadata(raw.comments, raw.laneReviews, raw.trustedMarkerAuthor, raw.pr.headRefOid);
  const conversations = reviewConversations(raw.unresolvedThreads);
  const blockers = mergeBlockers({ pr: raw.pr, unresolvedThreads: raw.unresolvedThreads, checks: raw.checks });
  return {
    number: raw.pr.number,
    headRefOid: raw.pr.headRefOid,
    mergeStateStatus: raw.pr.mergeStateStatus,
    rawReviewDecision: raw.pr.reviewDecision,
    rawMergeable: raw.pr.mergeable,
    mergeBlockers: blockers.map(blocker => ({ reason: blocker.reason, summary: blocker.summary, url: blocker.url })),
    reviewThreads: conversations.map(thread => ({
      providerId: thread.providerId,
      id: thread.id,
      resolved: thread.resolved,
      outdated: thread.outdated,
      viewerCanResolve: thread.viewerCanResolve,
      path: thread.path,
      line: thread.line,
      originalLine: thread.originalLine,
      author: thread.author,
      summary: thread.summary,
      url: thread.url,
    })),
    reviewRequests: raw.reviewRequests,
    comments: raw.comments.map(comment => ({ author: comment.author?.login ?? null, body: comment.body ?? null })),
    latestReviews: raw.latestReviews.map(review => ({ author: review.author?.login ?? null, commitOid: review.commit?.oid ?? null })),
    localReviews,
    trustedLocalReviews,
    trustedLaneReviews,
    unavailable: raw.unavailable,
    trustedMarkerAuthor: raw.trustedMarkerAuthor,
  };
}

function getJsonString(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function getJsonStrings(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function commentsFromMetadata(item: ReviewItem): RawComment[] {
  const value = item.trustedMetadata.comments;
  if (!Array.isArray(value)) return [];
  return value.map(comment => isRecord(comment) && typeof comment.body === 'string' ? { author: typeof comment.author === 'string' ? { login: comment.author } : null, body: comment.body } : { body: '' });
}

function latestReviewsFromMetadata(item: ReviewItem): RawReview[] {
  const value = item.trustedMetadata.latestReviews;
  if (!Array.isArray(value)) return [];
  return value.map(review => {
    if (!isRecord(review)) return {};
    const author = typeof review.author === 'string' ? { login: review.author } : null;
    const oid = typeof review.commitOid === 'string' ? review.commitOid : undefined;
    return { author, commit: oid ? { oid } : null };
  });
}

function currentLocalReviewRunIds(item: ReviewItem, headSha: string): Set<string> {
  const value = item.trustedMetadata.trustedLocalReviews;
  if (!Array.isArray(value)) return new Set();
  const runIds = value.flatMap(review => {
    if (!isRecord(review)) return [];
    if (review.stale === true) return [];
    if (review.head !== headSha) return [];
    return typeof review.runId === 'string' && review.runId.trim() !== '' ? [review.runId] : [];
  });
  return new Set(runIds);
}

function actionResult(action: Action, status: ActionResult['status'], failure: ActionResult['failure'] = null): ActionResult {
  return { actionId: action.id, status, failure, details: action.details };
}

function getString(details: Record<string, unknown>, key: string): string | null {
  const value = details[key];
  return typeof value === 'string' ? value : null;
}

function redactReviewKeyId(id: string): string {
  return redact(id).replace(/\b([A-Za-z0-9_-]{20,})\b/g, '[REDACTED]');
}

function makeRequestAction(input: { item: ReviewItem; name: string; requestedForHead: boolean; staleRequest: boolean; pending: boolean; policy: ReviewForgePolicy }): Action {
  const agent = resolveReviewAgent(input.name);
  const trigger = agent?.triggerFor(input.name) ?? triggerFor(input.name);
  const handle = normalizeHandle(input.name);
  const id = reviewerId(input.name);
  const headRefOid = getJsonString(input.item.trustedMetadata.headRefOid) ?? 'UNKNOWN';
  const skipped = input.requestedForHead || input.pending;
  const body = trigger === 'github-reviewer'
    ? (agent?.reviewerMarkerBodyFor(input.name, headRefOid) ?? reviewerMarkerBodyFor(input.name, headRefOid))
    : (agent?.commentBodyFor(input.name, input.policy, headRefOid) ?? commentBodyFor(input.name, input.policy, headRefOid));
  return createAction({
    id: `${skipped ? 'skip-reviewer' : 'request-review'}:${id}`,
    kind: 'request-review',
    target: { kind: 'review-item', id: input.item.key.id },
    mutation: 'review-provider',
    description: skipped ? `${handle} is already requested or has reviewed the current PR head.` : trigger === 'github-reviewer' ? `Request ${handle} as a GitHub pull request reviewer and record an idempotency marker for head ${headRefOid}.` : `Post an idempotent PR comment to trigger ${handle} for head ${headRefOid}.`,
    expectedResult: skipped ? `${handle} review request remains idempotent for the current PR head.` : `${handle} is requested for PR review without trusting review feedback as workflow authority.`,
    status: skipped ? 'skipped' : 'planned',
    details: {
      requestKind: trigger,
      reviewerId: id,
      reviewerName: redact(input.name),
      handle: redact(handle),
      externalService: id !== reviewerId(QUBE_REVIEW_SERVICE_NAME),
      requestedForHead: input.requestedForHead,
      staleRequest: input.staleRequest,
      pending: input.pending,
      marker: body.marker,
      body: body.body,
    },
  });
}

export class GitHubReviewForgeProvider implements ReviewForgeProvider {
  readonly id = 'github' as const;

  constructor(private readonly options: GitHubReviewProviderOptions = {}) {}

  capabilities(): ReviewForgeCapabilities { return { loadReview: true, loadReviewSnapshot: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true, publishLaneReview: true, publishLaneReviewInline: true, resolveReviewThreads: true }; }

  async getReviewItem(key: ReviewItemKey): Promise<ReviewItem> {
    if (key.providerId !== this.id) throw new Error(`load GitHub review item failed: providerId ${key.providerId} is unsupported. Use a github review item key.`);
    if (!/^[1-9]\d*$/.test(key.id)) throw new Error(`load GitHub review item failed: key id ${redactReviewKeyId(key.id)} is not a positive pull request number. Use a numeric GitHub pull request id.`);
    return (await this.loadPullRequestReview(Number(key.id))).item;
  }

  async findReviewForCurrentBranch(): Promise<ReviewItem | null> { return (await this.findCurrentReview()).item; }

  async findCurrentReview(): Promise<CurrentGitHubReview> {
    let result: GhRunResult;
    try {
      result = await runGh(['pr', 'view', '--json', CURRENT_PR_FIELDS], this.options);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return { item: null, pr: null, warning: `Current-branch PR state unavailable: ${redact(detail)}` };
    }
    if (result.exitCode !== 0) {
      const detail = redact(result.stderr || result.stdout || 'current branch has no pull request');
      return { item: null, pr: null, warning: `Current-branch PR state unavailable: ${detail}` };
    }
    try {
      const raw = parseGhJson<RawPrView>(result.stdout, 'gh pr view current branch', isRawPrView);
      const pr = normalizePr(raw);
      return { item: this.reviewItem(raw, [], [], [], [], [], [], [], null, []), pr, warning: null };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return { item: null, pr: null, warning: `Current-branch PR state unavailable: ${redact(detail)}` };
    }
  }

  async loadReviewSnapshot(key: ReviewItemKey): Promise<GitHubReviewSnapshot> {
    if (key.providerId !== this.id) throw new Error(`load GitHub review snapshot failed: providerId ${key.providerId} is unsupported.`);
    if (!/^[1-9]\d*$/.test(key.id)) throw new Error(`load GitHub review snapshot failed: key id ${redactReviewKeyId(key.id)} is not a positive pull request number.`);
    return this.loadPullRequestReview(Number(key.id));
  }

  async loadPullRequestReviewTarget(prNumber: number): Promise<{ pr: GitHubReviewPullRequest; closingIssueNumbers: number[] }> {
    const rawPr = await this.getPullRequest(prNumber);
    return {
      pr: normalizePr(rawPr),
      closingIssueNumbers: closingIssueNumbers(rawPr),
    };
  }

  async loadPullRequestReview(prNumber: number): Promise<GitHubReviewSnapshot> {
    const rawPr = await this.getPullRequest(prNumber);
    const unavailable: string[] = [];
    let ciDiagnostics: GitHubCiDiagnostic[] = [];
    let reviewComments: RawReviewComment[] = [];
    let unresolvedThreads: RawThreadNode[] = [];
    try {
      const repository = await this.getRepositoryIdentity();
      ciDiagnostics = await this.loadCiDiagnostics(repository.nameWithOwner, rawPr);
      try {
        rawPr.comments = await this.getIssueComments(repository.nameWithOwner, prNumber);
      } catch (error: unknown) {
        unavailable.push(`PR issue comments unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        reviewComments = await this.getReviewComments(repository.nameWithOwner, prNumber);
      } catch (error: unknown) {
        unavailable.push(`Review comments unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        unresolvedThreads = await this.getUnresolvedThreads(repository.nameWithOwner, prNumber);
      } catch (error: unknown) {
        unavailable.push(`Review threads unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error: unknown) {
      unavailable.push(`Repository identity unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let trustedMarkerAuthor: string | null = null;
    try { trustedMarkerAuthor = await this.currentLogin(); } catch { trustedMarkerAuthor = null; }
    const comments = rawPr.comments ?? [];
    const latestReviews = rawPr.latestReviews ?? [];
    const laneReviews = laneMarkerReviews(rawPr);
    const reviewRequests = reviewRequestNames(rawPr.reviewRequests);
    return {
      item: this.reviewItem(rawPr, reviewRequests, comments, latestReviews, laneReviews, reviewComments, unresolvedThreads, unavailable, trustedMarkerAuthor, ciDiagnostics),
      pr: normalizePr(rawPr),
      ciDiagnostics,
      closingIssueNumbers: closingIssueNumbers(rawPr),
      reviewRequests,
      commentsCount: comments.length,
      reviewsCount: latestReviews.length,
      reviewCommentsCount: reviewComments.length,
      unresolvedThreadsCount: unresolvedThreads.length,
      conversationsCount: unresolvedThreads.length,
      unavailable,
    };
  }

  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options: ReviewForgePlanOptions = {}): ActionPlan {
    const headSha = getJsonString(item.trustedMetadata.headRefOid) ?? 'UNKNOWN';
    const reviewRequests = getJsonStrings(item.trustedMetadata.reviewRequests);
    const trustedMarkerAuthor = getJsonString(item.trustedMetadata.trustedMarkerAuthor);
    const comments = commentsFromMetadata(item);
    const latestReviews = latestReviewsFromMetadata(item);
    const actions = configuredReviewerNames(policy, options.activeLanes ?? []).map(name => {
      const trigger = triggerFor(name);
      const handle = normalizeHandle(name);
      const requestedForHead = trigger === 'github-reviewer' ? hasMarker(comments, name, headSha, trustedMarkerAuthor) || isCurrentReview(latestReviews, handle, headSha) : hasMarker(comments, name, headSha, trustedMarkerAuthor);
      const pending = isPendingRequest(reviewRequests, handle);
      const staleRequest = trigger === 'github-reviewer' ? !requestedForHead && !pending && (hasStaleMarker(comments, name, headSha, trustedMarkerAuthor) || hasStaleReview(latestReviews, handle, headSha)) : !requestedForHead && hasStaleMarker(comments, name, headSha, trustedMarkerAuthor);
      return makeRequestAction({ item, name, requestedForHead, staleRequest, pending, policy });
    });
    return createActionPlan({ id: `github:review-request:${item.key.id}`, purpose: `Request configured PR reviewers for ${item.displayId}.`, dryRun: true, actions });
  }

  async publishLaneReviewFeedback(item: ReviewItem, input: GitHubLaneReviewPublishInput): Promise<GitHubLaneReviewPublishResult> {
    const { body, marker, runId, bodyFindingCount, inlineCommentCount } = laneReviewBody(input);
    if (matchingCurrentLaneReview(item, input, runId)) {
      return localReviewPublishResult({ status: 'skipped', runId, marker, body: null, nextAction: `Provider-visible lane review for ${input.lane} is already published for this PR head and run id.` });
    }
    if (input.dryRun) {
      return localReviewPublishResult({ status: 'planned', runId, marker, body, publishKind: 'pull-request-review', inlineCommentCount, bodyFindingCount, nextAction: `Rerun \`aie pr review publish <pr> --lane ${input.lane}\` without --dry-run to publish provider-visible pull request review feedback.` });
    }
    return this.publishLaneReviewFeedbackForPullRequest(input);
  }

  async publishLaneReviewFeedbackForPullRequest(input: GitHubLaneReviewPublishInput): Promise<GitHubLaneReviewPublishResult> {
    const allFindings = normalizeLaneFindings(input);
    const plannedBody = laneReviewBody(input, allFindings, 0);
    let comments: RawComment[];
    let laneReviews: RawReview[];
    let trustedMarkerAuthor: string;
    let repositoryName: string;
    try {
      const repository = await this.getRepositoryIdentity();
      repositoryName = repository.nameWithOwner;
      comments = await this.getIssueComments(repository.nameWithOwner, input.prNumber);
      const rawPr = await this.getPullRequest(input.prNumber);
      laneReviews = laneMarkerReviews(rawPr);
      trustedMarkerAuthor = await this.currentLogin();
    } catch (error: unknown) {
      return localReviewPublishResult({
        status: 'failed',
        runId: plannedBody.runId,
        marker: plannedBody.marker,
        body: plannedBody.body,
        publishKind: 'pull-request-review',
        inlineCommentCount: plannedBody.inlineCommentCount,
        bodyFindingCount: plannedBody.bodyFindingCount,
        failure: redact(error instanceof Error ? error.message : String(error)),
        nextAction: `Fix GitHub PR review visibility or authentication, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
      });
    }
    const trustedItem = normalizeReviewItem({
      key: { providerId: this.id, id: String(input.prNumber) },
      displayId: `#${input.prNumber}`,
      title: `Pull request #${input.prNumber}`,
      source: normalizeProviderSource({ providerId: this.id, resourceKind: 'review-item', resourceId: String(input.prNumber), url: null }),
      sourceRef: input.headSha,
      targetRef: 'base',
      state: 'open',
      url: null,
      reviewDecision: 'unknown',
      mergeability: 'unknown',
      feedback: [],
      checks: [],
      trustedMetadata: { trustedLaneReviews: laneReviewMetadata(comments, laneReviews, trustedMarkerAuthor, input.headSha) },
    });
    if (matchingCurrentLaneReview(trustedItem, input, plannedBody.runId)) {
      return localReviewPublishResult({ status: 'skipped', runId: plannedBody.runId, marker: plannedBody.marker, body: null, nextAction: `Provider-visible lane review for ${input.lane} is already published for this PR head and run id.` });
    }
    if (input.dryRun) {
      return localReviewPublishResult({ status: 'planned', runId: plannedBody.runId, marker: plannedBody.marker, body: plannedBody.body, publishKind: 'pull-request-review', inlineCommentCount: 0, bodyFindingCount: plannedBody.bodyFindingCount, nextAction: `Rerun \`aie pr review publish <pr> --lane ${input.lane}\` without --dry-run to publish provider-visible pull request review feedback.` });
    }
    let bodyFindings = allFindings;
    let inlineFindings: ReviewFinding[] = [];
    if (hasInlineFindingCandidates(allFindings)) {
      try {
        const diff = await this.getPullRequestDiff(input.prNumber);
        const partitioned = partitionReviewFindings(allFindings, parseUnifiedDiffIndex(diff));
        bodyFindings = [...partitioned.body];
        inlineFindings = [...partitioned.inline];
      } catch {
        bodyFindings = allFindings;
        inlineFindings = [];
      }
    }
    const inlineComments = inlineFindings
      .map(finding => inlineReviewComment(finding, input.evidencePath))
      .filter((comment): comment is JsonObject => comment !== null);
    const { body, marker, runId, bodyFindingCount, inlineCommentCount } = laneReviewBody(input, bodyFindings, inlineComments.length);
    const submitReview = async (payload: JsonObject): Promise<GhRunResult> => {
      const args = ['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews`, '--method', 'POST'];
      const payloadPath = reviewPayloadPath(payload);
      try {
        return await runGh([...args, '--input', payloadPath], this.options);
      } catch (error: unknown) {
        return {
          args: [...args, '--input', payloadPath],
          exitCode: error instanceof GhExecutionError ? error.exitCode : 1,
          stdout: '',
          stderr: error instanceof GhExecutionError ? error.stderr : error instanceof Error ? error.message : String(error),
        };
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    };
    const publishReviewResult = (publishResult: GhRunResult, publishBody: ReturnType<typeof laneReviewBody>, nextAction: string): GitHubLaneReviewPublishResult => {
      const reviewUrl = publishedReviewUrl(publishResult);
      return localReviewPublishResult({
        status: 'published',
        runId: publishBody.runId,
        marker: publishBody.marker,
        body: publishBody.body,
        url: reviewUrl,
        reviewUrl,
        publishKind: 'pull-request-review',
        inlineCommentCount: publishBody.inlineCommentCount,
        bodyFindingCount: publishBody.bodyFindingCount,
        inlineCommentUrls: [],
        nextAction,
      });
    };
    const payload = {
      commit_id: input.headSha,
      body,
      event: reviewEvent(input.recommendation),
      comments: inlineComments,
    };
    const result = await submitReview(payload);
    if (result.exitCode !== 0) {
      const fallbackBody = laneReviewBody(input, allFindings, 0);
      const intendedEvent = reviewEvent(input.recommendation);
      const intendedBodyOnlyResult = await submitReview({
        commit_id: input.headSha,
        body: fallbackBody.body,
        event: intendedEvent,
        comments: [],
      });
      if (intendedBodyOnlyResult.exitCode === 0) {
        return publishReviewResult(
          intendedBodyOnlyResult,
          fallbackBody,
          `Provider-visible body-only pull request review for ${input.lane} was published after GitHub rejected inline review comments; rerun PR view/gate to inspect provider state.`,
        );
      }
      if (intendedEvent !== 'COMMENT') {
        const commentFallbackResult = await submitReview({
          commit_id: input.headSha,
          body: fallbackBody.body,
          event: 'COMMENT',
          comments: [],
        });
        if (commentFallbackResult.exitCode === 0) {
          return publishReviewResult(
            commentFallbackResult,
            fallbackBody,
            `Provider-visible COMMENT pull request review for ${input.lane} was published after GitHub rejected the requested review event; rerun PR view/gate to inspect provider state.`,
          );
        }
        return localReviewPublishResult({
          status: 'failed',
          runId,
          marker,
          body,
          publishKind: 'pull-request-review',
          inlineCommentCount,
          bodyFindingCount,
          failure: redact(`${result.stderr || result.stdout || 'gh api pull request review failed'}; body-only fallback failed: ${intendedBodyOnlyResult.stderr || intendedBodyOnlyResult.stdout || 'gh api body-only pull request review failed'}; comment fallback failed: ${commentFallbackResult.stderr || commentFallbackResult.stdout || 'gh api comment pull request review failed'}`),
          nextAction: `Fix GitHub pull request review permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
        });
      }
      return localReviewPublishResult({
        status: 'failed',
        runId,
        marker,
        body,
        publishKind: 'pull-request-review',
        inlineCommentCount,
        bodyFindingCount,
        failure: redact(`${result.stderr || result.stdout || 'gh api pull request review failed'}; body-only fallback failed: ${intendedBodyOnlyResult.stderr || intendedBodyOnlyResult.stdout || 'gh api body-only pull request review failed'}`),
        nextAction: `Fix GitHub pull request review permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
      });
    }
    return publishReviewResult(result, { body, marker, runId, bodyFindingCount, inlineCommentCount }, `Provider-visible pull request review for ${input.lane} was published; rerun PR view/gate to inspect provider state.`);
  }

  async publishLocalReviewFeedback(item: ReviewItem, input: GitHubLocalReviewPublishInput): Promise<GitHubLocalReviewPublishResult> {
    if (!input.enabled) return localReviewPublishResult({ status: 'disabled', nextAction: 'Local review publishing is disabled by the selected review adapter.' });
    const { body, marker, runId } = localReviewBody(input);
    if (input.issueNumbers.length === 0) {
      return localReviewPublishResult({ status: 'skipped', runId, marker, body, nextAction: 'No linked issue numbers were available, so local review feedback was not published.' });
    }
    if (currentLocalReviewRunIds(item, input.headSha).has(runId)) {
      return localReviewPublishResult({ status: 'skipped', runId, marker, body: null, nextAction: 'Provider-visible local review feedback is already published for this PR head and run id.' });
    }
    if (input.dryRun) {
      return localReviewPublishResult({ status: 'planned', runId, marker, body, nextAction: 'Rerun `aie pr gate <pr>` without --dry-run to publish provider-visible local review feedback.' });
    }
    let result: GhRunResult;
    try {
      result = await runGh(['pr', 'comment', String(input.prNumber), '--body', body], this.options);
    } catch (error: unknown) {
      return localReviewPublishResult({
        status: 'failed',
        runId,
        marker,
        body,
        failure: redact(error instanceof Error ? error.message : String(error)),
        nextAction: 'Fix GitHub comment permissions or connectivity, then rerun `aie pr gate <pr>`; local evidence alone does not satisfy provider-visible local review publishing.',
      });
    }
    if (result.exitCode !== 0) {
      return localReviewPublishResult({
        status: 'failed',
        runId,
        marker,
        body,
        failure: redact(result.stderr || result.stdout || 'gh pr comment failed'),
        nextAction: 'Fix GitHub comment permissions or connectivity, then rerun `aie pr gate <pr>`; local evidence alone does not satisfy provider-visible local review publishing.',
      });
    }
    return localReviewPublishResult({
      status: 'published',
      runId,
      marker,
      body,
      url: publishedCommentUrl(result),
      nextAction: 'Provider-visible local review feedback was published; rerun PR view/gate to inspect provider state if needed.',
    });
  }

  async resolveReviewThreads(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult> {
    const threadIds = [...new Set(input.threadIds.map(id => id.trim()).filter(id => id !== ''))];
    if (threadIds.length === 0) {
      return {
        status: 'skipped',
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: [],
        failedThreadIds: [],
        nextAction: 'No review thread ids were selected; rerun `aie pr view <pr> --json` to inspect unresolved reviewThreads.',
      };
    }
    if (input.dryRun) {
      return {
        status: 'planned',
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: threadIds,
        failedThreadIds: [],
        nextAction: `Rerun without --dry-run to resolve ${threadIds.length} GitHub review thread${threadIds.length === 1 ? '' : 's'}.`,
      };
    }
    const resolvedThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    for (const threadId of threadIds) {
      const result = await this.resolveReviewThread(threadId);
      if (result) resolvedThreadIds.push(threadId);
      else failedThreadIds.push(threadId);
    }
    const status: ResolveReviewThreadResult['status'] = failedThreadIds.length > 0 ? (resolvedThreadIds.length > 0 ? 'failed' : 'failed') : 'resolved';
    return {
      status,
      prNumber: input.prNumber,
      resolvedThreadIds,
      skippedThreadIds: [],
      failedThreadIds,
      nextAction: failedThreadIds.length > 0
        ? `Some GitHub review threads could not be resolved. Verify permissions and rerun \`aie pr thread resolve ${input.prNumber} --thread <id>\` for the failed ids.`
        : `Resolved ${resolvedThreadIds.length} GitHub review thread${resolvedThreadIds.length === 1 ? '' : 's'}; rerun \`aie pr view ${input.prNumber} --json\` or \`aie pr gate ${input.prNumber}\` to confirm merge blockers cleared.`,
    };
  }

  async apply(plan: ActionPlan): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of plan.actions) {
      if (action.status === 'skipped') {
        results.push(actionResult(action, 'skipped'));
        continue;
      }
      try {
        await this.applyAction(action);
        results.push(actionResult(action, 'completed'));
      } catch (error: unknown) {
        results.push(actionResult(action, 'failed', {
          operation: action.description,
          cause: error instanceof Error ? error.message : String(error),
          nextAction: 'Verify GitHub permissions, PR number, repository access, and configured reviewers, then rerun `aie pr gate <pr> --dry-run` before retrying.',
        }));
      }
    }
    return results;
  }

  private async getPullRequest(prNumber: number): Promise<RawPrView> {
    const result = await runGh(['pr', 'view', String(prNumber), '--json', PR_VIEW_FIELDS], this.options);
    ensureGhSuccess(`gh pr view ${prNumber}`, result);
    return parseGhJson<RawPrView>(result.stdout, `gh pr view ${prNumber}`, isRawPrView);
  }

  private async getIssueComments(repoName: string, prNumber: number): Promise<RawComment[]> {
    try {
      const result = await runGh(['api', `repos/${repoName}/issues/${prNumber}/comments`, '--method', 'GET', '-F', 'per_page=100', '--paginate', '--slurp'], this.options);
      ensureGhSuccess(`gh api pull issue comments for PR ${prNumber}`, result);
      const parsed = parseGhJson<RawIssueComment[] | RawIssueComment[][]>(result.stdout, `gh api pull issue comments for PR ${prNumber}`, isRawIssueCommentArray);
      return parsed.flat().map(comment => ({ author: comment.user ?? null, body: comment.body, url: comment.html_url }));
    } catch (apiError: unknown) {
      try {
        return await this.getPullRequestComments(prNumber);
      } catch (fallbackError: unknown) {
        const apiCause = apiError instanceof Error ? apiError.message : String(apiError);
        const fallbackCause = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        throw new Error(`issue comment API failed: ${apiCause}; PR comment fallback failed: ${fallbackCause}`);
      }
    }
  }

  private async getPullRequestComments(prNumber: number): Promise<RawComment[]> {
    const result = await runGh(['pr', 'view', String(prNumber), '--json', 'comments'], this.options);
    ensureGhSuccess(`gh pr view ${prNumber} comments fallback`, result);
    const parsed = parseGhJson<{ comments?: RawComment[] }>(result.stdout, `gh pr view ${prNumber} comments fallback`, isRawPrCommentsView);
    return parsed.comments ?? [];
  }

  private async getReviewComments(repoName: string, prNumber: number): Promise<RawReviewComment[]> {
    const result = await runGh(['api', `repos/${repoName}/pulls/${prNumber}/comments`, '--method', 'GET', '-F', 'per_page=100', '--paginate', '--slurp'], this.options);
    ensureGhSuccess(`gh api pull review comments for PR ${prNumber}`, result);
    const parsed = parseGhJson<RawReviewComment[] | RawReviewComment[][]>(result.stdout, `gh api pull review comments for PR ${prNumber}`, isRawReviewCommentArray);
    return parsed.flat();
  }

  private async getPullRequestDiff(prNumber: number): Promise<string> {
    const result = await runGh(['pr', 'diff', String(prNumber), '--patch'], this.options);
    ensureGhSuccess(`gh pr diff ${prNumber} --patch`, result);
    return result.stdout;
  }

  private async getUnresolvedThreads(repoName: string, prNumber: number): Promise<RawThreadNode[]> {
    const [owner, repo] = repoName.split('/');
    if (!owner || !repo) return [];
    const query = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { nodes { id isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(last: 1) { nodes { id databaseId body url path line originalLine diffHunk outdated createdAt author { login } } } } pageInfo { hasNextPage endCursor } } } } }`;
    const nodes: RawThreadNode[] = [];
    let cursor: string | null = null;
    for (;;) {
      const args = ['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${prNumber}`, '-f', `query=${query}`];
      if (cursor !== null) args.push('-F', `after=${cursor}`);
      const result = await runGh(args, this.options);
      ensureGhSuccess(`gh api graphql review threads for PR ${prNumber}`, result);
      const page = parseGhJson<RawThreadResponse>(result.stdout, `gh api graphql review threads for PR ${prNumber}`, isRawThreadResponse).data?.repository?.pullRequest?.reviewThreads;
      nodes.push(...(page?.nodes ?? []));
      if (!page?.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
      cursor = page.pageInfo.endCursor;
    }
    return nodes.filter(thread => thread.isResolved === false);
  }

  private async resolveReviewThread(threadId: string): Promise<boolean> {
    const query = 'mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }';
    try {
      const result = await runGh(['api', 'graphql', '-f', `threadId=${threadId}`, '-f', `query=${query}`], this.options);
      if (result.exitCode !== 0) return false;
      const parsed = parseGhJson<{ data?: { resolveReviewThread?: { thread?: { id?: unknown; isResolved?: unknown } | null } | null } }>(
        result.stdout,
        `gh api graphql resolve review thread ${threadId}`,
        value => isRecord(value),
      );
      const thread = parsed.data?.resolveReviewThread?.thread;
      return thread?.id === threadId && thread.isResolved === true;
    } catch {
      return false;
    }
  }

  private async currentLogin(): Promise<string> {
    const result = await runGh(['api', 'user'], this.options);
    ensureGhSuccess('gh api user', result);
    return parseGhJson<LoginResponse>(result.stdout, 'gh api user', isLoginResponse).login;
  }

  private async loadCiDiagnostics(repoName: string, rawPr: RawPrView): Promise<GitHubCiDiagnostic[]> {
    const headSha = rawPr.headRefOid;
    const statusChecks = latestChecks(rawPr.statusCheckRollup);
    if (!headSha || statusChecks.length === 0) return [];
    try {
      const [checkRuns, checkSuites, workflowRuns, staleRuns] = await Promise.all([
        this.getCurrentHeadCheckRuns(repoName, headSha),
        this.getCurrentHeadCheckSuites(repoName, headSha),
        this.getCurrentHeadWorkflowRuns(repoName, headSha),
        this.getWorkflowRunsByIds(repoName, uniqueStrings(statusChecks.map(check => runIdFromUrl(check.detailsUrl ?? check.targetUrl)))),
      ]);
      return buildCiDiagnostics({
        checks: statusChecks,
        headSha: redact(headSha),
        checkRuns,
        checkSuites,
        workflowRuns,
        staleRuns,
        workflowDispatchSupported: this.workflowDispatchSupported(),
      });
    } catch {
      return [];
    }
  }

  private async getCurrentHeadCheckRuns(repoName: string, headSha: string): Promise<RawCheckRun[]> {
    const result = await runGh(['api', `repos/${repoName}/commits/${headSha}/check-runs`, '--method', 'GET', '-F', 'per_page=100'], this.options);
    ensureGhSuccess(`gh api check runs for ${headSha}`, result);
    return parseGhJson<RawCheckRunsResponse>(result.stdout, `gh api check runs for ${headSha}`, isRawCheckRunArray).check_runs ?? [];
  }

  private async getCurrentHeadCheckSuites(repoName: string, headSha: string): Promise<RawCheckSuite[]> {
    const result = await runGh(['api', `repos/${repoName}/commits/${headSha}/check-suites`, '--method', 'GET', '-F', 'per_page=100'], this.options);
    ensureGhSuccess(`gh api check suites for ${headSha}`, result);
    return parseGhJson<RawCheckSuitesResponse>(result.stdout, `gh api check suites for ${headSha}`, isRawCheckSuiteArray).check_suites ?? [];
  }

  private async getCurrentHeadWorkflowRuns(repoName: string, headSha: string): Promise<RawWorkflowRun[]> {
    const result = await runGh(['api', `repos/${repoName}/actions/runs`, '--method', 'GET', '-F', `head_sha=${headSha}`, '-F', 'per_page=100'], this.options);
    ensureGhSuccess(`gh api workflow runs for ${headSha}`, result);
    return parseGhJson<RawWorkflowRunsResponse>(result.stdout, `gh api workflow runs for ${headSha}`, isRawWorkflowRunArray).workflow_runs ?? [];
  }

  private async getWorkflowRunsByIds(repoName: string, ids: string[]): Promise<RawWorkflowRun[]> {
    const results = await Promise.all(ids.map(async id => {
      const result = await runGh(['api', `repos/${repoName}/actions/runs/${id}`, '--method', 'GET'], this.options);
      if (result.exitCode !== 0) return null;
      try {
        return parseGhJson<RawWorkflowRun>(result.stdout, `gh api workflow run ${id}`, isRawWorkflowRun);
      } catch {
        return null;
      }
    }));
    return results.filter((run): run is RawWorkflowRun => run !== null);
  }

  private workflowDispatchSupported(): boolean | null {
    if (!this.options.cwd) return null;
    const workflowRoot = join(this.options.cwd, '.github', 'workflows');
    if (!existsSync(workflowRoot)) return null;
    try {
      return readdirSync(workflowRoot)
        .filter((name: string) => name.endsWith('.yml') || name.endsWith('.yaml'))
        .some((name: string) => /\bworkflow_dispatch\b/.test(readFileSync(join(workflowRoot, name), 'utf8')));
    } catch {
      return null;
    }
  }

  private reviewItem(rawPr: RawPrView, reviewRequests: string[], comments: RawComment[], latestReviews: RawReview[], laneReviews: RawReview[], reviewComments: RawReviewComment[], unresolvedThreads: RawThreadNode[], unavailable: string[], trustedMarkerAuthor: string | null, ciDiagnostics: GitHubCiDiagnostic[]): ReviewItem {
    const pr = normalizePr(rawPr);
    const source = normalizeProviderSource({ providerId: this.id, resourceKind: 'review-item', resourceId: String(rawPr.number), url: pr.url });
    const normalizedChecks = checks(rawPr.statusCheckRollup, ciDiagnostics);
    const conversations = reviewConversations(unresolvedThreads);
    const blockers = mergeBlockers({ pr, unresolvedThreads, checks: normalizedChecks });
    return normalizeReviewItem({
      key: { providerId: this.id, id: String(rawPr.number) },
      displayId: `#${rawPr.number}`,
      title: pr.title,
      url: pr.url,
      sourceRef: pr.headRefOid,
      targetRef: 'base',
      state: mapReviewState(rawPr),
      reviewDecision: mapReviewDecision(rawPr.reviewDecision),
      mergeability: mapMergeability(rawPr),
      feedback: feedback({ comments, latestReviews, reviewComments, unresolvedThreads, trustedMarkerAuthor, headRefOid: pr.headRefOid }),
      mergeBlockers: blockers,
      conversations,
      checks: normalizedChecks,
      trustedMetadata: { ...metadata({ pr, reviewRequests, comments, latestReviews, laneReviews, unresolvedThreads, unavailable, trustedMarkerAuthor, checks: normalizedChecks }), ciDiagnostics: ciDiagnostics.map(ciDiagnosticMetadata) },
      source,
    });
  }

  private async applyAction(action: Action): Promise<void> {
    const prNumber = action.target.id;
    const requestKind = getString(action.details, 'requestKind');
    const handle = getString(action.details, 'handle');
    const body = getString(action.details, 'body') ?? '';
    if (!handle) throw new Error('apply GitHub review action failed: missing reviewer handle. Likely cause: the review request action was not planned with a handle. Next action: rerun `aie pr gate <pr> --dry-run` and inspect the generated review action details.');
    if (requestKind === 'github-reviewer') { ensureGhSuccess(`gh pr edit ${prNumber} --add-reviewer ${handle}`, await runGh(['pr', 'edit', prNumber, '--add-reviewer', handle], this.options)); if (body !== '') ensureGhSuccess(`gh pr comment ${prNumber}`, await runGh(['pr', 'comment', prNumber, '--body', body], this.options)); return; }
    if (requestKind === 'comment') { ensureGhSuccess(`gh pr comment ${prNumber}`, await runGh(['pr', 'comment', prNumber, '--body', body], this.options)); return; }
    throw new Error(`apply GitHub review action failed: request kind ${requestKind ?? 'unknown'} is not supported. Likely cause: action.details.requestKind is invalid. Next action: regenerate the action plan with requestKind "github-reviewer" or "comment".`);
  }

  private async getRepositoryIdentity(): Promise<{ nameWithOwner: string; url: string }> {
    const result = await runGh(['repo', 'view', '--json', 'nameWithOwner,url'], this.options);
    ensureGhSuccess('gh repo view', result);
    return parseGhJson<{ nameWithOwner: string; url: string }>(result.stdout, 'gh repo view', (value): value is { nameWithOwner: string; url: string } => isRecord(value) && typeof value.nameWithOwner === 'string' && typeof value.url === 'string');
  }
}

export type GitHubReviewProvider = GitHubReviewForgeProvider;

export function createGitHubReviewForgeProvider(options: GitHubReviewProviderOptions = {}): GitHubReviewForgeProvider {
  return new GitHubReviewForgeProvider(options);
}

export function createGitHubReviewProvider(options: GitHubReviewProviderOptions = {}): GitHubReviewForgeProvider {
  return createGitHubReviewForgeProvider(options);
}
