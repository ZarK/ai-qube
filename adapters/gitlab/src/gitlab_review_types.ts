import type { ReviewItem, ReviewLaneReviewPublishInput } from "@tjalve/qube-core";

export interface GitLabUser {
  readonly id?: number;
  readonly name?: string;
  readonly username?: string;
}

export interface GitLabPipeline {
  readonly id: number;
  readonly status: string;
  readonly sha?: string;
  readonly web_url?: string;
}

export interface GitLabMergeRequest {
  readonly id?: number;
  readonly iid: number;
  readonly project_id?: number;
  readonly title: string;
  readonly description?: string | null;
  readonly state: string;
  readonly web_url: string;
  readonly source_branch?: string;
  readonly target_branch?: string;
  readonly sha?: string | null;
  readonly merge_commit_sha?: string | null;
  readonly squash_commit_sha?: string | null;
  readonly detailed_merge_status?: string | null;
  readonly merge_status?: string | null;
  readonly draft?: boolean;
  readonly work_in_progress?: boolean;
  readonly reviewers?: GitLabUser[];
  readonly assignees?: GitLabUser[];
  readonly head_pipeline?: GitLabPipeline | null;
  readonly references?: { readonly short?: string; readonly relative?: string; readonly full?: string };
}

export interface GitLabNote {
  readonly id: number;
  readonly body: string;
  readonly author?: GitLabUser | null;
  readonly system?: boolean;
  readonly resolvable?: boolean;
  readonly resolved?: boolean;
  readonly noteable_type?: string;
  readonly type?: string | null;
  readonly position?: { readonly new_path?: string; readonly old_path?: string; readonly new_line?: number; readonly old_line?: number; readonly outdated?: boolean; readonly line_range?: { readonly start?: { readonly outdated?: boolean }; readonly end?: { readonly outdated?: boolean } } } | null;
  readonly web_url?: string;
}

export interface GitLabDiscussion {
  readonly id: string;
  readonly individual_note?: boolean;
  readonly notes?: GitLabNote[];
}

export interface GitLabReviewRestClient {
  getMergeRequest(input: { projectId: string; iid: string }): Promise<GitLabMergeRequest>;
  findMergeRequestForBranch?(input: { projectId: string; sourceBranch: string }): Promise<GitLabMergeRequest | null>;
  listMergeRequestNotes(input: { projectId: string; iid: string }): Promise<GitLabNote[]>;
  listMergeRequestDiscussions(input: { projectId: string; iid: string }): Promise<GitLabDiscussion[]>;
  resolveMergeRequestDiscussion?(input: { projectId: string; iid: string; discussionId: string }): Promise<GitLabDiscussion>;
  createMergeRequestNote(input: { projectId: string; iid: string; body: string }): Promise<GitLabNote>;
  updateMergeRequestNote?(input: { projectId: string; iid: string; noteId: string; body: string }): Promise<GitLabNote>;
  getCurrentUser?(): Promise<GitLabUser>;
}

export interface GitLabReviewProviderOptions {
  readonly client?: GitLabReviewRestClient;
  readonly token?: string;
  readonly projectId?: string;
  readonly baseUrl?: string;
  readonly requestTimeoutMs?: number;
  readonly currentBranch?: string;
  readonly maxReviewPages?: number;
  readonly maxReviewItems?: number;
  readonly maxResponseBytes?: number;
}

export interface GitLabReviewPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly headRefOid: string;
  readonly reviewDecision: string;
  readonly mergeStateStatus: string;
  readonly mergeable: string;
  readonly isDraft: boolean;
}

export interface GitLabCiDiagnostic {
  readonly checkName: string;
  readonly status: "mapped" | "pending-current-head-run" | "failed-current-head-run" | "skipped-current-head-run" | "unknown";
  readonly reasonCode: "current-head-workflow-run-found" | "current-head-check-run-pending" | "current-head-check-run-failed" | "current-head-check-run-skipped" | "ci-mapping-unknown";
  readonly currentHeadSha: string;
  readonly mappedToCurrentHeadCheckRun: boolean;
  readonly mappedToCurrentHeadWorkflowRun: boolean;
  readonly currentHeadSuiteIds: string[];
  readonly currentHeadRunIds: string[];
  readonly staleRunIds: string[];
  readonly workflowDispatchSupported: boolean | null;
  readonly summary: string;
  readonly nextAction: string;
}

export interface GitLabReviewSnapshot {
  readonly item: ReviewItem;
  readonly pr: GitLabReviewPullRequest;
  readonly ciDiagnostics: GitLabCiDiagnostic[];
  readonly closingIssueNumbers: number[];
  readonly reviewRequests: string[];
  readonly commentsCount: number;
  readonly reviewsCount: number;
  readonly reviewCommentsCount: number;
  readonly unresolvedThreadsCount: number;
  readonly conversationsCount: number;
  readonly unavailable: string[];
}

export interface GitLabMetadata {
  readonly version: number;
  readonly kind: "review-request" | "lane-review";
  readonly head: string;
  readonly reviewerId?: string;
  readonly lane?: string;
  readonly expectedLanes?: readonly string[];
  readonly round?: string;
  /** A superseded marker preserves a replaced verdict for history readers; live read paths ignore it. */
  readonly superseded?: boolean;
  readonly profile?: string;
  readonly runId?: string;
  readonly issueNumber?: number;
  readonly prNumber?: number;
  readonly host?: string;
  readonly recommendation?: ReviewLaneReviewPublishInput["recommendation"];
  readonly status?: string;
  readonly summary?: string;
  readonly inline?: "gitlab-note";
  readonly bodyFindingCount?: number;
  readonly inlineCommentCount?: number;
  readonly findingDigest?: string;
}
