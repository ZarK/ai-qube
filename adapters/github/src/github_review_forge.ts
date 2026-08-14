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
  type ReviewForgeStatsProvider,
  type ReviewItem,
  type ReviewItemKey,
  GITHUB_REVIEW_RENDER_PROFILE,
  DEGRADED_REVIEW_RENDER_PROFILE,
  clipReviewAnchorSpan,
  clipReviewAnchorSpanToDiff,
  findingWithPublishedAnchor,
  isSelfAuthoredReviewBody,
  renderInlineReviewComment,
  renderLaneReviewBody,
  type ReviewDiffIndex,
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
import type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot, LoginResponse, RawAuthor, RawComment, RawIssueComment, RawLaneHistoryResponse, RawMergeUiState, RawMergeUiStateResponse, RawPrView, RawReview, RawReviewComment, RawReviewRequest, RawStatusCheck, RawThreadNode, RawThreadResponse } from './github_review_types.js';
import { GhExecutionError, parseGhJson, redact, runGh, type GhRunResult } from './gh.js';
import {
  emptyPublisherIdentity,
  publicPublisherIdentity,
  resolveGitHubReviewPublisher,
  type GitHubReviewPublisherIdentity,
  type ResolvedGitHubReviewPublisher,
} from './github_review_publisher.js';

export type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot } from './github_review_types.js';
export { MARKER_PREFIX, QUBE_REVIEW_SERVICE_NAME, listGitHubReviewAgents, resolveReviewAgent } from './github_review_agents.js';

const PR_VIEW_FIELDS = 'number,title,state,url,headRefOid,author,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,reviews,latestReviews,statusCheckRollup,closingIssuesReferences';
const CURRENT_PR_FIELDS = 'number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft';
const RECENT_PR_FIELDS = 'number,title,state,url,headRefOid,author,reviewDecision,mergeStateStatus,mergeable,isDraft,closedAt,mergedAt,updatedAt';
const MAX_RECENT_PR_LIMIT = 50;
const MAX_RECENT_PR_CANDIDATES = MAX_RECENT_PR_LIMIT * 2;
const MAX_LANE_HISTORY_RECORDS = 100;
const LOCAL_REVIEW_MARKER_PREFIX = 'qube-local-review';
const LANE_REVIEW_MARKER_PREFIX = 'qube-pr-review';
const ROUND_STATUS_MARKER_PREFIX = 'qube-pr-status';

function parseStatusCommentRounds(body: string | undefined): Array<{ head: string; verdict: string }> {
  const text = body ?? '';
  const prefix = '<!-- qube-pr-status:';
  const start = text.indexOf(prefix);
  if (start < 0) return [];
  const jsonStart = start + prefix.length;
  const end = text.indexOf(' -->', jsonStart);
  if (end < 0) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(jsonStart, end));
    if (!isRecord(parsed) || !Array.isArray(parsed.rounds)) return [];
    return parsed.rounds
      .filter((entry): entry is { head: string; verdict: string } => isRecord(entry) && typeof entry.head === 'string' && entry.head.trim() !== '' && typeof entry.verdict === 'string' && entry.verdict.trim() !== '')
      .map(entry => ({ head: entry.head, verdict: entry.verdict }))
      .slice(-20);
  } catch {
    return [];
  }
}

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
  publisher?: import('./github_review_publisher.js').GitHubReviewPublisherIdentity;
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
  expectedLanes?: string[];
  round?: string;
  /** A superseded marker preserves a replaced verdict for history readers; live read paths ignore it. */
  superseded?: boolean;
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
  blockingFindingCount?: number;
  findingDigest?: string;
}

interface LaneReviewComment {
  metadata: LaneReviewMetadata;
  author: RawAuthor | null | undefined;
  body: string;
  url: string | null;
  stale: boolean;
  publishedAt: string | null;
}

export interface GitHubLaneReviewPublishInput {
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  lane: string;
  expectedLanes: readonly string[];
  /** Deterministic round grouping id carried into the marker so round completeness is decidable from the provider record alone. */
  round: string;
  profile: string;
  status: string;
  recommendation: GitHubLocalReviewRecommendation;
  host: string;
  issueNumber: number;
  summary: string;
  findings: Array<ReviewFinding | string>;
  completeness: string | null;
  evidencePath: string | null;
  /** Cross-lane synthesis withheld counts for this lane; rendered in the body and part of the finding digest so stale accounting republishes. */
  withheld?: { duplicates: number; offDiff: number; byCap: number };
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
  publisher?: import('./github_review_publisher.js').GitHubReviewPublisherIdentity;
}

const ROUND_SUMMARY_MARKER_PREFIX = 'qube-pr-review-summary';

function publishedRoundSummaryBody(
  input: GitHubRoundSummaryPublishInput,
  publishKind: 'pull-request-review' | 'issue-comment',
): string {
  if (publishKind === 'issue-comment' && typeof input.issueCommentBody === 'string' && input.issueCommentBody.trim() !== '') {
    return input.issueCommentBody;
  }
  return input.body;
}

export interface GitHubRoundSummaryInlineFinding {
  laneId: string;
  finding: ReviewFinding;
  commentBody: string;
}

export interface GitHubRoundSummaryPublishInput {
  dryRun: boolean;
  prNumber: number;
  headSha: string;
  round: string;
  issueNumber: number;
  expectedLanes: readonly string[];
  verdict: GitHubLocalReviewRecommendation;
  /** Fully rendered markdown body, including the embedded qube-pr-review-summary marker, ready to publish verbatim. */
  body: string;
  /** Re-rendered body for issue-comment transport; required so fallback never reuses the review-api prose. */
  issueCommentBody?: string;
  marker: string;
  inlineFindings: readonly GitHubRoundSummaryInlineFinding[];
  unanchoredFindingCount: number;
  findingDigest: string;
}

export interface GitHubRoundSummaryPublishResult {
  status: GitHubLocalReviewPublishStatus;
  runId: string | null;
  marker: string | null;
  body: string | null;
  url: string | null;
  summaryUrl?: string | null;
  publishKind?: 'issue-comment' | 'pull-request-review';
  inlineCommentCount?: number;
  unanchoredFindingCount?: number;
  supersededPriorSummaries?: number;
  publisherDowngradeReason?: string | null;
  failure: string | null;
  nextAction: string;
  publisher?: import('./github_review_publisher.js').GitHubReviewPublisherIdentity;
}

/** Minimal fields needed to plan supersession and surface a read-path pointer; the full audit-trail metadata lives in the rendered body itself. */
interface RoundSummaryMarkerRecord {
  readonly id: string;
  readonly kind: 'comment' | 'review';
  readonly head: string;
  readonly round: string;
  readonly prNumber: number;
  readonly findingDigest: string;
  readonly superseded: boolean;
  readonly url: string | null;
  readonly publishedAt: string | null;
}

function parseRoundSummaryMarkerRecord(body: string | undefined): Pick<RoundSummaryMarkerRecord, 'head' | 'round' | 'prNumber' | 'findingDigest' | 'superseded'> | null {
  const match = (body ?? '').match(/<!--\s*qube-pr-review-summary:(\{[\s\S]*?\})\s*-->/);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.head !== 'string' || parsed.head.trim() === '') return null;
    if (typeof parsed.round !== 'string' || parsed.round.trim() === '') return null;
    if (typeof parsed.prNumber !== 'number' || !Number.isSafeInteger(parsed.prNumber) || parsed.prNumber <= 0) return null;
    if (typeof parsed.findingDigest !== 'string' || parsed.findingDigest.trim() === '') return null;
    return { head: parsed.head, round: parsed.round, prNumber: parsed.prNumber, findingDigest: parsed.findingDigest, superseded: parsed.superseded === true };
  } catch {
    return null;
  }
}

function roundSummaryRecords(comments: RawComment[], reviews: RawReview[], trustedAuthor: TrustedAuthorInput): RoundSummaryMarkerRecord[] {
  const records: RoundSummaryMarkerRecord[] = [];
  for (const comment of comments) {
    if (!authorIsTrusted(comment.author?.login, trustedAuthor)) continue;
    const parsed = parseRoundSummaryMarkerRecord(comment.body);
    const id = issueCommentIdFromUrl(comment.url);
    if (parsed && id) records.push({ ...parsed, id, kind: 'comment', url: comment.url ? redact(comment.url) : null, publishedAt: comment.createdAt ?? null });
  }
  for (const review of reviews) {
    if (!authorIsTrusted(reviewAuthor(review), trustedAuthor)) continue;
    const parsed = parseRoundSummaryMarkerRecord(review.body);
    if (parsed && review.id !== undefined && review.id !== null) {
      records.push({ ...parsed, id: String(review.id), kind: 'review', url: review.url ? redact(String(review.url)) : null, publishedAt: review.submittedAt ?? review.submitted_at ?? null });
    }
  }
  return records;
}

/** The single live (non-superseded) round summary for a PR, most recently published, for read-path discovery. */
function currentRoundSummaryPointer(comments: RawComment[], reviews: RawReview[], trustedAuthor: TrustedAuthorInput, prNumber: number, headSha: string): JsonObject | null {
  const live = roundSummaryRecords(comments, reviews, trustedAuthor).filter(record => record.superseded !== true && record.prNumber === prNumber);
  if (live.length === 0) return null;
  const latest = live.reduce((newest, record) => (Date.parse(record.publishedAt ?? '') || 0) >= (Date.parse(newest.publishedAt ?? '') || 0) ? record : newest);
  return { head: latest.head, round: latest.round, url: latest.url, publishedAt: latest.publishedAt, stale: latest.head !== headSha };
}

function roundSummaryPublishResult(input: Partial<GitHubRoundSummaryPublishResult> & { status: GitHubLocalReviewPublishStatus; nextAction: string }): GitHubRoundSummaryPublishResult {
  return {
    runId: input.runId ?? null,
    marker: input.marker ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
    ...(input.summaryUrl !== undefined ? { summaryUrl: input.summaryUrl } : {}),
    ...(input.publishKind ? { publishKind: input.publishKind } : {}),
    ...(typeof input.inlineCommentCount === 'number' ? { inlineCommentCount: input.inlineCommentCount } : {}),
    ...(typeof input.unanchoredFindingCount === 'number' ? { unanchoredFindingCount: input.unanchoredFindingCount } : {}),
    ...(typeof input.supersededPriorSummaries === 'number' ? { supersededPriorSummaries: input.supersededPriorSummaries } : {}),
    ...(input.publisherDowngradeReason !== undefined ? { publisherDowngradeReason: input.publisherDowngradeReason } : {}),
    ...(input.publisher ? { publisher: publicPublisherIdentity(input.publisher) } : {}),
    failure: input.failure ?? null,
    status: input.status,
    nextAction: input.nextAction,
  };
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

function isRawPrList(value: unknown): value is RawPrView[] {
  return Array.isArray(value) && value.every(isRawPrView);
}

function isRawReviewCommentArray(value: unknown): value is RawReviewComment[] | RawReviewComment[][] { return Array.isArray(value) && value.every(item => isRecord(item) || (Array.isArray(item) && item.every(isRecord))); }

function isRawIssueCommentArray(value: unknown): value is RawIssueComment[] | RawIssueComment[][] { return Array.isArray(value) && value.every(item => isRecord(item) || (Array.isArray(item) && item.every(isRecord))); }

function isRawPrCommentsView(value: unknown): value is { comments?: RawComment[] } { return isRecord(value) && (value.comments === undefined || Array.isArray(value.comments)); }

function isRawThreadResponse(value: unknown): value is RawThreadResponse { return isRecord(value); }

function isRawLaneHistoryResponse(value: unknown): value is RawLaneHistoryResponse { return isRecord(value); }

function isRawMergeUiStateResponse(value: unknown): value is RawMergeUiStateResponse { return isRecord(value); }

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

function normalizeProviderText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const normalized = redact(sanitizeFeedbackText(value).replace(/\s+/g, ' ').trim());
  if (normalized === '') return null;
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function trustedMarkerComment(comment: RawComment, trustedAuthor: TrustedAuthorInput): boolean {
  return authorIsTrusted(comment.author?.login, trustedAuthor) && (comment.body ?? '').includes(`<!-- ${MARKER_PREFIX}:`);
}

function hasMarker(comments: RawComment[], reviewer: string, headSha: string, trustedAuthor: TrustedAuthorInput): boolean {
  return comments.some(comment => trustedMarkerComment(comment, trustedAuthor) && (comment.body ?? '').includes(markerFor(reviewer, headSha)));
}

function hasStaleMarker(comments: RawComment[], reviewer: string, headSha: string, trustedAuthor: TrustedAuthorInput): boolean {
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

function trustedLocalReviewComment(comment: RawComment, trustedAuthor: TrustedAuthorInput): LocalReviewMetadata | null {
  if (!authorIsTrusted(comment.author?.login, trustedAuthor)) return null;
  return parseLocalReviewMetadata(comment.body);
}

function laneReviewMarker(metadata: LaneReviewMetadata): string {
  return `<!-- ${LANE_REVIEW_MARKER_PREFIX}:${JSON.stringify(metadata)} -->`;
}

function parseAllLaneReviewMetadata(body: string | undefined): LaneReviewMetadata[] {
  const records: LaneReviewMetadata[] = [];
  const pattern = /<!--\s*qube-pr-review:(\{[\s\S]*?\})\s*-->/g;
  for (const match of (body ?? '').matchAll(pattern)) {
    const parsed = parseLaneReviewMetadata(match[0]);
    if (parsed) records.push(parsed);
  }
  return records;
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
    const expectedLanes = Array.isArray(parsed.expectedLanes)
      && parsed.expectedLanes.length > 0
      && parsed.expectedLanes.every(lane => typeof lane === 'string' && lane.trim() !== '')
      ? [...new Set(parsed.expectedLanes.map(lane => redact(String(lane).trim())))].sort()
      : undefined;
    const round = typeof parsed.round === 'string' && parsed.round.trim() !== '' ? redact(parsed.round.trim()) : undefined;
    const superseded = parsed.superseded === true ? true : undefined;
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
      expectedLanes,
      round,
      superseded,
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
      blockingFindingCount: typeof parsed.blockingFindingCount === 'number' && Number.isSafeInteger(parsed.blockingFindingCount) && parsed.blockingFindingCount >= 0 ? parsed.blockingFindingCount : undefined,
      findingDigest: typeof parsed.findingDigest === 'string' && parsed.findingDigest.trim() !== '' ? redact(parsed.findingDigest) : undefined,
    };
  } catch {
    return null;
  }
}

type TrustedAuthorInput = string | null | readonly string[] | 'any-valid-marker';

function trustedAuthorsList(trustedAuthor: TrustedAuthorInput): string[] {
  if (trustedAuthor === null || trustedAuthor === undefined || trustedAuthor === 'any-valid-marker') return [];
  if (typeof trustedAuthor === 'string') return trustedAuthor.trim() === '' ? [] : [trustedAuthor];
  return trustedAuthor.map(author => author.trim()).filter(author => author !== '');
}

function authorIsTrusted(login: string | null | undefined, trustedAuthor: TrustedAuthorInput): boolean {
  if (trustedAuthor === 'any-valid-marker') return true;
  const authors = trustedAuthorsList(trustedAuthor);
  if (authors.length === 0) return false;
  return authors.some(author => authorMatches(login ?? '', author));
}

function trustedLaneReviewComment(comment: RawComment, trustedAuthor: TrustedAuthorInput): LaneReviewMetadata | null {
  if (!authorIsTrusted(comment.author?.login, trustedAuthor)) return null;
  return parseLaneReviewMetadata(comment.body);
}

function laneReviewComments(comments: RawComment[], trustedAuthor: TrustedAuthorInput, headSha: string): LaneReviewComment[] {
  const records: LaneReviewComment[] = [];
  for (const comment of comments) {
    if (!authorIsTrusted(comment.author?.login, trustedAuthor)) continue;
    for (const metadata of parseAllLaneReviewMetadata(comment.body)) {
      records.push({ metadata, author: comment.author, body: comment.body ?? '', url: comment.url ? redact(comment.url) : null, stale: metadata.head !== headSha, publishedAt: comment.createdAt ?? null });
    }
  }
  return records;
}

function laneReviewReviews(reviews: RawReview[], trustedAuthor: TrustedAuthorInput, headSha: string): LaneReviewComment[] {
  const records: LaneReviewComment[] = [];
  if (trustedAuthor !== 'any-valid-marker' && trustedAuthorsList(trustedAuthor).length === 0) return [];
  for (const review of reviews) {
    if (!authorIsTrusted(review.author?.login, trustedAuthor)) continue;
    for (const metadata of parseAllLaneReviewMetadata(review.body)) {
      records.push({ metadata, author: review.author, body: review.body ?? '', url: review.url ? redact(review.url) : null, stale: metadata.head !== headSha, publishedAt: review.submittedAt ?? review.submitted_at ?? null });
    }
  }
  return records;
}

function isQubeLaneReviewDraft(review: RawReview, headSha: string): boolean {
  const metadata = parseLaneReviewMetadata(review.body);
  return metadata !== null && metadata.head === headSha;
}

function hasReviewComments(reviewComments: readonly RawReviewComment[], reviewId: string | number): boolean {
  const normalizedId = String(reviewId);
  return reviewComments.some(comment => comment.pull_request_review_id !== undefined && comment.pull_request_review_id !== null && String(comment.pull_request_review_id) === normalizedId);
}

function isEmptyStaleDraftReview(review: RawReview, headSha: string, reviewComments: readonly RawReviewComment[]): boolean {
  if (review.id === undefined || review.id === null) return false;
  if ((review.body ?? '').trim() !== '') return false;
  const commit = review.commit?.oid ?? review.commit_id ?? null;
  if (commit === headSha) return false;
  return !hasReviewComments(reviewComments, review.id);
}

function chronologicalLaneReviewRecords(input: { comments: RawComment[]; latestReviews: RawReview[]; trustedMarkerAuthor: TrustedAuthorInput; headSha: string; prNumber: number }): LaneReviewComment[] {
  return [
    ...laneReviewComments(input.comments, input.trustedMarkerAuthor, input.headSha),
    ...laneReviewReviews(input.latestReviews, input.trustedMarkerAuthor, input.headSha),
  ]
    .filter(record => record.metadata.prNumber === input.prNumber)
    .sort((left, right) => (Date.parse(left.publishedAt ?? '') - Date.parse(right.publishedAt ?? '')) || left.metadata.lane.localeCompare(right.metadata.lane));
}

function laneReviewRecords(input: { comments: RawComment[]; latestReviews: RawReview[]; trustedMarkerAuthor: TrustedAuthorInput; headSha: string; prNumber: number }): LaneReviewComment[] {
  const latest = new Map<string, LaneReviewComment>();
  // Superseded markers are history, not current state: they stay visible to
  // chronological readers (stats) but never represent a live lane verdict.
  const records = chronologicalLaneReviewRecords(input).filter(record => record.metadata.superseded !== true);
  for (const record of records) {
    // Per-issue identity: a PR closing multiple issues publishes the same
    // lane once per issue, and one issue's marker must never overwrite
    // another's on the latest-per-key read.
    const key = `${record.metadata.head}\0${record.metadata.lane}\0${record.metadata.issueNumber}`;
    const existing = latest.get(key);
    if (!existing || (Date.parse(record.publishedAt ?? '') || 0) >= (Date.parse(existing.publishedAt ?? '') || 0)) latest.set(key, record);
  }
  return [...latest.values()].sort((left, right) => (Date.parse(left.publishedAt ?? '') - Date.parse(right.publishedAt ?? '')) || left.metadata.lane.localeCompare(right.metadata.lane));
}

function laneReviewSummary(comment: LaneReviewComment): string {
  return `QUBE review (${comment.metadata.lane}): ${comment.metadata.recommendation} — ${comment.metadata.summary}`;
}

function expectedLaneNames(input: GitHubLaneReviewPublishInput): string[] {
  // A single-lane default would publish a marker whose expected set hides the
  // other active lanes and corrupts convergence stats; callers must always
  // declare the complete expected lane set for the head.
  if (!input.expectedLanes || input.expectedLanes.length === 0) {
    throw new Error('publish lane review failed. Likely cause: no expected lane set was provided. Next action: pass the complete expected lane set for this head when publishing lane feedback.');
  }
  return [...new Set(input.expectedLanes)].sort();
}

function stableLaneRunId(input: GitHubLaneReviewPublishInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      head: input.headSha,
      lane: input.lane,
      expectedLanes: expectedLaneNames(input),
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

function findingDigest(findings: readonly ReviewFinding[], completeness: string | null | undefined, withheld: GitHubLaneReviewPublishInput['withheld']): string {
  return createHash('sha256')
    .update(JSON.stringify({
      findings: findings.map(finding => ({
        id: finding.id,
        severity: finding.severity,
        location: finding.location ?? null,
        message: sanitizePublishedText(finding.message),
        suggestion: finding.suggestion ? sanitizePublishedText(finding.suggestion) : null,
        // Confidence renders in the published body, so a confidence-only
        // rescore must change the digest or republish-skip would leave the
        // stale display on the current head.
        confidence: typeof finding.confidence === 'number' ? finding.confidence : null,
      })),
      completeness: completeness && completeness.trim() !== '' ? sanitizePublishedText(completeness) : null,
      // Withheld counts render in the published body, so a synthesis change
      // that only moves counts must republish instead of skip-matching.
      withheld: withheld ?? null,
    }))
    .digest('hex')
    .slice(0, 16);
}

function laneReviewBody(
  input: GitHubLaneReviewPublishInput,
  bodyFindingsInput?: readonly ReviewFinding[],
  inlineCount = 0,
  publishKind: 'pull-request-review' | 'issue-comment' = 'pull-request-review',
): { body: string; marker: string; runId: string; bodyFindingCount: number; inlineCommentCount: number; blockingFindingCount: number } {
  const runId = stableLaneRunId(input);
  const summary = sanitizePublishedText(input.summary);
  const allFindings = normalizeLaneFindings(input);
  const digest = findingDigest(allFindings, input.completeness, input.withheld);
  const bodyFindings = bodyFindingsInput ?? allFindings;
  const inline = publishKind === 'issue-comment' ? 'issue-comment' : 'review-api';
  const metadata: LaneReviewMetadata = {
    version: 1,
    head: input.headSha,
    lane: input.lane,
    expectedLanes: expectedLaneNames(input),
    round: input.round,
    profile: input.profile,
    runId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    host: input.host,
    recommendation: input.recommendation,
    status: input.status,
    summary,
    inline,
    inlineCommentCount: inlineCount,
    bodyFindingCount: bodyFindings.length,
    blockingFindingCount: allFindings.filter(finding => finding.severity === 'blocking').length,
    findingDigest: digest,
  };
  const marker = laneReviewMarker(metadata);
  const transport = publishKind === 'issue-comment' ? 'issue-comment' : 'review-api';
  const profile = transport === 'issue-comment'
    ? { ...DEGRADED_REVIEW_RENDER_PROFILE, sanitizeText: sanitizePublishedText }
    : { ...GITHUB_REVIEW_RENDER_PROFILE, sanitizeText: sanitizePublishedText };
  const rendered = renderLaneReviewBody({
    marker,
    lane: {
      laneId: input.lane,
      status: input.status,
      recommendation: input.recommendation,
      summary,
      findings: allFindings,
      evidenceHeadSha: input.headSha,
      carriedForwardFromHeadSha: null,
      origin: 'local',
      withheld: input.withheld,
      host: input.host,
      profile: input.profile,
      evidencePath: input.evidencePath ?? undefined,
    },
    bodyFindings,
    inlineCount,
    transport,
    headSha: input.headSha,
    completeness: input.completeness ? truncatePublishedFinding(input.completeness, input.evidencePath) : null,
  }, profile);
  return { body: rendered.body, marker, runId, bodyFindingCount: bodyFindings.length, inlineCommentCount: inlineCount, blockingFindingCount: allFindings.filter(finding => finding.severity === 'blocking').length };
}

// A marker belongs to the same round when head, lane, PR, and round id all
// match; such a marker is updated in place on republish so one round never
// accumulates more than one marker per lane.
function sameRoundLaneMetadata(metadata: LaneReviewMetadata | null, input: GitHubLaneReviewPublishInput): boolean {
  return metadata !== null
    && metadata.superseded !== true
    && metadata.head === input.headSha
    && metadata.lane === input.lane
    && metadata.prNumber === input.prNumber
    && (metadata.round ?? null) === input.round;
}

function issueCommentIdFromUrl(url: string | null | undefined): string | null {
  const match = (url ?? '').match(/#issuecomment-(\d+)$/);
  return match ? match[1] : null;
}

function matchingCurrentLaneReview(item: ReviewItem, input: GitHubLaneReviewPublishInput, runId: string): boolean {
  const value = item.trustedMetadata.trustedLaneReviews;
  if (!Array.isArray(value)) return false;
  const expectedFindingDigest = findingDigest(normalizeLaneFindings(input), input.completeness, input.withheld);
  return value.some(review => {
    if (!isRecord(review)) return false;
    if (review.stale === true) return false;
    if (review.superseded === true) return false;
    if (review.inline !== 'review-api' && review.inline !== 'issue-comment') return false;
    return review.head === input.headSha
      && review.lane === input.lane
      && Array.isArray(review.expectedLanes)
      && JSON.stringify([...review.expectedLanes].sort()) === JSON.stringify(expectedLaneNames(input))
      && review.round === input.round
      && review.runId === runId
      && review.recommendation === input.recommendation
      && review.status === input.status
      && review.summary === sanitizePublishedText(input.summary)
      && review.findingDigest === expectedFindingDigest;
  });
}

function laneReviewMetadata(comments: RawComment[], latestReviews: RawReview[], trustedMarkerAuthor: TrustedAuthorInput, headSha: string, prNumber: number, preserveHistory = false): JsonObject[] {
  const records = preserveHistory
    ? chronologicalLaneReviewRecords({ comments, latestReviews, trustedMarkerAuthor, headSha, prNumber })
    : laneReviewRecords({ comments, latestReviews, trustedMarkerAuthor, headSha, prNumber });
  return records.map(comment => {
    const metadata = comment.metadata;
    return {
      head: metadata.head,
      lane: metadata.lane,
      expectedLanes: metadata.expectedLanes ?? null,
      round: metadata.round ?? null,
      superseded: metadata.superseded === true,
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
      blockingFindingCount: metadata.blockingFindingCount ?? null,
      publishedAt: comment.publishedAt,
      findingDigest: metadata.findingDigest ?? null,
      stale: metadata.head !== headSha,
      author: comment.author?.login ?? null,
      url: comment.url ? redact(comment.url) : null,
    };
  });
}

function malformedTrustedLaneMarkerCount(comments: RawComment[], reviews: RawReview[], trustedMarkerAuthor: TrustedAuthorInput): number {
  const bodies = [
    ...comments.filter(comment => authorIsTrusted(comment.author?.login, trustedMarkerAuthor)).map(comment => comment.body),
    ...reviews.filter(review => authorIsTrusted(review.author?.login ?? review.user?.login, trustedMarkerAuthor)).map(review => review.body),
  ];
  return bodies.filter(body => /<!--\s*qube-pr-review:/.test(body ?? '') && parseLaneReviewMetadata(body) === null).length;
}

function laneMarkerReviews(rawPr: RawPrView): RawReview[] {
  return rawPr.reviews && rawPr.reviews.length > 0 ? rawPr.reviews : rawPr.latestReviews ?? [];
}

function localReviewComments(comments: RawComment[], trustedAuthor: TrustedAuthorInput, headSha: string): LocalReviewComment[] {
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

// Normalizes GitHub's review state vocabulary into the provider-agnostic
// recommendation vocabulary the core participant model reads; COMMENTED and
// DISMISSED carry no verdict (neither approving nor blocking) so they read
// as null rather than a synthesized recommendation.
function normalizedReviewState(state: string | undefined): 'approve' | 'request-changes' | 'pending' | 'inconclusive' | null {
  if (state === 'APPROVED') return 'approve';
  if (state === 'CHANGES_REQUESTED') return 'request-changes';
  if (state === 'PENDING') return 'pending';
  return null;
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

function repositoryRefFromName(nameWithOwner: string | undefined): { owner: string; name: string } | undefined {
  if (!nameWithOwner) return undefined;
  const [owner, name] = nameWithOwner.split('/');
  if (!owner || !name) return undefined;
  return { owner, name };
}

function findingInlineBody(finding: ReviewFinding, laneId: string, context: { headSha?: string; repository?: { owner: string; name: string } } = {}): string {
  return renderInlineReviewComment(
    {
      laneId,
      finding,
      anchored: Boolean(finding.location && typeof finding.location.line === 'number'),
      headSha: context.headSha,
      repository: context.repository,
    },
    { ...GITHUB_REVIEW_RENDER_PROFILE, sanitizeText: sanitizePublishedText },
  );
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

function publishedReviewId(result: GhRunResult): string | null {
  try {
    const parsed = parseGhJson<RawCreatedPullReview>(result.stdout, 'gh api create pull request review', isCreatedPullReview);
    if (parsed.id !== undefined && parsed.id !== null && String(parsed.id).trim() !== '') return String(parsed.id);
  } catch {
    // Fall through.
  }
  return null;
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

function pendingReviewConflict(result: GhRunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return result.exitCode !== 0 && /one pending review per pull request/i.test(text);
}

function maybePendingReviewConflict(result: GhRunResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`;
  return pendingReviewConflict(result) || (result.exitCode !== 0 && /\bHTTP 422\b/i.test(text) && !/\bvalidation failed\b|\bcannot approve own pull request\b/i.test(text));
}

function reviewAuthor(review: RawReview): string {
  return actorName(review.author ?? review.user);
}

function unresolvedAppPublisherReason(publisher: ResolvedGitHubReviewPublisher): string | null {
  if (publisher.identity.mode === 'github-app' && !publisher.identity.login) {
    return publisher.identity.fallbackReason
      ?? 'GitHub App publisher identity lookup did not resolve the bot login; formal review events are withheld.';
  }
  return null;
}

function trustedPublisherLogin(publisher: ResolvedGitHubReviewPublisher, fallbackLogin: string | null): string | null {
  if (publisher.identity.mode === 'github-app') return publisher.identity.login;
  return publisher.identity.login ?? fallbackLogin;
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
  let currentDestinationPath: string | null = null;
  let currentSourcePath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).trim();
      currentSourcePath = rawPath === '/dev/null' ? null : normalizeDiffPath(rawPath);
      if (currentSourcePath && !sourceLinesByPath.has(currentSourcePath)) sourceLinesByPath.set(currentSourcePath, new Set());
      continue;
    }
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      currentDestinationPath = rawPath === '/dev/null' ? null : normalizeDiffPath(rawPath);
      if (currentDestinationPath && !destinationLinesByPath.has(currentDestinationPath)) destinationLinesByPath.set(currentDestinationPath, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      continue;
    }
    if (line.startsWith('diff --git')) {
      currentDestinationPath = null;
      currentSourcePath = null;
      continue;
    }
    if (oldLine <= 0 && newLine <= 0) continue;
    if (line.startsWith('+')) {
      if (currentDestinationPath && newLine > 0) destinationLinesByPath.get(currentDestinationPath)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith('-')) {
      if (currentSourcePath && oldLine > 0) sourceLinesByPath.get(currentSourcePath)?.add(oldLine);
      oldLine += 1;
    } else {
      if (currentDestinationPath && newLine > 0) destinationLinesByPath.get(currentDestinationPath)?.add(newLine);
      if (currentSourcePath && oldLine > 0) sourceLinesByPath.get(currentSourcePath)?.add(oldLine);
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

function publishedInlineFinding(finding: ReviewFinding, diffIndex?: ReviewDiffIndex | null): ReviewFinding | null {
  const span = diffIndex
    ? clipReviewAnchorSpanToDiff(finding, diffIndex)
    : clipReviewAnchorSpan(finding);
  if (!span) return null;
  return findingWithPublishedAnchor(finding, span);
}

function inlineFindingComment(location: ReviewFinding['location'], body: string): JsonObject | null {
  if (!location || typeof location.line !== 'number') return null;
  const span = clipReviewAnchorSpan({ id: 'anchor', severity: 'advisory', message: 'anchor', location });
  if (!span) return null;
  const side = location.side === 'source' ? 'LEFT' : 'RIGHT';
  const comment: Record<string, JsonValue> = {
    path: normalizeDiffPath(location.path),
    line: span.endLine,
    side,
    body,
  };
  if (span.endLine !== span.line) {
    comment.start_line = span.line;
    comment.start_side = side;
  }
  return comment;
}

function inlineReviewComment(finding: ReviewFinding, laneId: string, context: { headSha?: string; repository?: { owner: string; name: string }; diffIndex?: ReviewDiffIndex | null } = {}): JsonObject | null {
  const published = publishedInlineFinding(finding, context.diffIndex);
  if (!published) return null;
  return inlineFindingComment(published.location, findingInlineBody(published, laneId, context));
}

function inlineSummaryReviewComment(entry: GitHubRoundSummaryInlineFinding, context: { headSha?: string; repository?: { owner: string; name: string }; diffIndex?: ReviewDiffIndex | null } = {}): JsonObject | null {
  const published = publishedInlineFinding(entry.finding, context.diffIndex);
  if (!published) return null;
  const body = context.diffIndex
    ? findingInlineBody(published, entry.laneId, context)
    : entry.commentBody;
  return inlineFindingComment(published.location, body);
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
    ...(input.publisher ? { publisher: publicPublisherIdentity(input.publisher) } : {}),
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

function normalizePr(raw: RawPrView, mergeUiState: RawMergeUiState | null = null): GitHubReviewPullRequest {
  return {
    number: raw.number,
    title: redact(raw.title),
    state: raw.state,
    url: redact(raw.url),
    headRefOid: redact(raw.headRefOid ?? 'UNKNOWN'),
    authorLogin: raw.author?.login ? redact(raw.author.login) : null,
    reviewDecision: rawReviewDecision(raw.reviewDecision),
    mergeStateStatus: raw.mergeStateStatus ?? 'UNKNOWN',
    mergeable: raw.mergeable ?? 'UNKNOWN',
    isDraft: raw.isDraft ?? false,
    closedAt: raw.mergedAt ?? raw.closedAt ?? null,
    mergeUiHeadline: normalizeProviderText(mergeUiState?.viewerMergeHeadlineText),
    mergeUiBody: normalizeProviderText(mergeUiState?.viewerMergeBodyText),
    viewerCannotUpdateReasons: (mergeUiState?.viewerCannotUpdateReasons ?? []).map(reason => normalizeProviderText(reason)).filter((reason): reason is string => reason !== null),
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

function feedback(raw: { comments: RawComment[]; latestReviews: RawReview[]; reviewComments: RawReviewComment[]; unresolvedThreads: RawThreadNode[]; trustedMarkerAuthor: TrustedAuthorInput; headRefOid: string; prNumber: number; reviewAgents?: readonly string[] }): ReviewFeedback[] {
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
  for (const laneReview of laneReviewRecords({ comments: raw.comments, latestReviews: raw.latestReviews, trustedMarkerAuthor: raw.trustedMarkerAuthor, headSha: raw.headRefOid, prNumber: raw.prNumber })) {
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
    if (authorIsTrusted(review.author?.login, raw.trustedMarkerAuthor) && (parseLaneReviewMetadata(review.body) || isSelfAuthoredReviewBody(review.body))) continue;
    if (isStaleChangeRequest(review, raw.headRefOid, raw.unresolvedThreads)) continue;
    if (raw.unresolvedThreads.length === 0 && isResolvedProviderReviewSummary(review.body)) continue;
    if (state === 'CHANGES_REQUESTED' || (state === 'COMMENTED' && !isNonActionableSummary(review.body, review.author?.login, { agents: raw.reviewAgents }))) items.push({ source: 'review', author: actorName(review.author), state, summary: summarize(review.body), url: review.url ? redact(review.url) : null, trust: 'untrusted' });
  }
  for (const comment of raw.comments) {
    const body = comment.body ?? '';
    if (trustedLocalReviewComment(comment, raw.trustedMarkerAuthor)) continue;
    if (trustedLaneReviewComment(comment, raw.trustedMarkerAuthor)) continue;
    if (authorIsTrusted(comment.author?.login, raw.trustedMarkerAuthor) && isSelfAuthoredReviewBody(body)) continue;
    if ((!trustedMarkerComment(comment, raw.trustedMarkerAuthor) || !body.includes(`<!-- ${MARKER_PREFIX}:`)) && !isNonActionableSummary(body, comment.author?.login, { agents: raw.reviewAgents })) items.push({ source: 'comment', author: actorName(comment.author), summary: summarize(comment.body), url: comment.url ? redact(comment.url) : null, state: null, trust: 'untrusted' });
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

function mergeUiReason(pr: GitHubReviewPullRequest): string | null {
  const parts = [pr.mergeUiHeadline, pr.mergeUiBody, ...pr.viewerCannotUpdateReasons].filter((part): part is string => typeof part === 'string' && part.trim() !== '');
  if (parts.length === 0) return null;
  return parts.join(' ');
}

function mergeUiMentionsReviewConversation(pr: GitHubReviewPullRequest): boolean {
  const text = mergeUiReason(pr)?.toLowerCase() ?? '';
  return /\bconversation\b/.test(text) && /\b(resolve|resolved|unresolved)\b/.test(text);
}

function mergeBlockerSummary(pr: GitHubReviewPullRequest, fallback: string): string {
  const reason = mergeUiReason(pr);
  return reason ? `GitHub reports merge is blocked: ${reason}.` : fallback;
}

function mergeBlockers(raw: { pr: GitHubReviewPullRequest; unresolvedThreads: RawThreadNode[]; checks: GateEvidence[] }): ReviewMergeBlock[] {
  const blockers: ReviewMergeBlock[] = [];
  if (raw.unresolvedThreads.length > 0) {
    blockers.push({
      reason: 'unresolved-review-thread',
      summary: mergeBlockerSummary(raw.pr, `GitHub merge is blocked by ${raw.unresolvedThreads.length} unresolved code conversation${raw.unresolvedThreads.length === 1 ? '' : 's'}.`),
      url: raw.pr.url,
    });
  }
  if (raw.unresolvedThreads.length === 0 && raw.pr.mergeStateStatus === 'BLOCKED' && mergeUiMentionsReviewConversation(raw.pr)) {
    blockers.push({
      reason: 'unresolved-review-thread',
      summary: mergeBlockerSummary(raw.pr, 'GitHub merge is blocked by an unresolved code conversation.'),
      url: raw.pr.url,
    });
  }
  if (raw.pr.isDraft) blockers.push({ reason: 'draft', summary: 'GitHub merge is blocked while the pull request is a draft.', url: raw.pr.url });
  if (raw.pr.reviewDecision === 'REVIEW_REQUIRED') blockers.push({ reason: 'review-required', summary: 'GitHub reports a required review is still missing.', url: raw.pr.url });
  if (raw.pr.reviewDecision === 'CHANGES_REQUESTED') blockers.push({ reason: 'changes-requested', summary: 'GitHub reports requested changes on the pull request.', url: raw.pr.url });
  if (raw.checks.some(check => check.result === 'unknown')) blockers.push({ reason: 'checks-pending', summary: 'One or more GitHub checks are still pending or unknown.', url: raw.pr.url });
  if (raw.checks.some(check => check.result === 'failed')) blockers.push({ reason: 'checks-failed', summary: 'One or more GitHub checks failed.', url: raw.pr.url });
  if (raw.pr.mergeable === 'CONFLICTING') blockers.push({ reason: 'conflict', summary: 'GitHub reports merge conflicts.', url: raw.pr.url });
  if (raw.pr.mergeStateStatus === 'BLOCKED' && blockers.length === 0) blockers.push({ reason: 'merge-state-blocked', summary: mergeBlockerSummary(raw.pr, 'GitHub reports mergeStateStatus=BLOCKED; inspect provider details for repository rules.'), url: raw.pr.url });
  return blockers;
}

function metadata(raw: { pr: GitHubReviewPullRequest; reviewRequests: string[]; comments: RawComment[]; latestReviews: RawReview[]; laneReviews: RawReview[]; unresolvedThreads: RawThreadNode[]; unavailable: string[]; trustedMarkerAuthor: TrustedAuthorInput; checks: GateEvidence[] }): JsonObject {
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
  const trustedLaneReviews = laneReviewMetadata(raw.comments, raw.laneReviews, raw.trustedMarkerAuthor, raw.pr.headRefOid, raw.pr.number);
  const conversations = reviewConversations(raw.unresolvedThreads);
  const blockers = mergeBlockers({ pr: raw.pr, unresolvedThreads: raw.unresolvedThreads, checks: raw.checks });
  return {
    number: raw.pr.number,
    headRefOid: raw.pr.headRefOid,
    mergeStateStatus: raw.pr.mergeStateStatus,
    mergeUiHeadline: raw.pr.mergeUiHeadline,
    mergeUiBody: raw.pr.mergeUiBody,
    viewerCannotUpdateReasons: raw.pr.viewerCannotUpdateReasons,
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
    latestReviews: raw.latestReviews.map(review => ({ author: review.author?.login ?? null, commitOid: review.commit?.oid ?? null, state: normalizedReviewState(review.state) })),
    localReviews,
    trustedLocalReviews,
    trustedLaneReviews,
    trustedRoundSummary: currentRoundSummaryPointer(raw.comments, raw.laneReviews, raw.trustedMarkerAuthor, raw.pr.number, raw.pr.headRefOid),
    unavailable: raw.unavailable,
    trustedMarkerAuthor: raw.trustedMarkerAuthor === 'any-valid-marker'
      ? 'any-valid-marker'
      : Array.isArray(raw.trustedMarkerAuthor)
        ? raw.trustedMarkerAuthor[0] ?? null
        : raw.trustedMarkerAuthor,
    trustedMarkerAuthors: raw.trustedMarkerAuthor === 'any-valid-marker'
      ? ['any-valid-marker']
      : trustedAuthorsList(raw.trustedMarkerAuthor),
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

function makeRequestAction(input: { item: ReviewItem; name: string; requestedForHead: boolean; staleRequest: boolean; pending: boolean; policy: ReviewForgePolicy; installedAgents?: readonly string[] }): Action {
  const agent = resolveReviewAgent(input.name, { agents: input.installedAgents });
  const trigger = agent?.triggerFor(input.name) ?? triggerFor(input.name);
  const handle = normalizeHandle(input.name);
  const id = reviewerId(input.name);
  const headRefOid = getJsonString(input.item.trustedMetadata.headRefOid) ?? 'UNKNOWN';
  const skipped = input.requestedForHead || input.pending;
  const hostParticipant = id === reviewerId(QUBE_REVIEW_SERVICE_NAME);
  const body = trigger === 'github-reviewer' || hostParticipant
    ? (agent?.reviewerMarkerBodyFor(input.name, headRefOid) ?? reviewerMarkerBodyFor(input.name, headRefOid))
    : (agent?.commentBodyFor(input.name, input.policy, headRefOid) ?? commentBodyFor(input.name, input.policy, headRefOid));
  return createAction({
    id: `${skipped ? 'skip-reviewer' : 'request-review'}:${id}`,
    kind: 'request-review',
    target: { kind: 'review-item', id: input.item.key.id },
    mutation: 'review-provider',
    description: skipped ? `${handle} is already requested or has reviewed the current PR head.` : trigger === 'github-reviewer' ? `Request ${handle} as a GitHub pull request reviewer and record an idempotency marker for head ${headRefOid}.` : hostParticipant ? `Post an idempotent marker-only PR comment recording the ${handle} host review request for head ${headRefOid}.` : `Post an idempotent PR comment to trigger ${handle} for head ${headRefOid}.`,
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

export class GitHubReviewForgeProvider implements ReviewForgeStatsProvider {
  readonly id = 'github' as const;
  /** Process-local cache of distinct publisher login for trust matching; never stores tokens. */
  private cachedPublisherLogin: string | null | undefined = undefined;
  private currentLoginPromise: Promise<string> | null = null;
  private repositoryIdentityPromise: Promise<{ nameWithOwner: string; url: string }> | null = null;

  constructor(private readonly options: GitHubReviewProviderOptions = {}) {}

  capabilities(): ReviewForgeCapabilities & { readonly reviewStats: true } { return { loadReview: true, loadReviewSnapshot: true, reviewStats: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true, publishLaneReview: true, publishLaneReviewInline: true, resolveReviewThreads: true, publishRoundReviewSummary: true }; }

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
      return { item: this.reviewItem(raw, [], [], [], [], [], [], [], null, [], null), pr, warning: null };
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

  async listRecentPullRequests(options: { limit: number }): Promise<GitHubReviewPullRequest[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_RECENT_PR_LIMIT) {
      throw new Error(`list recent GitHub pull requests failed: limit must be an integer from 1 to ${MAX_RECENT_PR_LIMIT}. Use a bounded review stats window.`);
    }
    const candidateLimit = Math.min(MAX_RECENT_PR_CANDIDATES, Math.max(options.limit + 1, options.limit * 2));
    const result = await runGh([
      'pr',
      'list',
      '--state',
      'all',
      '--search',
      'is:closed sort:updated-desc',
      '--limit',
      String(candidateLimit),
      '--json',
      RECENT_PR_FIELDS,
    ], this.options);
    ensureGhSuccess('gh pr list recent merged or closed pull requests', result);
    const listed = parseGhJson<RawPrView[]>(result.stdout, 'gh pr list recent merged or closed pull requests', isRawPrList);
    const ordered = listed
      .filter(pr => pr.state === 'MERGED' || pr.state === 'CLOSED')
      .sort((left, right) => (Date.parse(right.mergedAt ?? right.closedAt ?? '') || 0) - (Date.parse(left.mergedAt ?? left.closedAt ?? '') || 0) || right.number - left.number);
    const exhausted = listed.length < candidateLimit;
    const cutoff = ordered.length >= options.limit ? Date.parse(ordered[options.limit - 1].mergedAt ?? ordered[options.limit - 1].closedAt ?? '') : Number.NaN;
    const lastUpdatedAt = Date.parse(listed.at(-1)?.updatedAt ?? '');
    if (!exhausted && !(Number.isFinite(cutoff) && Number.isFinite(lastUpdatedAt) && lastUpdatedAt <= cutoff)) {
      throw new Error(`list recent GitHub pull requests failed: one bounded listing pass over ${candidateLimit} candidates cannot prove the latest closure-time window. Use a smaller window or a provider with native closure-time ordering.`);
    }
    return ordered.slice(0, options.limit).map(pr => normalizePr(pr));
  }

  async loadLaneReviewHistory(prNumber: number): Promise<{ trustedLaneReviews: JsonObject[]; unavailableReason: string | null }> {
    if (this.configuredPublisherLoginMissing()) {
      return { trustedLaneReviews: [], unavailableReason: 'Configured distinct QUBE review publisher login was unavailable; trusted lane marker authors could not be identified safely.' };
    }
    const repository = await this.getRepositoryIdentity();
    const [owner, repo] = repository.nameWithOwner.split('/');
    if (!owner || !repo) {
      return { trustedLaneReviews: [], unavailableReason: 'GitHub repository identity was malformed; bounded lane review history could not be loaded.' };
    }
    const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { headRefOid comments(first: ${MAX_LANE_HISTORY_RECORDS}) { nodes { author { login } body url createdAt } pageInfo { hasNextPage endCursor } } reviews(first: ${MAX_LANE_HISTORY_RECORDS}) { nodes { id author { login } body state submittedAt url commit { oid } } pageInfo { hasNextPage endCursor } } } } }`;
    const result = await runGh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${prNumber}`, '-f', `query=${query}`], this.options);
    ensureGhSuccess(`gh api graphql bounded review stats metadata for PR ${prNumber}`, result);
    const rawPr = parseGhJson<RawLaneHistoryResponse>(result.stdout, `gh api graphql bounded review stats metadata for PR ${prNumber}`, isRawLaneHistoryResponse).data?.repository?.pullRequest;
    if (!rawPr) {
      return { trustedLaneReviews: [], unavailableReason: 'GitHub pull request lane review history was unavailable.' };
    }
    if (rawPr.comments?.pageInfo?.hasNextPage || rawPr.reviews?.pageInfo?.hasNextPage) {
      return { trustedLaneReviews: [], unavailableReason: `Trusted QUBE lane review history exceeded the bounded ${MAX_LANE_HISTORY_RECORDS}-comment or ${MAX_LANE_HISTORY_RECORDS}-review read and was not counted partially.` };
    }
    const trustedAuthors = await this.trustedAuthorsForLoad();
    if (trustedAuthors.length === 0) {
      return { trustedLaneReviews: [], unavailableReason: 'Trusted QUBE lane review author identity was unavailable from GitHub.' };
    }
    const comments = rawPr.comments?.nodes ?? [];
    const reviews = rawPr.reviews?.nodes ?? [];
    const malformedCount = malformedTrustedLaneMarkerCount(comments, reviews, trustedAuthors);
    if (malformedCount > 0) {
      return {
        trustedLaneReviews: [],
        unavailableReason: `Trusted QUBE lane review metadata contained ${malformedCount} malformed marker${malformedCount === 1 ? '' : 's'}.`,
      };
    }
    return {
      trustedLaneReviews: laneReviewMetadata(comments, reviews, trustedAuthors, rawPr.headRefOid ?? 'UNKNOWN', prNumber, true),
      unavailableReason: null,
    };
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
    let mergeUiState: RawMergeUiState | null = null;
    try {
      const repository = await this.getRepositoryIdentity();
      ciDiagnostics = await this.loadCiDiagnostics(repository.nameWithOwner, rawPr);
      try {
        mergeUiState = await this.getMergeUiState(repository.nameWithOwner, prNumber);
      } catch (error: unknown) {
        unavailable.push(`Merge UI state unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
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
    const trustedAuthors = await this.trustedAuthorsForLoad();
    const comments = rawPr.comments ?? [];
    const latestReviews = rawPr.latestReviews ?? [];
    const laneReviews = laneMarkerReviews(rawPr);
    const reviewRequests = reviewRequestNames(rawPr.reviewRequests);
    const pr = normalizePr(rawPr, mergeUiState);
    return {
      item: this.reviewItem(rawPr, reviewRequests, comments, latestReviews, laneReviews, reviewComments, unresolvedThreads, unavailable, trustedAuthors, ciDiagnostics, mergeUiState),
      pr,
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
    const names = configuredReviewerNames(policy, options.activeLanes ?? []);
    const actions = names.map(name => {
      const agent = resolveReviewAgent(name, { agents: names });
      const trigger = agent?.triggerFor(name) ?? triggerFor(name);
      const handle = normalizeHandle(name);
      const requestedForHead = trigger === 'github-reviewer' ? hasMarker(comments, name, headSha, trustedMarkerAuthor) || isCurrentReview(latestReviews, handle, headSha) : hasMarker(comments, name, headSha, trustedMarkerAuthor);
      const pending = isPendingRequest(reviewRequests, handle);
      const staleRequest = trigger === 'github-reviewer' ? !requestedForHead && !pending && (hasStaleMarker(comments, name, headSha, trustedMarkerAuthor) || hasStaleReview(latestReviews, handle, headSha)) : !requestedForHead && hasStaleMarker(comments, name, headSha, trustedMarkerAuthor);
      return makeRequestAction({ item, name, requestedForHead, staleRequest, pending, policy, installedAgents: names });
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

  async describeReviewPublisher(prAuthorLogin?: string | null, options: { mint?: boolean } = {}): Promise<GitHubReviewPublisherIdentity> {
    const resolved = await resolveGitHubReviewPublisher(this.options.publisher ?? null, {
      cwd: this.options.cwd,
      exec: this.options.exec,
      prAuthorLogin: prAuthorLogin ?? null,
      mint: options.mint === true,
    });
    return publicPublisherIdentity(resolved.identity);
  }

  async publishLaneReviewFeedbackForPullRequest(input: GitHubLaneReviewPublishInput): Promise<GitHubLaneReviewPublishResult> {
    const allFindings = normalizeLaneFindings(input);
    const plannedBody = laneReviewBody(input, allFindings, 0);
    let comments: RawComment[];
    let laneReviews: RawReview[];
    let trustedMarkerAuthor: string;
    let repositoryName: string;
    let publisher: ResolvedGitHubReviewPublisher = {
      accessToken: null,
      identity: emptyPublisherIdentity(),
    };
    try {
      const repository = await this.getRepositoryIdentity();
      repositoryName = repository.nameWithOwner;
      comments = await this.getIssueComments(repository.nameWithOwner, input.prNumber);
      const rawPr = await this.getPullRequest(input.prNumber);
      // Lane feedback must bind to the PR's current head: an unobservable
      // head cannot prove freshness, and a caller-supplied head the PR has
      // advanced past must fail instead of publishing review state against
      // an obsolete commit.
      const observedHead = typeof rawPr.headRefOid === 'string' ? rawPr.headRefOid : '';
      if (observedHead === '') {
        throw new Error(`pull request #${input.prNumber} did not report a head SHA, so the publish head cannot be verified; fail closed and retry once GitHub reports the current head.`);
      }
      if (observedHead !== input.headSha) {
        throw new Error(`pull request #${input.prNumber} head changed from ${input.headSha} to ${observedHead}; rerun pr gate for the current PR head.`);
      }
      laneReviews = laneMarkerReviews(rawPr);
      const prAuthorLogin = rawPr.author?.login ?? null;
      publisher = await resolveGitHubReviewPublisher(this.options.publisher ?? null, {
        cwd: this.options.cwd,
        exec: this.options.exec,
        prAuthorLogin,
        mint: true,
      });
      if (publisher.identity.login) this.cachedPublisherLogin = publisher.identity.login;
      const identityFailure = unresolvedAppPublisherReason(publisher);
      if (identityFailure) {
        return localReviewPublishResult({
          status: 'failed',
          runId: plannedBody.runId,
          marker: plannedBody.marker,
          body: plannedBody.body,
          publishKind: 'pull-request-review',
          inlineCommentCount: plannedBody.inlineCommentCount,
          bodyFindingCount: plannedBody.bodyFindingCount,
          publisher: publisher.identity,
          failure: identityFailure,
          nextAction: `Resolve the GitHub App bot login, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
        });
      }
      trustedMarkerAuthor = trustedPublisherLogin(publisher, await this.currentLogin()) ?? '';
      if (trustedMarkerAuthor === '') {
        return localReviewPublishResult({
          status: 'failed',
          runId: plannedBody.runId,
          marker: plannedBody.marker,
          body: plannedBody.body,
          publishKind: 'pull-request-review',
          inlineCommentCount: plannedBody.inlineCommentCount,
          bodyFindingCount: plannedBody.bodyFindingCount,
          publisher: publisher.identity,
          failure: 'Publisher identity login is unresolved; formal review events are withheld.',
          nextAction: `Resolve the publisher login, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
        });
      }
    } catch (error: unknown) {
      return localReviewPublishResult({
        status: 'failed',
        runId: plannedBody.runId,
        marker: plannedBody.marker,
        body: plannedBody.body,
        publishKind: 'pull-request-review',
        inlineCommentCount: plannedBody.inlineCommentCount,
        bodyFindingCount: plannedBody.bodyFindingCount,
        publisher: publisher.identity,
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
      trustedMetadata: { trustedLaneReviews: laneReviewMetadata(comments, laneReviews, trustedMarkerAuthor, input.headSha, input.prNumber) },
    });
    if (matchingCurrentLaneReview(trustedItem, input, plannedBody.runId)) {
      return localReviewPublishResult({ status: 'skipped', runId: plannedBody.runId, marker: plannedBody.marker, body: null, publisher: publisher.identity, nextAction: `Provider-visible lane review for ${input.lane} is already published for this PR head and run id.` });
    }
    if (input.dryRun) {
      return localReviewPublishResult({
        status: 'planned',
        runId: plannedBody.runId,
        marker: plannedBody.marker,
        body: plannedBody.body,
        publishKind: publisher.identity.formalEventCapability ? 'pull-request-review' : 'issue-comment',
        inlineCommentCount: 0,
        bodyFindingCount: plannedBody.bodyFindingCount,
        publisher: publisher.identity,
        nextAction: `Rerun \`aie pr review publish <pr> --lane ${input.lane}\` without --dry-run to publish provider-visible pull request review feedback.`,
      });
    }

    const publishToken = publisher.accessToken;
    const ghOptions = { ...this.options, token: publishToken ?? undefined };

    // Revalidate the PR head immediately before each mutation. All the async
    // prep above (identity resolution, diff fetch, payload build) and any
    // retry widens the window in which the PR can advance, so the check must
    // run as the last step before every create/POST, not once upfront.
    const assertHeadUnchanged = async (): Promise<void> => {
      const freshPr = await this.getPullRequest(input.prNumber);
      const freshHead = typeof freshPr.headRefOid === 'string' ? freshPr.headRefOid : '';
      if (freshHead === '' || freshHead !== input.headSha) {
        throw new Error(freshHead === ''
          ? `pull request #${input.prNumber} stopped reporting a head SHA before publication; fail closed and rerun pr gate.`
          : `pull request #${input.prNumber} head changed from ${input.headSha} to ${freshHead} before publication; rerun pr gate for the current PR head.`);
      }
    };

    // One provider marker per lane per round: a same-round republish with
    // changed content updates the existing marker in place instead of
    // appending a second one (exact duplicates already skip-matched above).
    // An update failure fails closed rather than creating round noise.
    let existingReviews: RawReview[];
    try {
      existingReviews = await this.getPullRequestReviews(repositoryName, input.prNumber);
    } catch (error: unknown) {
      return localReviewPublishResult({
        status: 'failed',
        runId: plannedBody.runId,
        marker: plannedBody.marker,
        body: plannedBody.body,
        publishKind: 'pull-request-review',
        inlineCommentCount: plannedBody.inlineCommentCount,
        bodyFindingCount: plannedBody.bodyFindingCount,
        publisher: publisher.identity,
        failure: redact(error instanceof Error ? error.message : String(error)),
        nextAction: `Fix GitHub review list access, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`. A failed prior-review fetch does not create a new review event.`,
      });
    }
    const existingRoundReview = existingReviews
      .find(review => review.id !== undefined && review.id !== null
        && authorIsTrusted(reviewAuthor(review), trustedMarkerAuthor)
        && sameRoundLaneMetadata(parseLaneReviewMetadata(review.body), input));
    if (existingRoundReview) {
      const existingMetadata = parseLaneReviewMetadata(existingRoundReview.body);
      const verdictUnchanged = existingMetadata !== null
        && existingMetadata.recommendation === input.recommendation
        && existingMetadata.status === input.status;
      if (verdictUnchanged) {
        const updateBody = laneReviewBody(input, allFindings, 0);
        const payloadPath = reviewPayloadPath({ body: updateBody.body });
        try {
          await assertHeadUnchanged();
          const updateResult = await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${String(existingRoundReview.id)}`, '--method', 'PUT', '--input', payloadPath], ghOptions);
          if (updateResult.exitCode !== 0) throw new Error(updateResult.stderr || updateResult.stdout || 'gh api pull request review update failed');
          const reviewUrl = publishedReviewUrl(updateResult) ?? (existingRoundReview.url ? redact(String(existingRoundReview.url)) : null);
          return localReviewPublishResult({
            status: 'published',
            runId: updateBody.runId,
            marker: updateBody.marker,
            body: updateBody.body,
            url: reviewUrl,
            reviewUrl,
            publishKind: 'pull-request-review',
            inlineCommentCount: 0,
            bodyFindingCount: updateBody.bodyFindingCount,
            publisher: publisher.identity,
            nextAction: `Provider-visible lane review for ${input.lane} was updated in place for its round; rerun PR view/gate to inspect provider state.`,
          });
        } catch (error: unknown) {
          return localReviewPublishResult({
            status: 'failed',
            runId: updateBody.runId,
            marker: updateBody.marker,
            body: updateBody.body,
            publishKind: 'pull-request-review',
            bodyFindingCount: updateBody.bodyFindingCount,
            publisher: publisher.identity,
            failure: redact(error instanceof Error ? error.message : String(error)),
            nextAction: `Fix GitHub review update permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`; a second same-round marker is never created.`,
          });
        } finally {
          cleanupReviewPayload(payloadPath);
        }
      }
      // The verdict changed within the round: a body PUT cannot change the
      // formal review event, so the old review is tombstoned and a fresh
      // review with the correct event is created below. The tombstone keeps
      // a superseded marker preserving the replaced verdict - history readers
      // (convergence stats) still see the original blocking evidence while
      // live read paths ignore it - so the round ends with exactly one live
      // marker and no rework history is destroyed. A tombstone failure fails
      // closed.
      const tombstone = [
        laneReviewMarker({ ...existingMetadata as LaneReviewMetadata, superseded: true }),
        '',
        `This ${input.lane} review was superseded within its review round by an updated verdict; its inline comments may reference superseded findings. See the latest QUBE ${input.lane} review for this round.`,
      ].join('\n');
      const tombstonePath = reviewPayloadPath({ body: tombstone });
      try {
        await assertHeadUnchanged();
        const tombstoneResult = await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${String(existingRoundReview.id)}`, '--method', 'PUT', '--input', tombstonePath], ghOptions);
        if (tombstoneResult.exitCode !== 0) throw new Error(tombstoneResult.stderr || tombstoneResult.stdout || 'gh api pull request review tombstone failed');
      } catch (error: unknown) {
        return localReviewPublishResult({
          status: 'failed',
          runId: plannedBody.runId,
          marker: plannedBody.marker,
          body: plannedBody.body,
          publishKind: 'pull-request-review',
          bodyFindingCount: plannedBody.bodyFindingCount,
          publisher: publisher.identity,
          failure: redact(error instanceof Error ? error.message : String(error)),
          nextAction: `Fix GitHub review update permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`; a second live same-round marker is never created.`,
        });
      } finally {
        cleanupReviewPayload(tombstonePath);
      }
    }
    const existingRoundComment = comments
      .map(comment => ({ commentId: issueCommentIdFromUrl(comment.url), metadata: trustedLaneReviewComment(comment, trustedMarkerAuthor) }))
      .find(entry => entry.commentId !== null && sameRoundLaneMetadata(entry.metadata, input));
    if (existingRoundComment) {
      const updateBody = laneReviewBody(input, allFindings, 0, 'issue-comment');
      const payloadPath = reviewPayloadPath({ body: updateBody.body });
      try {
        await assertHeadUnchanged();
        const updateResult = await runGh(['api', `repos/${repositoryName}/issues/comments/${existingRoundComment.commentId}`, '--method', 'PATCH', '--input', payloadPath], ghOptions);
        if (updateResult.exitCode !== 0) throw new Error(updateResult.stderr || updateResult.stdout || 'gh api issue comment update failed');
        return localReviewPublishResult({
          status: 'published',
          runId: updateBody.runId,
          marker: updateBody.marker,
          body: updateBody.body,
          publishKind: 'issue-comment',
          bodyFindingCount: updateBody.bodyFindingCount,
          publisher: publisher.identity,
          nextAction: `Provider-visible comment-state lane feedback for ${input.lane} was updated in place for its round; rerun PR view/gate to inspect provider state.`,
        });
      } catch (error: unknown) {
        return localReviewPublishResult({
          status: 'failed',
          runId: updateBody.runId,
          marker: updateBody.marker,
          body: updateBody.body,
          publishKind: 'issue-comment',
          bodyFindingCount: updateBody.bodyFindingCount,
          publisher: publisher.identity,
          failure: redact(error instanceof Error ? error.message : String(error)),
          nextAction: `Fix GitHub comment update permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`; a second same-round marker is never created.`,
        });
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    }

    try {
      await this.dismissSupersededRequestChanges({
        repositoryName,
        prNumber: input.prNumber,
        headSha: input.headSha,
        reviews: existingReviews,
        trustedMarkerAuthor,
        ghOptions,
      });
    } catch {
      // Dismissal failure must not block the current-head review event.
    }

    // Same-author or missing-permission identities degrade to issue comments with the configured identity when possible.
    if (!publisher.identity.formalEventCapability) {
      const { body, marker, runId, bodyFindingCount } = laneReviewBody(input, allFindings, 0, 'issue-comment');
      try {
        await assertHeadUnchanged();
        const commentResult = await runGh(['pr', 'comment', String(input.prNumber), '--body', body], ghOptions);
        if (commentResult.exitCode !== 0) {
          return localReviewPublishResult({
            status: 'failed',
            runId,
            marker,
            body,
            publishKind: 'issue-comment',
            bodyFindingCount,
            publisher: publisher.identity,
            failure: redact(commentResult.stderr || commentResult.stdout || 'gh pr comment failed'),
            nextAction: `Fix GitHub comment permissions or configure a distinct reviewer identity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
          });
        }
        return localReviewPublishResult({
          status: 'published',
          runId,
          marker,
          body,
          publishKind: 'issue-comment',
          bodyFindingCount,
          publisher: publisher.identity,
          nextAction: publisher.identity.fallbackReason
            ?? `Provider-visible comment-state lane feedback for ${input.lane} was published; formal PR review events were unavailable.`,
        });
      } catch (error: unknown) {
        return localReviewPublishResult({
          status: 'failed',
          runId,
          marker,
          body,
          publishKind: 'issue-comment',
          bodyFindingCount,
          publisher: publisher.identity,
          failure: redact(error instanceof Error ? error.message : String(error)),
          nextAction: `Fix GitHub comment permissions or configure a distinct reviewer identity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
        });
      }
    }

    let bodyFindings = allFindings;
    let inlineFindings: ReviewFinding[] = [];
    let inlineDiffIndex: ReviewDiffIndex | null = null;
    if (hasInlineFindingCandidates(allFindings)) {
      try {
        const diff = await this.getPullRequestDiff(input.prNumber);
        inlineDiffIndex = parseUnifiedDiffIndex(diff);
        const partitioned = partitionReviewFindings(allFindings, inlineDiffIndex);
        bodyFindings = [...partitioned.body];
        inlineFindings = [...partitioned.inline];
      } catch {
        bodyFindings = allFindings;
        inlineFindings = [];
        inlineDiffIndex = null;
      }
    }
    const inlineComments = inlineFindings
      .map(finding => inlineReviewComment(finding, input.lane, { headSha: input.headSha, repository: repositoryRefFromName(repositoryName), diffIndex: inlineDiffIndex }))
      .filter((comment): comment is JsonObject => comment !== null);
    const { body, marker, runId, bodyFindingCount, inlineCommentCount, blockingFindingCount } = laneReviewBody(input, bodyFindings, inlineComments.length);
    const submitReview = async (payload: JsonObject): Promise<GhRunResult> => {
      const args = ['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews`, '--method', 'POST'];
      const payloadPath = reviewPayloadPath(payload);
      try {
        // The head is revalidated inside submitReview so the diff fetch above
        // and every retry re-check freshness immediately before the POST.
        await assertHeadUnchanged();
        return await runGh([...args, '--input', payloadPath], ghOptions);
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
        publisher: publisher.identity,
        nextAction,
      });
    };
    const deletePendingReviews = async (): Promise<number> => {
      const reviews = await this.getPullRequestReviews(repositoryName, input.prNumber);
      const reviewComments = await this.getReviewComments(repositoryName, input.prNumber);
      const pendingReviews = reviews.filter(review => review.state === 'PENDING'
        && reviewAuthor(review) === trustedMarkerAuthor
        && review.id !== undefined
        && review.id !== null
        && (isQubeLaneReviewDraft(review, input.headSha) || isEmptyStaleDraftReview(review, input.headSha, reviewComments)));
      let deleted = 0;
      for (const review of pendingReviews) {
        const result = await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${String(review.id)}`, '--method', 'DELETE'], ghOptions);
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `GitHub pending review ${String(review.id)} could not be deleted`);
        deleted += 1;
      }
      return deleted;
    };
    const retryAfterPendingReview = async (result: GhRunResult, payload: JsonObject): Promise<GhRunResult> => {
      if (!maybePendingReviewConflict(result)) return result;
      try {
        const deleted = await deletePendingReviews();
        return deleted > 0 ? await submitReview(payload) : result;
      } catch {
        return result;
      }
    };
    const payload = {
      commit_id: input.headSha,
      body,
      event: reviewEvent(input.recommendation),
      comments: inlineComments,
    };
    const result = await retryAfterPendingReview(await submitReview(payload), payload);
    if (result.exitCode !== 0) {
      const fallbackBody = laneReviewBody(input, allFindings, 0);
      const intendedEvent = reviewEvent(input.recommendation);
      const bodyOnlyPayload = {
        commit_id: input.headSha,
        body: fallbackBody.body,
        event: intendedEvent,
        comments: [],
      };
      const intendedBodyOnlyResult = await retryAfterPendingReview(await submitReview(bodyOnlyPayload), bodyOnlyPayload);
      if (intendedBodyOnlyResult.exitCode === 0) {
        return publishReviewResult(
          intendedBodyOnlyResult,
          fallbackBody,
          `Provider-visible body-only pull request review for ${input.lane} was published after GitHub rejected inline review comments; rerun PR view/gate to inspect provider state.`,
        );
      }
      if (intendedEvent !== 'COMMENT') {
        const commentFallbackPayload = {
          commit_id: input.headSha,
          body: fallbackBody.body,
          event: 'COMMENT',
          comments: [],
        };
        const commentFallbackResult = await retryAfterPendingReview(await submitReview(commentFallbackPayload), commentFallbackPayload);
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
          publisher: publisher.identity,
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
        publisher: publisher.identity,
        failure: redact(`${result.stderr || result.stdout || 'gh api pull request review failed'}; body-only fallback failed: ${intendedBodyOnlyResult.stderr || intendedBodyOnlyResult.stdout || 'gh api body-only pull request review failed'}`),
        nextAction: `Fix GitHub pull request review permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.`,
      });
    }
    return publishReviewResult(result, { body, marker, runId, bodyFindingCount, inlineCommentCount, blockingFindingCount }, `Provider-visible pull request review for ${input.lane} was published; rerun PR view/gate to inspect provider state.`);
  }

  async loadReviewDiffIndex(prNumber: number): Promise<ParsedDiffIndex | null> {
    try {
      const diff = await this.getPullRequestDiff(prNumber);
      return parseUnifiedDiffIndex(diff);
    } catch {
      return null;
    }
  }

  async publishRoundReviewSummary(input: GitHubRoundSummaryPublishInput): Promise<GitHubRoundSummaryPublishResult> {
    let repositoryName: string;
    let comments: RawComment[];
    let reviews: RawReview[];
    let trustedMarkerAuthor: string;
    let publisher: ResolvedGitHubReviewPublisher = { accessToken: null, identity: emptyPublisherIdentity() };
    try {
      const repository = await this.getRepositoryIdentity();
      repositoryName = repository.nameWithOwner;
      comments = await this.getIssueComments(repositoryName, input.prNumber);
      const rawPr = await this.getPullRequest(input.prNumber);
      // Round summary publication must bind to the PR's current head, same as lane publish.
      const observedHead = typeof rawPr.headRefOid === 'string' ? rawPr.headRefOid : '';
      if (observedHead === '') {
        throw new Error(`pull request #${input.prNumber} did not report a head SHA, so the publish head cannot be verified; fail closed and retry once GitHub reports the current head.`);
      }
      if (observedHead !== input.headSha) {
        throw new Error(`pull request #${input.prNumber} head changed from ${input.headSha} to ${observedHead}; rerun the round summary publish for the current PR head.`);
      }
      reviews = await this.getPullRequestReviews(repositoryName, input.prNumber);
      const prAuthorLogin = rawPr.author?.login ?? null;
      publisher = await resolveGitHubReviewPublisher(this.options.publisher ?? null, {
        cwd: this.options.cwd,
        exec: this.options.exec,
        prAuthorLogin,
        mint: true,
      });
      if (publisher.identity.login) this.cachedPublisherLogin = publisher.identity.login;
      const identityFailure = unresolvedAppPublisherReason(publisher);
      if (identityFailure) {
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisher: publisher.identity,
          failure: identityFailure,
          nextAction: `Resolve the GitHub App bot login, then rerun the round summary publish for #${input.prNumber}.`,
        });
      }
      trustedMarkerAuthor = trustedPublisherLogin(publisher, await this.currentLogin()) ?? '';
      if (trustedMarkerAuthor === '') {
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisher: publisher.identity,
          failure: 'Publisher identity login is unresolved; formal review events are withheld.',
          nextAction: `Resolve the publisher login, then rerun the round summary publish for #${input.prNumber}.`,
        });
      }
    } catch (error: unknown) {
      return roundSummaryPublishResult({
        status: 'failed',
        marker: input.marker,
        body: input.body,
        publisher: publisher.identity,
        failure: redact(error instanceof Error ? error.message : String(error)),
        nextAction: `Fix GitHub PR review visibility or authentication, then rerun the round summary publish for #${input.prNumber}.`,
      });
    }

    const publisherDowngradeReason = publisher.identity.formalEventCapability ? null : publisher.identity.fallbackReason;

    if (input.dryRun) {
      const plannedKind = publisher.identity.formalEventCapability ? 'pull-request-review' : 'issue-comment';
      return roundSummaryPublishResult({
        status: 'planned',
        marker: input.marker,
        body: publishedRoundSummaryBody(input, plannedKind),
        publishKind: plannedKind,
        inlineCommentCount: publisher.identity.formalEventCapability ? input.inlineFindings.length : 0,
        unanchoredFindingCount: publisher.identity.formalEventCapability ? input.unanchoredFindingCount : input.unanchoredFindingCount + input.inlineFindings.length,
        publisherDowngradeReason,
        publisher: publisher.identity,
        nextAction: `Rerun the round summary publish for #${input.prNumber} without --dry-run to publish the provider-visible round summary.`,
      });
    }

    try {
      await this.dismissSupersededRequestChanges({
        repositoryName,
        prNumber: input.prNumber,
        headSha: input.headSha,
        reviews,
        trustedMarkerAuthor,
        ghOptions: { ...this.options, token: publisher.accessToken ?? undefined },
      });
    } catch {
      // Dismissal failure must not block the current-head round summary.
    }

    try {
      await this.upsertRoundStatusComment({
        repositoryName,
        prNumber: input.prNumber,
        headSha: input.headSha,
        verdict: input.verdict,
        comments,
        trustedMarkerAuthor,
        ghOptions: { ...this.options, token: publisher.accessToken ?? undefined },
      });
    } catch (error: unknown) {
      return roundSummaryPublishResult({
        status: 'failed',
        marker: input.marker,
        body: input.body,
        publisher: publisher.identity,
        failure: redact(error instanceof Error ? error.message : String(error)),
        nextAction: `Fix GitHub status-comment permissions, then rerun the round summary publish for #${input.prNumber}.`,
      });
    }

    const existingRecords = roundSummaryRecords(comments, reviews, trustedMarkerAuthor);
    const live = existingRecords.filter(record => record.superseded !== true && record.prNumber === input.prNumber);
    const sameRoundRecord = live.find(record => record.head === input.headSha && record.round === input.round) ?? null;
    const priorHeadRecords = live.filter(record => record.head !== input.headSha);

    const ghOptions = { ...this.options, token: publisher.accessToken ?? undefined };

    // Revalidate the head immediately before every mutation; the same freshness
    // discipline as lane publish, since prep work above widens the race window.
    const assertHeadUnchanged = async (): Promise<void> => {
      const freshPr = await this.getPullRequest(input.prNumber);
      const freshHead = typeof freshPr.headRefOid === 'string' ? freshPr.headRefOid : '';
      if (freshHead === '' || freshHead !== input.headSha) {
        throw new Error(freshHead === ''
          ? `pull request #${input.prNumber} stopped reporting a head SHA before publication; fail closed and rerun pr gate.`
          : `pull request #${input.prNumber} head changed from ${input.headSha} to ${freshHead} before publication; rerun pr gate for the current PR head.`);
      }
    };

    // Tombstone every live prior-head summary so exactly one live round summary
    // remains for the PR; a tombstone failure does not block the current
    // publish, it just leaves that one prior marker live for one more round.
    let supersededPriorSummaries = 0;
    for (const record of priorHeadRecords) {
      const tombstoneBody = [
        `<!-- ${ROUND_SUMMARY_MARKER_PREFIX}:${JSON.stringify({ version: 1, head: record.head, round: record.round, prNumber: record.prNumber, findingDigest: record.findingDigest, superseded: true })} -->`,
        '',
        'This round summary was superseded by a review of a later head; see the latest QUBE round summary for this pull request.',
      ].join('\n');
      const payloadPath = reviewPayloadPath({ body: tombstoneBody });
      try {
        await assertHeadUnchanged();
        const endpoint = record.kind === 'review'
          ? `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${record.id}`
          : `repos/${repositoryName}/issues/comments/${record.id}`;
        const result = await runGh(['api', endpoint, '--method', record.kind === 'review' ? 'PUT' : 'PATCH', '--input', payloadPath], ghOptions);
        if (result.exitCode === 0) supersededPriorSummaries += 1;
      } catch {
        // Best-effort supersession; the current summary still publishes below.
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    }

    if (sameRoundRecord) {
      if (sameRoundRecord.findingDigest === input.findingDigest) {
        return roundSummaryPublishResult({
          status: 'skipped',
          marker: input.marker,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          nextAction: 'The provider-visible round summary for this PR head is already published and unchanged.',
        });
      }
      const updateKind = sameRoundRecord.kind === 'review' ? 'pull-request-review' : 'issue-comment';
      const updateBody = publishedRoundSummaryBody(input, updateKind);
      const payloadPath = reviewPayloadPath({ body: updateBody });
      try {
        await assertHeadUnchanged();
        const endpoint = sameRoundRecord.kind === 'review'
          ? `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${sameRoundRecord.id}`
          : `repos/${repositoryName}/issues/comments/${sameRoundRecord.id}`;
        const updateResult = await runGh(['api', endpoint, '--method', sameRoundRecord.kind === 'review' ? 'PUT' : 'PATCH', '--input', payloadPath], ghOptions);
        if (updateResult.exitCode !== 0) throw new Error(updateResult.stderr || updateResult.stdout || 'gh api round summary update failed');
        const url = sameRoundRecord.kind === 'review' ? publishedReviewUrl(updateResult) : publishedCommentUrl(updateResult);
        return roundSummaryPublishResult({
          status: 'published',
          marker: input.marker,
          body: updateBody,
          url,
          summaryUrl: url,
          publishKind: sameRoundRecord.kind === 'review' ? 'pull-request-review' : 'issue-comment',
          inlineCommentCount: sameRoundRecord.kind === 'review' ? input.inlineFindings.length : 0,
          unanchoredFindingCount: sameRoundRecord.kind === 'review' ? input.unanchoredFindingCount : input.unanchoredFindingCount + input.inlineFindings.length,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          nextAction: 'The provider-visible round summary was updated in place for this round; rerun PR view/gate to inspect provider state.',
        });
      } catch (error: unknown) {
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          failure: redact(error instanceof Error ? error.message : String(error)),
          nextAction: `Fix GitHub round summary update permissions or connectivity, then rerun the round summary publish for #${input.prNumber}.`,
        });
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    }

    // Same-author or missing-permission identities degrade to an issue comment.
    if (!publisher.identity.formalEventCapability) {
      const fallbackBody = publishedRoundSummaryBody(input, 'issue-comment');
      const payloadPath = reviewPayloadPath({ body: fallbackBody });
      try {
        await assertHeadUnchanged();
        const commentResult = await runGh(['api', `repos/${repositoryName}/issues/${input.prNumber}/comments`, '--method', 'POST', '--input', payloadPath], ghOptions);
        if (commentResult.exitCode !== 0) {
          return roundSummaryPublishResult({
            status: 'failed',
            marker: input.marker,
            body: input.body,
            publisherDowngradeReason,
            supersededPriorSummaries,
            publisher: publisher.identity,
            failure: redact(commentResult.stderr || commentResult.stdout || 'gh api issue comment create failed'),
            nextAction: `Fix GitHub comment permissions or configure a distinct reviewer identity, then rerun the round summary publish for #${input.prNumber}.`,
          });
        }
        const url = publishedCommentUrl(commentResult);
        return roundSummaryPublishResult({
          status: 'published',
          marker: input.marker,
          body: fallbackBody,
          url,
          summaryUrl: url,
          publishKind: 'issue-comment',
          inlineCommentCount: 0,
          unanchoredFindingCount: input.unanchoredFindingCount + input.inlineFindings.length,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          nextAction: publisherDowngradeReason ?? 'Provider-visible comment-state round summary was published; formal PR review events were unavailable.',
        });
      } catch (error: unknown) {
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          failure: redact(error instanceof Error ? error.message : String(error)),
          nextAction: `Fix GitHub comment permissions or configure a distinct reviewer identity, then rerun the round summary publish for #${input.prNumber}.`,
        });
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    }

    const summaryDiffIndex = await this.loadReviewDiffIndex(input.prNumber);
    const inlineComments = input.inlineFindings
      .map(entry => inlineSummaryReviewComment(entry, { headSha: input.headSha, repository: repositoryRefFromName(repositoryName), diffIndex: summaryDiffIndex }))
      .filter((comment): comment is JsonObject => comment !== null);
    const roundReviewEvent = (verdict: GitHubRoundSummaryPublishInput['verdict']): 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' => {
      if (verdict === 'approve') return 'APPROVE';
      if (verdict === 'request-changes') return 'REQUEST_CHANGES';
      return 'COMMENT';
    };
    const submitReview = async (payload: JsonObject): Promise<GhRunResult> => {
      const payloadPath = reviewPayloadPath(payload);
      try {
        await assertHeadUnchanged();
        return await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews`, '--method', 'POST', '--input', payloadPath], ghOptions);
      } catch (error: unknown) {
        return {
          args: [],
          exitCode: error instanceof GhExecutionError ? error.exitCode : 1,
          stdout: '',
          stderr: error instanceof GhExecutionError ? error.stderr : error instanceof Error ? error.message : String(error),
        };
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    };
    const publishedResult = (publishResult: GhRunResult, inlineCommentCount: number, nextAction: string): GitHubRoundSummaryPublishResult => {
      const url = publishedReviewUrl(publishResult);
      return roundSummaryPublishResult({
        status: 'published',
        marker: input.marker,
        body: publishedRoundSummaryBody(input, 'pull-request-review'),
        url,
        summaryUrl: url,
        publishKind: 'pull-request-review',
        inlineCommentCount,
        unanchoredFindingCount: input.unanchoredFindingCount + (input.inlineFindings.length - inlineCommentCount),
        publisherDowngradeReason,
        supersededPriorSummaries,
        publisher: publisher.identity,
        nextAction,
      });
    };

    const maxInlineComments = 20;
    const primaryComments = inlineComments.slice(0, maxInlineComments);
    const extraCommentChunks: JsonObject[][] = [];
    for (let index = maxInlineComments; index < inlineComments.length; index += maxInlineComments) {
      extraCommentChunks.push(inlineComments.slice(index, index + maxInlineComments));
    }
    const payload = { commit_id: input.headSha, body: publishedRoundSummaryBody(input, 'pull-request-review'), event: roundReviewEvent(input.verdict), comments: primaryComments };
    let result = await submitReview(payload);
    if (maybePendingReviewConflict(result)) {
      try {
        const pendingReviews = (await this.getPullRequestReviews(repositoryName, input.prNumber))
          .filter(review => review.state === 'PENDING' && reviewAuthor(review) === trustedMarkerAuthor && review.id !== undefined && review.id !== null);
        for (const review of pendingReviews) {
          await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${String(review.id)}`, '--method', 'DELETE'], ghOptions);
        }
        if (pendingReviews.length > 0) result = await submitReview(payload);
      } catch {
        // Fall through to the failure/fallback branches below with the original result.
      }
    }
    if (result.exitCode !== 0) {
      const bodyOnlyPayload = { commit_id: input.headSha, body: input.body, event: roundReviewEvent(input.verdict), comments: [] };
      const bodyOnlyResult = await submitReview(bodyOnlyPayload);
      if (bodyOnlyResult.exitCode === 0) {
        return publishedResult(bodyOnlyResult, 0, 'Provider-visible body-only round summary was published after GitHub rejected inline review comments; rerun PR view/gate to inspect provider state.');
      }
      if (roundReviewEvent(input.verdict) !== 'COMMENT') {
        const commentEventPayload = { commit_id: input.headSha, body: input.body, event: 'COMMENT', comments: [] };
        const commentEventResult = await submitReview(commentEventPayload);
        if (commentEventResult.exitCode === 0) {
          return publishedResult(commentEventResult, 0, 'Provider-visible COMMENT round summary was published after GitHub rejected the requested review event; rerun PR view/gate to inspect provider state.');
        }
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          failure: redact(`${result.stderr || result.stdout || 'gh api pull request review failed'}; body-only fallback failed: ${bodyOnlyResult.stderr || bodyOnlyResult.stdout || 'unknown'}; comment fallback failed: ${commentEventResult.stderr || commentEventResult.stdout || 'unknown'}`),
          nextAction: `Fix GitHub pull request review permissions or connectivity, then rerun the round summary publish for #${input.prNumber}.`,
        });
      }
      return roundSummaryPublishResult({
        status: 'failed',
        marker: input.marker,
        body: input.body,
        publisherDowngradeReason,
        supersededPriorSummaries,
        publisher: publisher.identity,
        failure: redact(`${result.stderr || result.stdout || 'gh api pull request review failed'}; body-only fallback failed: ${bodyOnlyResult.stderr || bodyOnlyResult.stdout || 'unknown'}`),
        nextAction: `Fix GitHub pull request review permissions or connectivity, then rerun the round summary publish for #${input.prNumber}.`,
      });
    }
    for (const chunk of extraCommentChunks) {
      const chunkResult = await submitReview({ commit_id: input.headSha, body: '', event: 'COMMENT', comments: chunk });
      if (chunkResult.exitCode !== 0) {
        const createdReviewId = publishedReviewId(result);
        if (createdReviewId !== null) {
          const tombstonedBody = input.body.replace(
            /<!--\s*qube-pr-review-summary:(\{[\s\S]*?\})\s*-->/,
            (full, json) => {
              try {
                const parsed = JSON.parse(json) as Record<string, unknown>;
                parsed.superseded = true;
                return `<!-- qube-pr-review-summary:${JSON.stringify(parsed)} -->`;
              } catch {
                return full;
              }
            },
          );
          const tombstonePath = reviewPayloadPath({
            body: `${tombstonedBody}\n\nThis round review was superseded because not every inline finding published.`,
          });
          try {
            await runGh(['api', `repos/${repositoryName}/pulls/${input.prNumber}/reviews/${createdReviewId}`, '--method', 'PUT', '--input', tombstonePath], ghOptions);
          } catch {
            // The chunk failure remains the publish result even if tombstone fails.
          } finally {
            cleanupReviewPayload(tombstonePath);
          }
        }
        return roundSummaryPublishResult({
          status: 'failed',
          marker: input.marker,
          body: input.body,
          publisherDowngradeReason,
          supersededPriorSummaries,
          publisher: publisher.identity,
          failure: redact(chunkResult.stderr || chunkResult.stdout || 'gh api chunked inline review comments failed'),
          nextAction: `Fix GitHub review comment permissions, then rerun the round summary publish for #${input.prNumber}.`,
        });
      }
    }
    return publishedResult(result, inlineComments.length, 'Provider-visible round summary was published; rerun PR view/gate to inspect provider state.');
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
    let prThreads: RawThreadNode[];
    try {
      const repository = await this.getRepositoryIdentity();
      prThreads = await this.getUnresolvedThreads(repository.nameWithOwner, input.prNumber);
    } catch {
      return {
        status: 'failed',
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: [],
        failedThreadIds: threadIds,
        nextAction: `Could not verify GitHub review thread ids against PR #${input.prNumber}. Rerun \`aie pr view ${input.prNumber} --json\` to inspect unresolved reviewThreads, then retry.`,
      };
    }
    const resolvableThreadIds = new Set(prThreads.filter(thread => thread.viewerCanResolve === true).map(thread => thread.id).filter((id): id is string => typeof id === 'string' && id.trim() !== ''));
    const skippedThreadIds = threadIds.filter(threadId => !resolvableThreadIds.has(threadId));
    const selectedThreadIds = threadIds.filter(threadId => resolvableThreadIds.has(threadId));
    if (selectedThreadIds.length === 0) {
      return {
        status: 'skipped',
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds,
        failedThreadIds: [],
        nextAction: `No selected GitHub review thread ids belong to unresolved viewer-resolvable threads on PR #${input.prNumber}; rerun \`aie pr view ${input.prNumber} --json\` to inspect current reviewThreads.`,
      };
    }
    const resolvedThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    for (const threadId of selectedThreadIds) {
      const result = await this.resolveReviewThread(threadId);
      if (result) resolvedThreadIds.push(threadId);
      else failedThreadIds.push(threadId);
    }
    const status: ResolveReviewThreadResult['status'] = failedThreadIds.length > 0 ? (resolvedThreadIds.length > 0 ? 'failed' : 'failed') : 'resolved';
    return {
      status,
      prNumber: input.prNumber,
      resolvedThreadIds,
      skippedThreadIds,
      failedThreadIds,
      nextAction: failedThreadIds.length > 0
        ? `Some GitHub review threads could not be resolved. Verify permissions and rerun \`aie pr thread resolve ${input.prNumber} --thread <id>\` for the failed ids.`
        : `Resolved ${resolvedThreadIds.length} GitHub review thread${resolvedThreadIds.length === 1 ? '' : 's'}${skippedThreadIds.length > 0 ? ` and skipped ${skippedThreadIds.length} id${skippedThreadIds.length === 1 ? '' : 's'} not resolvable on PR #${input.prNumber}` : ''}; rerun \`aie pr view ${input.prNumber} --json\` or \`aie pr gate ${input.prNumber}\` to confirm merge blockers cleared.`,
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

  private async upsertRoundStatusComment(input: {
    repositoryName: string;
    prNumber: number;
    headSha: string;
    verdict: string;
    comments: readonly RawComment[];
    trustedMarkerAuthor: string;
    ghOptions: { cwd?: string; exec?: GitHubReviewProviderOptions['exec']; token?: string };
  }): Promise<void> {
    const priorRounds = parseStatusCommentRounds(input.comments.find(comment => (comment.body ?? '').includes(`<!-- ${ROUND_STATUS_MARKER_PREFIX}:`))?.body);
    const rounds = [
      ...priorRounds.filter(round => round.head !== input.headSha),
      { head: input.headSha, verdict: input.verdict },
    ];
    const marker = `<!-- ${ROUND_STATUS_MARKER_PREFIX}:${JSON.stringify({ version: 1, prNumber: input.prNumber, rounds })} -->`;
    const history = rounds.map(round => `- ${round.head.slice(0, 12)}: ${round.verdict}`).join('\n');
    const body = [
      marker,
      '',
      `Review status: ${input.verdict}.`,
      `Head: ${input.headSha}.`,
      '',
      '<details>',
      '<summary>Round history</summary>',
      '',
      history,
      '',
      '</details>',
      '',
      `Rerun: \`aie pr gate ${input.prNumber}\`.`,
    ].join('\n');
    const existing = input.comments.find(comment => authorIsTrusted(comment.author?.login, input.trustedMarkerAuthor) && (comment.body ?? '').includes(`<!-- ${ROUND_STATUS_MARKER_PREFIX}:`));
    const commentId = existing ? issueCommentIdFromUrl(existing.url) : null;
    const payloadPath = reviewPayloadPath({ body });
    try {
      if (commentId) {
        const result = await runGh(['api', `repos/${input.repositoryName}/issues/comments/${commentId}`, '--method', 'PATCH', '--input', payloadPath], input.ghOptions);
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'gh api status comment update failed');
        return;
      }
      const result = await runGh(['api', `repos/${input.repositoryName}/issues/${input.prNumber}/comments`, '--method', 'POST', '--input', payloadPath], input.ghOptions);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || 'gh api status comment create failed');
    } finally {
      cleanupReviewPayload(payloadPath);
    }
  }

  private async dismissSupersededRequestChanges(input: {
    repositoryName: string;
    prNumber: number;
    headSha: string;
    reviews: readonly RawReview[];
    trustedMarkerAuthor: string;
    ghOptions: { cwd?: string; exec?: GitHubReviewProviderOptions['exec']; token?: string };
  }): Promise<void> {
    for (const review of input.reviews) {
      if (review.state !== 'CHANGES_REQUESTED') continue;
      if (review.id === undefined || review.id === null) continue;
      if (!authorIsTrusted(reviewAuthor(review), input.trustedMarkerAuthor)) continue;
      const metadata = parseLaneReviewMetadata(review.body);
      const reviewHead = typeof metadata?.head === 'string' ? metadata.head : review.commit?.oid ?? '';
      if (reviewHead === '' || reviewHead === input.headSha) continue;
      const payloadPath = reviewPayloadPath({ message: `Superseded by head ${input.headSha}.`, event: 'DISMISS' });
      try {
        const result = await runGh([
          'api',
          `repos/${input.repositoryName}/pulls/${input.prNumber}/reviews/${String(review.id)}/dismissals`,
          '--method',
          'PUT',
          '--input',
          payloadPath,
        ], input.ghOptions);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.stdout || 'gh api review dismissal failed');
        }
      } finally {
        cleanupReviewPayload(payloadPath);
      }
    }
  }

  private async getPullRequestReviews(repoName: string, prNumber: number): Promise<RawReview[]> {
    // Paginated like getReviewComments: the same-round marker search must see
    // every review, or a PR past 100 reviews would miss its existing marker
    // and create a second one for the round.
    const result = await runGh(['api', `repos/${repoName}/pulls/${prNumber}/reviews`, '--method', 'GET', '-F', 'per_page=100', '--paginate', '--slurp'], this.options);
    ensureGhSuccess(`gh api pull reviews for PR ${prNumber}`, result);
    const parsed = parseGhJson<RawReview[] | RawReview[][]>(result.stdout, `gh api pull reviews for PR ${prNumber}`, value => Array.isArray(value));
    return parsed.flat().map(review => ({
      ...review,
      author: review.author ?? review.user ?? null,
      url: review.url ?? review.html_url,
      commit: review.commit ?? (typeof review.commit_id === 'string' ? { oid: review.commit_id } : null),
    }));
  }

  private async getPullRequestDiff(prNumber: number): Promise<string> {
    const result = await runGh(['pr', 'diff', String(prNumber), '--patch'], this.options);
    ensureGhSuccess(`gh pr diff ${prNumber} --patch`, result);
    return result.stdout;
  }

  private async getUnresolvedThreads(repoName: string, prNumber: number): Promise<RawThreadNode[]> {
    const [owner, repo] = repoName.split('/');
    if (!owner || !repo) return [];
    const query = "query($owner: String!, $repo: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { nodes { id isResolved isOutdated viewerCanResolve viewerCanUnresolve comments(last: 1) { nodes { id databaseId body url path line originalLine diffHunk outdated createdAt author { login } } } } pageInfo { hasNextPage endCursor } } } } }";
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

  private async getMergeUiState(repoName: string, prNumber: number): Promise<RawMergeUiState | null> {
    const [owner, repo] = repoName.split('/');
    if (!owner || !repo) return null;
    const query = 'query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { viewerMergeHeadlineText viewerMergeBodyText viewerCannotUpdateReasons } } }';
    const result = await runGh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `repo=${repo}`, '-F', `pr=${prNumber}`, '-f', `query=${query}`], this.options);
    ensureGhSuccess(`gh api graphql merge UI state for PR ${prNumber}`, result);
    return parseGhJson<RawMergeUiStateResponse>(result.stdout, `gh api graphql merge UI state for PR ${prNumber}`, isRawMergeUiStateResponse).data?.repository?.pullRequest ?? null;
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

  /**
   * Authors trusted for QUBE marker comments/reviews on load paths.
   * Concrete allowlist only (never trust-all markers). Never mints credentials here.
   * Distinct publisher logins come from process cache (set on publish) or optional
   * non-secret configured login fields when present.
   */
  private async trustedAuthorsForLoad(): Promise<string[]> {
    const publisher = this.options.publisher;
    if (publisher && publisher.mode !== 'user') {
      // Marker trust must anchor on a credential-verified identity; a login
      // string from configuration alone could nominate any account's markers
      // as trusted and forge review history. Minting exercises the configured
      // credential to derive its real identity (cached for later loads), and
      // an unverifiable credential fails closed to an empty author list.
      if (this.cachedPublisherLogin) return [this.cachedPublisherLogin];
      try {
        const resolved = await resolveGitHubReviewPublisher(publisher, { cwd: this.options.cwd, exec: this.options.exec, prAuthorLogin: null, mint: true });
        if (resolved.identity.credentialVerified === true && resolved.identity.login) {
          this.cachedPublisherLogin = resolved.identity.login;
          return [resolved.identity.login];
        }
      } catch {
        // fall through to the fail-closed empty author list
      }
      return [];
    }
    try {
      const login = await this.currentLogin();
      if (login) return [login];
    } catch {
      // optional on load
    }
    return [];
  }

  private configuredPublisherLoginMissing(): boolean {
    const publisher = this.options.publisher;
    if (!publisher || publisher.mode === 'user') return false;
    const login = publisher.mode === 'github-app' ? publisher.githubApp?.login : publisher.token?.login;
    return this.cachedPublisherLogin === undefined && (typeof login !== 'string' || login.trim() === '');
  }

  private async currentLogin(): Promise<string> {
    if (!this.currentLoginPromise) {
      this.currentLoginPromise = (async () => {
        const result = await runGh(['api', 'user'], this.options);
        ensureGhSuccess('gh api user', result);
        return parseGhJson<LoginResponse>(result.stdout, 'gh api user', isLoginResponse).login;
      })();
    }
    return this.currentLoginPromise;
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

  private reviewItem(rawPr: RawPrView, reviewRequests: string[], comments: RawComment[], latestReviews: RawReview[], laneReviews: RawReview[], reviewComments: RawReviewComment[], unresolvedThreads: RawThreadNode[], unavailable: string[], trustedMarkerAuthor: TrustedAuthorInput, ciDiagnostics: GitHubCiDiagnostic[], mergeUiState: RawMergeUiState | null): ReviewItem {
    const pr = normalizePr(rawPr, mergeUiState);
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
      feedback: feedback({ comments, latestReviews, reviewComments, unresolvedThreads, trustedMarkerAuthor, headRefOid: pr.headRefOid, prNumber: pr.number, reviewAgents: this.options.reviewAgents }),
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
    if (!this.repositoryIdentityPromise) {
      this.repositoryIdentityPromise = (async () => {
        const result = await runGh(['repo', 'view', '--json', 'nameWithOwner,url'], this.options);
        ensureGhSuccess('gh repo view', result);
        return parseGhJson<{ nameWithOwner: string; url: string }>(result.stdout, 'gh repo view', (value): value is { nameWithOwner: string; url: string } => isRecord(value) && typeof value.nameWithOwner === 'string' && typeof value.url === 'string');
      })();
    }
    try {
      return await this.repositoryIdentityPromise;
    } catch (error) {
      this.repositoryIdentityPromise = null;
      throw error;
    }
  }
}

export type GitHubReviewProvider = GitHubReviewForgeProvider;

export function createGitHubReviewForgeProvider(options: GitHubReviewProviderOptions = {}): GitHubReviewForgeProvider {
  return new GitHubReviewForgeProvider(options);
}

export function createGitHubReviewProvider(options: GitHubReviewProviderOptions = {}): GitHubReviewForgeProvider {
  return createGitHubReviewForgeProvider(options);
}
