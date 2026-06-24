import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAction, createActionPlan, type Action, type ActionPlan, type ActionResult } from '../../core/action_plan.js';
import { normalizeGateEvidence, type GateEvidence, type GateEvidenceReasonCode, type GateResult } from '../../core/gate_evidence.js';
import type { JsonObject, JsonValue } from '../../core/json_value.js';
import type { ExecutorPolicy } from '../../core/policy.js';
import { normalizeProviderSource } from '../../core/provider_source.js';
import type { ReviewFeedback, ReviewItem, ReviewItemKey } from '../../core/review_item.js';
import { normalizeReviewItem } from '../../core/review_item.js';
import { GhExecutionError, GhRunResult, parseGhJson, redact, runGh } from '../../gh.js';
import { getRepositoryIdentity } from '../../repo/index.js';
import type { ReviewProvider, ReviewProviderCapabilities } from '../review_provider.js';

import type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot, LoginResponse, RawAuthor, RawComment, RawIssueComment, RawPrView, RawReview, RawReviewComment, RawReviewRequest, RawStatusCheck, RawThreadNode, RawThreadResponse } from './github_review_types.js';
export type { CurrentGitHubReview, GitHubCiDiagnostic, GitHubCiDiagnosticReasonCode, GitHubCiDiagnosticStatus, GitHubReviewProviderOptions, GitHubReviewPullRequest, GitHubReviewRequestTrigger, GitHubReviewSnapshot } from './github_review_types.js';

const PR_VIEW_FIELDS = 'number,title,state,url,headRefOid,reviewDecision,mergeStateStatus,mergeable,isDraft,reviewRequests,latestReviews,statusCheckRollup,closingIssuesReferences';
const CURRENT_PR_FIELDS = 'number,title,state,url,reviewDecision,mergeStateStatus,mergeable,isDraft';
const MARKER_PREFIX = 'aie:pr-gate';
const LOCAL_REVIEW_MARKER_PREFIX = 'qube-local-review';

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

interface RawCheckRun { id?: number; name?: string; status?: string; conclusion?: string | null; html_url?: string; details_url?: string; check_suite?: { id?: number } | null }
interface RawCheckRunsResponse { check_runs?: RawCheckRun[] }
interface RawCheckSuite { id?: number; status?: string; conclusion?: string | null; head_sha?: string | null }
interface RawCheckSuitesResponse { check_suites?: RawCheckSuite[] }
interface RawWorkflowRun { id?: number; name?: string; head_sha?: string | null; status?: string; conclusion?: string | null; html_url?: string; path?: string | null; workflow_id?: number }
interface RawWorkflowRunsResponse { workflow_runs?: RawWorkflowRun[] }

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

function sanitizeFeedbackText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<!--\s*internal state start\s*-->[\s\S]*?<!--\s*internal state end\s*-->/gi, '')
    .replace(/<details>\s*<summary>\s*Prompt for AI Agents[\s\S]*?<\/details>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/Prompt for AI Agents[\s\S]*$/i, '');
}

function isNonActionableSummary(text: string | undefined, authorLogin?: string | null): boolean {
  const normalized = sanitizeFeedbackText(text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized === '') return true;
  if (normalized.includes('no actionable comments were generated')) return true;
  if (normalized.includes('review in progress')) return true;
  if (normalized.includes('currently processing new changes')) return true;
  if (normalized.includes('<summary>📝 walkthrough</summary>')) return true;
  if (normalized.includes('<summary>walkthrough</summary>')) return true;
  if (isCopilotOverview(normalized, authorLogin)) return true;
  if (normalized.startsWith('**no issues found**') || normalized.startsWith('no issues found')) return true;
  return false;
}

function isCopilotOverview(normalizedText: string, authorLogin?: string | null): boolean {
  if ((authorLogin ?? '').toLowerCase() !== 'copilot-pull-request-reviewer') return false;
  return normalizedText.startsWith('## pull request overview')
    && normalizedText.includes('### reviewed changes')
    && /\bcopilot reviewed \d+ out of \d+ changed files in this pull request\b/i.test(normalizedText);
}

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

function normalizeHandle(name: string): string { const trimmed = name.trim(); return trimmed.startsWith('@') ? trimmed : `@${trimmed}`; }

function reviewerId(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'reviewer';
}

function markerFor(reviewer: string, headSha: string): string {
  return `<!-- ${MARKER_PREFIX}:${reviewerId(reviewer)}:${headSha} -->`;
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

function triggerFor(name: string): GitHubReviewRequestTrigger { return reviewerId(name) === 'copilot' ? 'github-reviewer' : 'comment'; }

function configuredReviewerNames(policy: ExecutorPolicy): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const rawName of policy.reviews.reviewers) {
    const name = rawName.trim();
    if (name === '') continue;
    const id = reviewerId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    names.push(name);
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

function commentBodyFor(name: string, policy: ExecutorPolicy, headSha: string): { body: string; marker: string } {
  const handle = normalizeHandle(name);
  const marker = markerFor(name, headSha);
  const requestText = policy.reviews.requestText.replace(/\s+/g, ' ').trim();
  const id = reviewerId(name);
  let command = `${handle} review this PR`;
  if (id === 'coderabbit' || id === 'coderabbitai') command = `${handle} review`;
  if (id === 'cubic' || id === 'cubic-dev-ai') command = `${handle} review this PR`;
  const body = requestText === '' ? `${marker}\n${command}` : `${marker}\n${command}\n${redact(requestText)}`;
  return { body, marker };
}

function reviewerMarkerBodyFor(name: string, headSha: string): { body: string; marker: string } {
  const marker = markerFor(name, headSha);
  return { body: `${marker}\nExecutor recorded a configured PR reviewer request for this PR head.`, marker };
}

function stableRunId(input: GitHubLocalReviewPublishInput): string {
  return createHash('sha256')
    .update(JSON.stringify({
      head: input.headSha,
      runner: input.runner,
      host: input.host,
      profile: input.profile,
      lanes: input.lanes,
      status: input.status,
      recommendation: input.recommendation,
      evidencePath: input.evidencePath,
      issueNumbers: input.issueNumbers,
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
    .replace(/\\\\[A-Za-z0-9._$-]+\\[^\r\n)<>]+/g, '[local-path]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n)<>]+/g, '[local-path]')
    .replace(/(^|[\s(:`"'])\/(?:Users|home|tmp|var|private|mnt|Volumes|workspace|workspaces|code)\/[^\r\n)<>]+/g, '$1[local-path]');
}

function localReviewBody(input: GitHubLocalReviewPublishInput): { body: string; marker: string; runId: string } {
  const runId = stableRunId(input);
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
    issueNumbers: input.issueNumbers,
    lanes: input.lanes,
    inline: 'unsupported',
  };
  const marker = localReviewMarker(metadata);
  const findings = input.findings.length === 0 ? ['- None recorded.'] : input.findings.map(item => `- ${sanitizePublishedText(item)}`);
  const issues = input.issueNumbers.length === 0 ? ['- No linked issue metadata was available.'] : input.issueNumbers.map(issue => `- issue #${issue}`);
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
    `- lanes: ${input.lanes.length === 0 ? 'none' : input.lanes.map(redact).join(', ')}`,
    `- run id: ${runId}`,
    '- inline comments: unsupported by this provider publisher; summary comment used',
  ].join('\n');
  return { body, marker, runId };
}

function localReviewPublishResult(input: Partial<GitHubLocalReviewPublishResult> & { status: GitHubLocalReviewPublishStatus; nextAction: string }): GitHubLocalReviewPublishResult {
  return {
    runId: input.runId ?? null,
    marker: input.marker ?? null,
    body: input.body ?? null,
    url: input.url ?? null,
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
  for (const review of raw.latestReviews) {
    const state = review.state ?? 'UNKNOWN';
    if (isStaleChangeRequest(review, raw.headRefOid, raw.unresolvedThreads)) continue;
    if (raw.unresolvedThreads.length === 0 && isResolvedProviderReviewSummary(review.body)) continue;
    if (state === 'CHANGES_REQUESTED' || (state === 'COMMENTED' && !isNonActionableSummary(review.body, review.author?.login))) items.push({ source: 'review', author: actorName(review.author), state, summary: summarize(review.body), url: review.url ? redact(review.url) : null, trust: 'untrusted' });
  }
  for (const comment of raw.comments) {
    const body = comment.body ?? '';
    if (trustedLocalReviewComment(comment, raw.trustedMarkerAuthor)) continue;
    if ((!trustedMarkerComment(comment, raw.trustedMarkerAuthor) || !body.includes(`<!-- ${MARKER_PREFIX}:`)) && !isNonActionableSummary(body, comment.author?.login)) items.push({ source: 'comment', author: actorName(comment.author), summary: summarize(comment.body), url: comment.url ? redact(comment.url) : null, state: null, trust: 'untrusted' });
  }
  for (const thread of raw.unresolvedThreads) {
    const first = thread.comments?.nodes?.[0];
    items.push({ source: 'thread', author: actorName(first?.author), summary: summarize(first?.body), url: first?.url ? redact(first.url) : null, state: null, trust: 'untrusted' });
  }
  return items;
}

function metadata(raw: { pr: GitHubReviewPullRequest; reviewRequests: string[]; comments: RawComment[]; latestReviews: RawReview[]; unavailable: string[]; trustedMarkerAuthor: string | null }): JsonObject {
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
  return {
    number: raw.pr.number,
    headRefOid: raw.pr.headRefOid,
    mergeStateStatus: raw.pr.mergeStateStatus,
    rawReviewDecision: raw.pr.reviewDecision,
    rawMergeable: raw.pr.mergeable,
    reviewRequests: raw.reviewRequests,
    comments: raw.comments.map(comment => ({ author: comment.author?.login ?? null, body: comment.body ?? null })),
    latestReviews: raw.latestReviews.map(review => ({ author: review.author?.login ?? null, commitOid: review.commit?.oid ?? null })),
    localReviews,
    trustedLocalReviews,
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

function makeRequestAction(input: { item: ReviewItem; name: string; requestedForHead: boolean; staleRequest: boolean; pending: boolean; policy: ExecutorPolicy }): Action {
  const trigger = triggerFor(input.name);
  const handle = normalizeHandle(input.name);
  const id = reviewerId(input.name);
  const headRefOid = getJsonString(input.item.trustedMetadata.headRefOid) ?? 'UNKNOWN';
  const skipped = input.requestedForHead || input.pending;
  const body = trigger === 'github-reviewer' ? reviewerMarkerBodyFor(input.name, headRefOid) : commentBodyFor(input.name, input.policy, headRefOid);
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
      externalService: true,
      requestedForHead: input.requestedForHead,
      staleRequest: input.staleRequest,
      pending: input.pending,
      marker: body.marker,
      body: body.body,
    },
  });
}

export class GitHubReviewProvider implements ReviewProvider {
  readonly id = 'github' as const;

  constructor(private readonly options: GitHubReviewProviderOptions = {}) {}

  capabilities(): ReviewProviderCapabilities { return { loadReview: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true }; }

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
      return { item: this.reviewItem(raw, [], [], [], [], [], [], null, []), pr, warning: null };
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      return { item: null, pr: null, warning: `Current-branch PR state unavailable: ${redact(detail)}` };
    }
  }

  async loadPullRequestReview(prNumber: number): Promise<GitHubReviewSnapshot> {
    const rawPr = await this.getPullRequest(prNumber);
    const unavailable: string[] = [];
    let ciDiagnostics: GitHubCiDiagnostic[] = [];
    let reviewComments: RawReviewComment[] = [];
    let unresolvedThreads: RawThreadNode[] = [];
    try {
      const repository = await getRepositoryIdentity(this.options);
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
    const reviewRequests = reviewRequestNames(rawPr.reviewRequests);
    return {
      item: this.reviewItem(rawPr, reviewRequests, comments, latestReviews, reviewComments, unresolvedThreads, unavailable, trustedMarkerAuthor, ciDiagnostics),
      pr: normalizePr(rawPr),
      ciDiagnostics,
      closingIssueNumbers: closingIssueNumbers(rawPr),
      reviewRequests,
      commentsCount: comments.length,
      reviewsCount: latestReviews.length,
      reviewCommentsCount: reviewComments.length,
      unresolvedThreadsCount: unresolvedThreads.length,
      unavailable,
    };
  }

  planReviewRequest(item: ReviewItem, policy: ExecutorPolicy): ActionPlan {
    const headSha = getJsonString(item.trustedMetadata.headRefOid) ?? 'UNKNOWN';
    const reviewRequests = getJsonStrings(item.trustedMetadata.reviewRequests);
    const trustedMarkerAuthor = getJsonString(item.trustedMetadata.trustedMarkerAuthor);
    const comments = commentsFromMetadata(item);
    const latestReviews = latestReviewsFromMetadata(item);
    const actions = configuredReviewerNames(policy).map(name => {
      const trigger = triggerFor(name);
      const handle = normalizeHandle(name);
      const requestedForHead = trigger === 'github-reviewer' ? hasMarker(comments, name, headSha, trustedMarkerAuthor) || isCurrentReview(latestReviews, handle, headSha) : hasMarker(comments, name, headSha, trustedMarkerAuthor);
      const pending = isPendingRequest(reviewRequests, handle);
      const staleRequest = trigger === 'github-reviewer' ? !requestedForHead && !pending && (hasStaleMarker(comments, name, headSha, trustedMarkerAuthor) || hasStaleReview(latestReviews, handle, headSha)) : !requestedForHead && hasStaleMarker(comments, name, headSha, trustedMarkerAuthor);
      return makeRequestAction({ item, name, requestedForHead, staleRequest, pending, policy });
    });
    return createActionPlan({ id: `github:review-request:${item.key.id}`, purpose: `Request configured PR reviewers for ${item.displayId}.`, dryRun: true, actions });
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
      nextAction: 'Provider-visible local review feedback was published; rerun PR view/gate to inspect provider state if needed.',
    });
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

  private async getUnresolvedThreads(repoName: string, prNumber: number): Promise<RawThreadNode[]> {
    const [owner, repo] = repoName.split('/');
    if (!owner || !repo) return [];
    const query = `query($owner: String!, $repo: String!, $pr: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100, after: $after) { nodes { id isResolved comments(first: 1) { nodes { body url author { login } } } } pageInfo { hasNextPage endCursor } } } } }`;
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
        .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
        .some(name => /\bworkflow_dispatch\b/.test(readFileSync(join(workflowRoot, name), 'utf8')));
    } catch {
      return null;
    }
  }

  private reviewItem(rawPr: RawPrView, reviewRequests: string[], comments: RawComment[], latestReviews: RawReview[], reviewComments: RawReviewComment[], unresolvedThreads: RawThreadNode[], unavailable: string[], trustedMarkerAuthor: string | null, ciDiagnostics: GitHubCiDiagnostic[]): ReviewItem {
    const pr = normalizePr(rawPr);
    const source = normalizeProviderSource({ providerId: this.id, resourceKind: 'review-item', resourceId: String(rawPr.number), url: pr.url });
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
      checks: checks(rawPr.statusCheckRollup, ciDiagnostics),
      trustedMetadata: { ...metadata({ pr, reviewRequests, comments, latestReviews, unavailable, trustedMarkerAuthor }), ciDiagnostics: ciDiagnostics.map(ciDiagnosticMetadata) },
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
}
export function createGitHubReviewProvider(options: GitHubReviewProviderOptions = {}): GitHubReviewProvider { return new GitHubReviewProvider(options); }
