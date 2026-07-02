import { jiraAdapterContract } from "@tjalve/qube-core";

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

export const jiraAdapter = jiraAdapterContract;
