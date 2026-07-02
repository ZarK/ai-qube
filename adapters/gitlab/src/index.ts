import { gitLabAdapterContract } from "@tjalve/qube-core";

export { renderGitLabIssueDraft } from "./render_gitlab_draft.js";
export type { GitLabIssueDraft, GitLabWorkItemDraft } from "./render_gitlab_draft.js";
export { attachGitLabBlockedBy, gitLabIssueToWorkItem, gitLabWorkItemKey } from "./gitlab_work_codec.js";
export type { GitLabIssue, GitLabIssueLink, GitLabLinkedIssue, GitLabMilestone, GitLabUser } from "./gitlab_work_codec.js";
export { createGitLabWorkProvider, GitLabWorkProvider } from "./gitlab_work_provider.js";
export type { GitLabRestClient, GitLabWorkProviderOptions } from "./gitlab_work_provider.js";

export const gitLabAdapter = gitLabAdapterContract;
