import type { ReviewItem } from '../../core/review_item';
import type { GhExec } from '../../gh';

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

export interface GitHubReviewSnapshot {
  item: ReviewItem;
  pr: GitHubReviewPullRequest;
  reviewRequests: string[];
  commentsCount: number;
  reviewsCount: number;
  reviewCommentsCount: number;
  unresolvedThreadsCount: number;
  unavailable: string[];
}

export interface CurrentGitHubReview {
  item: ReviewItem | null;
  pr: GitHubReviewPullRequest | null;
  warning: string | null;
}

export interface RawAuthor { login?: string }
export interface RawComment { author?: RawAuthor | null; body?: string; url?: string }
export interface RawReview { author?: RawAuthor | null; body?: string; state?: string; submittedAt?: string; url?: string; commit?: { oid?: string } | null }
export interface RawReviewRequest { login?: string; name?: string; slug?: string }
export interface RawStatusCheck { conclusion?: string; status?: string; state?: string; name?: string; context?: string; startedAt?: string; createdAt?: string; completedAt?: string; detailsUrl?: string; targetUrl?: string }
export interface RawPrView { number: number; title: string; state: string; url: string; headRefOid?: string; reviewDecision?: string | null; mergeStateStatus?: string | null; mergeable?: string | null; isDraft?: boolean; reviewRequests?: RawReviewRequest[]; reviews?: RawReview[]; latestReviews?: RawReview[]; comments?: RawComment[]; statusCheckRollup?: RawStatusCheck[] }
export interface RawIssueComment { body?: string; html_url?: string; user?: RawAuthor | null }
export interface RawReviewComment { body?: string; html_url?: string; path?: string; user?: { login?: string } | null }
export interface RawThreadNode { id?: string; isResolved?: boolean; comments?: { nodes?: Array<{ body?: string; author?: RawAuthor | null; url?: string }> } }
export interface RawThreadPage { nodes?: RawThreadNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } }
export interface RawThreadResponse { data?: { repository?: { pullRequest?: { reviewThreads?: RawThreadPage } | null } | null } }
export interface LoginResponse { login: string }
export interface GitHubReviewProviderOptions { exec?: GhExec; cwd?: string }
