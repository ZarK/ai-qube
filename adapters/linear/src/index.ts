import { defineQubeAdapter } from "@tjalve/qube-core";

export { renderLinearIssueDraft } from "./render_linear_draft.js";
export type { LinearIssueDraft, LinearWorkItemDraft } from "./render_linear_draft.js";
export { attachLinearBlockedBy, linearIssueToWorkItem, linearWorkItemKey, parseLinearBlockerKeys } from "./linear_work_codec.js";
export type { LinearIssue, LinearIssueRelation, LinearLabel, LinearProject, LinearTeam, LinearUser, LinearWorkflowState, LinearWorkflowType } from "./linear_work_codec.js";
export { createLinearWorkProvider, LinearWorkProvider } from "./linear_work_provider.js";
export type { LinearGraphqlClient, LinearWorkProviderOptions } from "./linear_work_provider.js";

export const linearAdapter = defineQubeAdapter({
  id: "linear",
  packageName: "@tjalve/qube-adapter-linear",
  surface: "linear",
  owns: [
    "linear-graphql-client",
    "linear-work-item-mapping",
    "linear-draft-rendering",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "Linear API access, issue mapping, draft rendering, capability flags, credential diagnostics, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: [
    {
      id: "map-work-item",
      support: "supported",
      owner: "@tjalve/qube-adapter-linear",
      summary: "Map Linear issues, workflow state, relations, labels, project metadata, assignee, checklist state, and source metadata into QUBE work items.",
    },
    {
      id: "work-item-queue",
      support: "supported",
      owner: "@tjalve/qube-adapter-linear",
      summary: "Read Linear team issues through the Linear GraphQL API and normalize reverse blocker links for queue ordering.",
    },
    {
      id: "render-work-items",
      support: "supported",
      owner: "@tjalve/qube-adapter-linear",
      summary: "Render provider-neutral AIB work item drafts into Linear issue previews without mutating Linear.",
    },
    {
      id: "sync-issue-status",
      support: "unsupported",
      owner: "@tjalve/qube-adapter-linear",
      summary: "Linear lifecycle mutations require explicit team workflow-state configuration and are reported as unsupported.",
    },
  ],
  contractOnly: false,
});
