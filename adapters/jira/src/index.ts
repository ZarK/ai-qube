import { defineQubeAdapter } from "@tjalve/qube-core";

export { attachJiraBlockedBy, jiraIssueKey, jiraIssueToWorkItem } from "./jira_work_codec.js";
export type {
  JiraComment,
  JiraIssue,
  JiraIssueFields,
  JiraIssueLink,
  JiraIssueLinkRule,
  JiraPriority,
  JiraProject,
  JiraSprint,
  JiraStatus,
  JiraUser,
  JiraWorkflowSchema,
} from "./jira_work_codec.js";
export { createJiraWorkProvider, JiraWorkProvider } from "./jira_work_provider.js";
export type { JiraRestClient, JiraWorkProviderOptions } from "./jira_work_provider.js";
export { renderJiraIssueDraft } from "./render_jira_draft.js";
export type { JiraIssueDraft, JiraWorkItemDraft } from "./render_jira_draft.js";

export const jiraAdapter = defineQubeAdapter({
  id: "jira",
  packageName: "@tjalve/qube-adapter-jira",
  surface: "jira",
  owns: [
    "jira-rest-client",
    "jira-work-item-mapping",
    "jira-workflow-schema-mapping",
    "jira-draft-rendering",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "Jira API access, issue mapping, workflow schema mapping, draft rendering, capability flags, credential diagnostics, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: [
    {
      id: "map-work-item",
      support: "supported",
      owner: "@tjalve/qube-adapter-jira",
      summary: "Map Jira issues, issue types, projects, statuses, priorities, labels/components, assignees, sprints, epics, comments, issue links, and source metadata into QUBE work items.",
    },
    {
      id: "work-item-queue",
      support: "supported",
      owner: "@tjalve/qube-adapter-jira",
      summary: "Read Jira issues through Jira REST using configured JQL and normalize reverse blocker links for queue ordering.",
    },
    {
      id: "workflow-schema",
      support: "supported",
      owner: "@tjalve/qube-adapter-jira",
      summary: "Keep status, priority, completion, sprint, epic, and dependency mapping schema-driven for custom Jira workflows and fields.",
    },
    {
      id: "render-work-items",
      support: "supported",
      owner: "@tjalve/qube-adapter-jira",
      summary: "Render provider-neutral AIB work item drafts into Jira issue previews without mutating Jira.",
    },
    {
      id: "sync-issue-status",
      support: "unsupported",
      owner: "@tjalve/qube-adapter-jira",
      summary: "Jira lifecycle mutations require explicit workflow transition IDs and are reported as unsupported.",
    },
  ],
  contractOnly: false,
});
