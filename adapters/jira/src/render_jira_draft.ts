export interface JiraWorkItemDraft {
  readonly draftId?: string;
  readonly title: string;
  readonly priority: "critical" | "high" | "normal" | "low";
  readonly status: "draft" | "ready" | "blocked" | "rendered";
  readonly components: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly sequence?: number;
  readonly bodySections: ReadonlyArray<{
    readonly heading: string;
    readonly body: string;
  }>;
  readonly providerMetadata?: {
    readonly jira?: unknown;
  };
}

export interface JiraIssueDraft {
  readonly summary: string;
  readonly description: string;
  readonly issueType: string;
  readonly priorityName: string;
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly blockedBy: readonly string[];
  readonly projectKey?: string;
  readonly url?: string;
}

export function renderJiraIssueDraft(draft: JiraWorkItemDraft): JiraIssueDraft {
  const metadata = readJiraMetadata(draft.providerMetadata?.jira);
  return {
    summary: draft.title,
    description: renderDraftBody(draft, metadata.blockedBy),
    issueType: metadata.issueType ?? "Task",
    priorityName: metadata.priorityName ?? priorityName(draft.priority),
    labels: metadata.labels.length > 0 ? metadata.labels : [
      statusName(draft.status),
      ...draft.components.map((component) => component.toLowerCase()),
    ],
    components: metadata.components.length > 0 ? metadata.components : draft.components,
    blockedBy: metadata.blockedBy,
    ...(metadata.projectKey ? { projectKey: metadata.projectKey } : {}),
    ...(metadata.url ? { url: metadata.url } : {}),
  };
}

function renderDraftBody(draft: JiraWorkItemDraft, providerBlockers: readonly string[] = []): string {
  const blockers = providerBlockers.length > 0
    ? providerBlockers.map((blocker) => `Blocked by: ${blocker}`)
    : (draft.blockedBy ?? []).map((blocker) => `Blocked by: ${blocker}`);
  const sequence = draft.sequence === undefined ? [] : [`Sequence: ${draft.sequence}`];
  const metadata = [...blockers, ...sequence];
  const sections = draft.bodySections.map((section) => `## ${section.heading}\n\n${section.body.trim()}`);
  return [...metadata, "", `# ${draft.title}`, "", ...sections].join("\n").trimEnd() + "\n";
}

function readJiraMetadata(value: unknown): {
  readonly blockedBy: readonly string[];
  readonly labels: readonly string[];
  readonly components: readonly string[];
  readonly issueType?: string;
  readonly priorityName?: string;
  readonly projectKey?: string;
  readonly url?: string;
} {
  if (!isRecord(value)) {
    return { blockedBy: [], labels: [], components: [] };
  }
  const blockedBy = stringArray(value.blockedBy);
  const labels = stringArray(value.labels);
  const components = stringArray(value.components);
  return {
    blockedBy,
    labels,
    components,
    ...(typeof value.issueType === "string" && value.issueType.length > 0 ? { issueType: value.issueType } : {}),
    ...(typeof value.priorityName === "string" && value.priorityName.length > 0 ? { priorityName: value.priorityName } : {}),
    ...(typeof value.projectKey === "string" && value.projectKey.length > 0 ? { projectKey: value.projectKey } : {}),
    ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {}),
  };
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function priorityName(priority: JiraWorkItemDraft["priority"]): string {
  if (priority === "critical") return "Highest";
  if (priority === "high") return "High";
  if (priority === "low") return "Low";
  return "Medium";
}

function statusName(status: JiraWorkItemDraft["status"]): string {
  if (status === "blocked") return "blocked";
  if (status === "ready" || status === "rendered") return "ready";
  return "draft";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
