import type { ReviewItem } from '@tjalve/qube-core';
import type { GhExec } from './gh.js';

export type GitHubReviewRequestTrigger = 'github-reviewer' | 'comment';

export interface GitHubReviewPullRequest {
  number: number;
  title: string;
  state: string;
  url: string;
  headRefOid: string;
  reviewDecision: string;
  mergeStateStatus: string;
  mergeable: string;
  isDraft: boolean;
}

export type GitHubCiDiagnosticStatus =
  | 'mapped'
  | 'pending-current-head-run'
  | 'missing-current-head-run'
  | 'failed-current-head-run'
  | 'skipped-current-head-run'
  | 'stale-old-head-run'
  | 'unknown';

export type GitHubCiDiagnosticReasonCode =
  | 'current-head-check-run-found'
  | 'current-head-workflow-run-found'
  | 'current-head-check-run-pending'
  | 'current-head-check-run-failed'
  | 'current-head-check-run-skipped'
  | 'missing-current-head-ci-run'
  | 'stale-old-head-ci-run'
  | 'ci-mapping-unknown';

const githubCiDiagnosticStatuses: readonly GitHubCiDiagnosticStatus[] = [
  'mapped',
  'pending-current-head-run',
  'missing-current-head-run',
  'failed-current-head-run',
  'skipped-current-head-run',
  'stale-old-head-run',
  'unknown',
];

const githubCiDiagnosticReasonCodes: readonly GitHubCiDiagnosticReasonCode[] = [
  'current-head-check-run-found',
  'current-head-workflow-run-found',
  'current-head-check-run-pending',
  'current-head-check-run-failed',
  'current-head-check-run-skipped',
  'missing-current-head-ci-run',
  'stale-old-head-ci-run',
  'ci-mapping-unknown',
];

export function isGitHubCiDiagnosticStatus(value: string): value is GitHubCiDiagnosticStatus {
  return githubCiDiagnosticStatuses.includes(value as GitHubCiDiagnosticStatus);
}

export function isGitHubCiDiagnosticReasonCode(value: string): value is GitHubCiDiagnosticReasonCode {
  return githubCiDiagnosticReasonCodes.includes(value as GitHubCiDiagnosticReasonCode);
}

export interface GitHubCiDiagnostic {
  checkName: string;
  status: GitHubCiDiagnosticStatus;
  reasonCode: GitHubCiDiagnosticReasonCode;
  currentHeadSha: string;
  mappedToCurrentHeadCheckRun: boolean;
  mappedToCurrentHeadWorkflowRun: boolean;
  currentHeadSuiteIds: string[];
  currentHeadRunIds: string[];
  staleRunIds: string[];
  workflowDispatchSupported: boolean | null;
  summary: string;
  nextAction: string;
}

export interface GitHubReviewSnapshot {
  item: ReviewItem;
  pr: GitHubReviewPullRequest;
  ciDiagnostics: GitHubCiDiagnostic[];
  closingIssueNumbers: number[];
  reviewRequests: string[];
  commentsCount: number;
  reviewsCount: number;
  reviewCommentsCount: number;
  unresolvedThreadsCount: number;
  conversationsCount?: number;
  unavailable: string[];
}

export interface CurrentGitHubReview {
  item: ReviewItem | null;
  pr: GitHubReviewPullRequest | null;
  warning: string | null;
}

export interface RawAuthor { login?: string }
export interface RawComment { author?: RawAuthor | null; body?: string; url?: string }
export interface RawReview { id?: string | number; author?: RawAuthor | null; body?: string; state?: string; submittedAt?: string; url?: string; commit?: { oid?: string } | null }
export interface RawReviewRequest { login?: string; name?: string; slug?: string }
export interface RawClosingIssueReference { number?: number }
export interface RawStatusCheck { conclusion?: string; status?: string; state?: string; name?: string; context?: string; workflowName?: string; startedAt?: string; createdAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string }
export interface RawPrView { number: number; title: string; state: string; url: string; headRefOid?: string; reviewDecision?: string | null; mergeStateStatus?: string | null; mergeable?: string | null; isDraft?: boolean; reviewRequests?: RawReviewRequest[]; reviews?: RawReview[]; latestReviews?: RawReview[]; comments?: RawComment[]; statusCheckRollup?: RawStatusCheck[]; closingIssuesReferences?: RawClosingIssueReference[] }
export interface RawIssueComment { body?: string; html_url?: string; user?: RawAuthor | null }
export interface RawReviewComment { body?: string; html_url?: string; path?: string; user?: { login?: string } | null }
export interface RawThreadComment {
  id?: string;
  databaseId?: number;
  body?: string;
  author?: RawAuthor | null;
  url?: string;
  path?: string;
  line?: number | null;
  originalLine?: number | null;
  diffHunk?: string;
  outdated?: boolean;
  createdAt?: string;
}
export interface RawThreadNode {
  id?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  viewerCanResolve?: boolean;
  viewerCanUnresolve?: boolean;
  comments?: { nodes?: RawThreadComment[] };
}
export interface RawThreadPage { nodes?: RawThreadNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
export interface RawThreadResponse { data?: { repository?: { pullRequest?: { reviewThreads?: RawThreadPage } | null } | null } }
export interface LoginResponse { login: string }
export interface GitHubReviewProviderOptions { exec?: GhExec; cwd?: string }
