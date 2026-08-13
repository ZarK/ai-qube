import { gitLabAdapterContract } from "@tjalve/qube-core";

export { probeGitLabConnection } from "./connection.js";

export { renderGitLabIssueDraft } from "./render_gitlab_draft.js";
export type { GitLabIssueDraft, GitLabWorkItemDraft } from "./render_gitlab_draft.js";
export { attachGitLabBlockedBy, gitLabIssueToWorkItem, gitLabWorkItemKey } from "./gitlab_work_codec.js";
export type { GitLabIssue, GitLabIssueLink, GitLabLinkedIssue, GitLabMilestone, GitLabUser } from "./gitlab_work_codec.js";
export { createGitLabWorkProvider, GitLabWorkProvider } from "./gitlab_work_provider.js";
export type { GitLabRestClient, GitLabFetch, GitLabWorkProviderOptions } from "./gitlab_work_provider.js";
export {
  createGitLabReviewForgeProvider,
  createGitLabReviewProvider,
  GitLabReviewForgeProvider,
} from "./gitlab_review_forge.js";
export type {
  GitLabReviewProvider,
} from "./gitlab_review_forge.js";
export type {
  GitLabCiDiagnostic,
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabNote,
  GitLabReviewFetch, GitLabReviewProviderOptions,
  GitLabReviewPullRequest,
  GitLabReviewRestClient,
  GitLabReviewSnapshot,
} from "./gitlab_review_types.js";

export const gitLabAdapter = gitLabAdapterContract;
