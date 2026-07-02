import { normalizeProviderSource, normalizeWorkItem, normalizeWorkItemKey, type WorkChecklist, type WorkItem, type WorkItemKey, type WorkPriority, type WorkProject, type WorkStatus } from "@tjalve/qube-core";

const PROVIDER_ID = "jira";

export interface JiraProject {
  readonly id?: string | null;
  readonly key?: string | null;
  readonly name?: string | null;
  readonly projectTypeKey?: string | null;
}

export interface JiraIssueType {
  readonly id?: string | null;
  readonly name?: string | null;
}

export interface JiraStatus {
  readonly id?: string | null;
  readonly name?: string | null;
  readonly statusCategory?: {
    readonly id?: number | null;
    readonly key?: string | null;
    readonly name?: string | null;
  } | null;
}

export interface JiraPriority {
  readonly id?: string | null;
  readonly name?: string | null;
}

export interface JiraUser {
  readonly accountId?: string | null;
  readonly displayName?: string | null;
  readonly emailAddress?: string | null;
  readonly name?: string | null;
}

export interface JiraComment {
  readonly id?: string | null;
  readonly author?: JiraUser | null;
  readonly body?: unknown;
  readonly created?: string | null;
  readonly updated?: string | null;
}

export interface JiraSprint {
  readonly id?: number | string | null;
  readonly name?: string | null;
  readonly state?: string | null;
  readonly endDate?: string | null;
}

export interface JiraLinkedIssue {
  readonly id?: string | null;
  readonly key?: string | null;
  readonly fields?: {
    readonly summary?: string | null;
    readonly status?: JiraStatus | null;
  } | null;
}

export interface JiraIssueLink {
  readonly id?: string | null;
  readonly type?: {
    readonly id?: string | null;
    readonly name?: string | null;
    readonly inward?: string | null;
    readonly outward?: string | null;
  } | null;
  readonly inwardIssue?: JiraLinkedIssue | null;
  readonly outwardIssue?: JiraLinkedIssue | null;
}

export interface JiraIssueFields {
  readonly summary?: string | null;
  readonly description?: unknown;
  readonly issuetype?: JiraIssueType | null;
  readonly status?: JiraStatus | null;
  readonly priority?: JiraPriority | null;
  readonly labels?: readonly string[] | null;
  readonly components?: ReadonlyArray<{ readonly id?: string | null; readonly name?: string | null }> | null;
  readonly assignee?: JiraUser | null;
  readonly project?: JiraProject | null;
  readonly comment?: { readonly comments?: readonly JiraComment[] | null; readonly total?: number | null } | null;
  readonly issuelinks?: readonly JiraIssueLink[] | null;
  readonly parent?: JiraLinkedIssue | null;
  readonly [customField: string]: unknown;
}

export interface JiraIssue {
  readonly id: string;
  readonly key: string;
  readonly self?: string | null;
  readonly fields?: JiraIssueFields | null;
}

export type JiraLinkRelation = "blocker" | "blockedBy" | "ignore";

export interface JiraIssueLinkRule {
  readonly typeName: string;
  readonly inward: JiraLinkRelation;
  readonly outward: JiraLinkRelation;
}

export interface JiraWorkflowSchema {
  readonly statusMap?: Readonly<Record<string, WorkStatus>>;
  readonly openStatusNames?: readonly string[];
  readonly closedStatusNames?: readonly string[];
  readonly priorityMap?: Readonly<Record<string, WorkPriority>>;
  readonly linkRules?: readonly JiraIssueLinkRule[];
  readonly sprintField?: string;
  readonly epicField?: string;
}

const DEFAULT_SCHEMA: Required<JiraWorkflowSchema> = Object.freeze({
  statusMap: Object.freeze({
    backlog: "ready",
    "selected for development": "ready",
    "to do": "ready",
    todo: "ready",
    open: "ready",
    "in progress": "in-progress",
    blocked: "blocked",
    done: "unknown",
    closed: "unknown",
    resolved: "unknown",
  }),
  openStatusNames: Object.freeze(["backlog", "selected for development", "to do", "todo", "open", "in progress", "blocked"]),
  closedStatusNames: Object.freeze(["done", "closed", "resolved"]),
  priorityMap: Object.freeze({
    highest: "critical",
    blocker: "critical",
    critical: "critical",
    high: "high",
    medium: "medium",
    normal: "medium",
    low: "low",
    lowest: "low",
  }),
  linkRules: Object.freeze([
    Object.freeze({ typeName: "blocks", inward: "blocker", outward: "blockedBy" }),
    Object.freeze({ typeName: "blocked by", inward: "blocker", outward: "blockedBy" }),
  ]),
  sprintField: "",
  epicField: "",
});

export function jiraIssueKey(key: string): WorkItemKey {
  return normalizeWorkItemKey(PROVIDER_ID, key);
}

function normalizeName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function schemaWithDefaults(schema: JiraWorkflowSchema | undefined): Required<JiraWorkflowSchema> {
  return {
    statusMap: { ...DEFAULT_SCHEMA.statusMap, ...normalizeMap(schema?.statusMap) },
    openStatusNames: schema?.openStatusNames ?? DEFAULT_SCHEMA.openStatusNames,
    closedStatusNames: schema?.closedStatusNames ?? DEFAULT_SCHEMA.closedStatusNames,
    priorityMap: { ...DEFAULT_SCHEMA.priorityMap, ...normalizeMap(schema?.priorityMap) },
    linkRules: schema?.linkRules ?? DEFAULT_SCHEMA.linkRules,
    sprintField: schema?.sprintField ?? DEFAULT_SCHEMA.sprintField,
    epicField: schema?.epicField ?? DEFAULT_SCHEMA.epicField,
  };
}

function normalizeMap<T extends string>(map: Readonly<Record<string, T>> | undefined): Record<string, T> {
  const normalized: Record<string, T> = {};
  for (const [key, value] of Object.entries(map ?? {})) {
    normalized[normalizeName(key)] = value;
  }
  return normalized;
}

function mapStatus(issue: JiraIssue, schema: Required<JiraWorkflowSchema>): WorkStatus {
  const statusName = normalizeName(issue.fields?.status?.name);
  const mapped = schema.statusMap[statusName];
  if (mapped) return mapped;
  const category = normalizeName(issue.fields?.status?.statusCategory?.key ?? issue.fields?.status?.statusCategory?.name);
  if (category === "indeterminate") return "in-progress";
  if (category === "new") return "ready";
  return "unknown";
}

function mapState(issue: JiraIssue, schema: Required<JiraWorkflowSchema>): WorkItem["state"] {
  const statusName = normalizeName(issue.fields?.status?.name);
  const category = normalizeName(issue.fields?.status?.statusCategory?.key ?? issue.fields?.status?.statusCategory?.name);
  if (schema.closedStatusNames.map(normalizeName).includes(statusName) || category === "done") return "closed";
  if (schema.openStatusNames.map(normalizeName).includes(statusName) || category === "new" || category === "indeterminate") return "open";
  return "open";
}

function mapPriority(issue: JiraIssue, schema: Required<JiraWorkflowSchema>): WorkPriority {
  const priorityName = normalizeName(issue.fields?.priority?.name);
  return schema.priorityMap[priorityName] ?? "none";
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join("\n");
  const record = value as Readonly<Record<string, unknown>>;
  const text = typeof record.text === "string" ? record.text : "";
  const content = Array.isArray(record.content) ? record.content.map(plainText).filter(Boolean).join("\n") : "";
  return [text, content].filter(Boolean).join(text && content ? " " : "");
}

function labelsFromIssue(issue: JiraIssue): string[] {
  return (issue.fields?.labels ?? []).map(label => label.trim()).filter(label => label !== "");
}

function componentsFromIssue(issue: JiraIssue): string[] {
  return (issue.fields?.components ?? [])
    .map(component => component.name ?? "")
    .map(name => name.trim())
    .filter(name => name !== "");
}

function assigneesFromIssue(issue: JiraIssue): string[] {
  const user = issue.fields?.assignee;
  if (!user) return [];
  const name = user.displayName ?? user.emailAddress ?? user.name ?? "";
  return name.trim() === "" ? [] : [name.trim()];
}

function mapProject(issue: JiraIssue): WorkProject | null {
  const project = issue.fields?.project;
  if (!project) return null;
  return {
    id: project.key ?? project.id ?? "jira-project",
    title: project.name ?? project.key ?? project.id ?? "Jira project",
    state: "unknown",
    dueOn: null,
  };
}

function sprintValues(issue: JiraIssue, schema: Required<JiraWorkflowSchema>): JiraSprint[] {
  if (!schema.sprintField) return [];
  const value = issue.fields?.[schema.sprintField];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JiraSprint => typeof item === "object" && item !== null);
}

function epicKey(issue: JiraIssue, schema: Required<JiraWorkflowSchema>): string | null {
  if (!schema.epicField) return null;
  const value = issue.fields?.[schema.epicField];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function relationRule(link: JiraIssueLink, schema: Required<JiraWorkflowSchema>): JiraIssueLinkRule | null {
  const typeNames = [link.type?.name, link.type?.inward, link.type?.outward].map(normalizeName);
  return schema.linkRules.find(rule => typeNames.includes(normalizeName(rule.typeName))) ?? null;
}

function linkedKey(issue: JiraLinkedIssue | null | undefined): WorkItemKey | null {
  return issue?.key ? jiraIssueKey(issue.key) : null;
}

function issueLinks(issue: JiraIssue, schema: Required<JiraWorkflowSchema>, relation: JiraLinkRelation): WorkItemKey[] {
  const keys: WorkItemKey[] = [];
  for (const link of issue.fields?.issuelinks ?? []) {
    const rule = relationRule(link, schema);
    if (!rule) continue;
    if (rule.inward === relation) {
      const key = linkedKey(link.inwardIssue);
      if (key) keys.push(key);
    }
    if (rule.outward === relation) {
      const key = linkedKey(link.outwardIssue);
      if (key) keys.push(key);
    }
  }
  return keys;
}

function parseWorkChecklist(description: string): WorkChecklist {
  const items = [...description.matchAll(/^\s*-\s+\[(x|X| )\]\s+/gm)];
  return { total: items.length, completed: items.filter(item => item[1].toLowerCase() === "x").length };
}

function parseWorkSequence(description: string): string | null {
  const match = /^Sequence:\s*(\d+)\s*$/m.exec(description);
  return match ? match[1] : null;
}

function comments(issue: JiraIssue): { readonly count: number; readonly latestAuthors: readonly string[] } {
  const commentList = issue.fields?.comment?.comments ?? [];
  const count = issue.fields?.comment?.total ?? commentList.length;
  const latestAuthors = commentList
    .slice(-3)
    .map(comment => comment.author?.displayName ?? comment.author?.emailAddress ?? comment.author?.name ?? "")
    .map(author => author.trim())
    .filter(author => author !== "");
  return { count, latestAuthors };
}

export function attachJiraBlockedBy(items: WorkItem[]): WorkItem[] {
  const blockedBy = new Map<string, WorkItemKey[]>();
  for (const item of items) {
    for (const blocker of item.blockers) {
      const key = JSON.stringify([blocker.providerId, blocker.id]);
      const current = blockedBy.get(key);
      if (current) {
        current.push(item.key);
      } else {
        blockedBy.set(key, [item.key]);
      }
    }
  }
  return items.map((item) => normalizeWorkItem({
    ...item,
    blockedBy: [...item.blockedBy, ...(blockedBy.get(JSON.stringify([item.key.providerId, item.key.id])) ?? [])],
  }));
}

export function jiraIssueToWorkItem(issue: JiraIssue, workflowSchema?: JiraWorkflowSchema): WorkItem {
  const schema = schemaWithDefaults(workflowSchema);
  const body = plainText(issue.fields?.description);
  const labels = labelsFromIssue(issue);
  const components = componentsFromIssue(issue);
  const sprints = sprintValues(issue, schema);
  const commentSummary = comments(issue);
  const tags = [
    ...labels,
    ...components.map(component => `jira:component:${component}`),
    issue.fields?.issuetype?.name ? `jira:type:${issue.fields.issuetype.name}` : null,
    issue.fields?.status?.name ? `jira:status:${issue.fields.status.name}` : null,
    issue.fields?.priority?.name ? `jira:priority:${issue.fields.priority.name}` : null,
    ...sprints.map(sprint => sprint.name ? `jira:sprint:${sprint.name}` : null),
  ].filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "");
  return normalizeWorkItem({
    key: jiraIssueKey(issue.key),
    displayId: issue.key,
    title: issue.fields?.summary ?? issue.key,
    body,
    url: issue.self ?? null,
    state: mapState(issue, schema),
    status: mapStatus(issue, schema),
    priority: mapPriority(issue, schema),
    tags,
    assignees: assigneesFromIssue(issue),
    project: mapProject(issue),
    blockers: issueLinks(issue, schema, "blocker"),
    blockedBy: issueLinks(issue, schema, "blockedBy"),
    sequence: parseWorkSequence(body),
    checklist: parseWorkChecklist(body),
    trustedMetadata: {
      jiraIssueId: issue.id,
      jiraKey: issue.key,
      jiraProjectKey: issue.fields?.project?.key ?? null,
      jiraIssueType: issue.fields?.issuetype?.name ?? null,
      jiraStatus: issue.fields?.status?.name ?? null,
      jiraStatusCategory: issue.fields?.status?.statusCategory?.key ?? issue.fields?.status?.statusCategory?.name ?? null,
      jiraPriority: issue.fields?.priority?.name ?? null,
      jiraLabels: labels,
      jiraComponents: components,
      jiraSprints: sprints.map(sprint => sprint.name ?? String(sprint.id ?? "")),
      jiraEpicKey: epicKey(issue, schema),
      jiraCommentCount: commentSummary.count,
      jiraLatestCommentAuthors: commentSummary.latestAuthors,
    },
    source: normalizeProviderSource({
      providerId: PROVIDER_ID,
      resourceKind: "work-item",
      resourceId: issue.key,
      url: issue.self ?? null,
      metadata: {
        jiraIssueId: issue.id,
        jiraKey: issue.key,
        jiraProjectKey: issue.fields?.project?.key ?? null,
      },
    }),
  });
}
