import { defineQubeAdapter } from "@tjalve/qube-core";

export { renderGitLabIssueDraft } from "./render_gitlab_draft.js";
export type { GitLabIssueDraft, GitLabWorkItemDraft } from "./render_gitlab_draft.js";
export { attachGitLabBlockedBy, gitLabIssueToWorkItem, gitLabWorkItemKey } from "./gitlab_work_codec.js";
export type { GitLabIssue, GitLabIssueLink, GitLabLinkedIssue, GitLabMilestone, GitLabUser } from "./gitlab_work_codec.js";
export { createGitLabWorkProvider, GitLabWorkProvider } from "./gitlab_work_provider.js";
export type { GitLabRestClient, GitLabWorkProviderOptions } from "./gitlab_work_provider.js";

export const gitLabAdapter = defineQubeAdapter({
  id: "gitlab",
  packageName: "@tjalve/qube-adapter-gitlab",
  surface: "gitlab",
  owns: [
    "gitlab-rest-client",
    "gitlab-work-item-mapping",
    "gitlab-draft-rendering",
    "self-managed-url-handling",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "GitLab API access, issue mapping, draft rendering, capability flags, credential diagnostics, self-managed URL handling, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: [
    {
      id: "map-work-item",
      support: "supported",
      owner: "@tjalve/qube-adapter-gitlab",
      summary: "Map GitLab issues, labels, milestones, assignees, task completion, issue links, blockers, and source metadata into QUBE work items.",
    },
    {
      id: "work-item-queue",
      support: "supported",
      owner: "@tjalve/qube-adapter-gitlab",
      summary: "Read paginated GitLab project issues through GitLab.com or self-managed GitLab REST APIs and normalize reverse blocker links for queue ordering.",
    },
    {
      id: "render-work-items",
      support: "supported",
      owner: "@tjalve/qube-adapter-gitlab",
      summary: "Render provider-neutral AIB work item drafts into GitLab issue previews without mutating GitLab.",
    },
    {
      id: "sync-issue-status",
      support: "unsupported",
      owner: "@tjalve/qube-adapter-gitlab",
      summary: "GitLab lifecycle, merge request, approval, and CI pipeline mutations require explicit mutation adapters and are reported as unsupported.",
    },
  ],
  contractOnly: false,
});
