export interface GitLabWorkItemDraft {
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
    readonly gitlab?: unknown;
  };
}

export interface GitLabIssueDraft {
  readonly title: string;
  readonly description: string;
  readonly labels: readonly string[];
  readonly blockedBy: readonly number[];
  readonly milestone?: string;
  readonly url?: string;
}

export function renderGitLabIssueDraft(draft: GitLabWorkItemDraft): GitLabIssueDraft {
  const metadata = readGitLabMetadata(draft.providerMetadata?.gitlab);
  return {
    title: draft.title,
    description: renderDraftBody(draft, metadata.blockedBy),
    labels: metadata.labels.length > 0 ? metadata.labels : [
      priorityLabel(draft.priority),
      statusLabel(draft.status),
      ...draft.components.map((component) => `C-${component}`),
    ],
    blockedBy: metadata.blockedBy,
    ...(metadata.milestone ? { milestone: metadata.milestone } : {}),
    ...(metadata.url ? { url: metadata.url } : {}),
  };
}

function renderDraftBody(draft: GitLabWorkItemDraft, providerBlockers: readonly (number | string)[] = []): string {
  const blockers = providerBlockers.length > 0
    ? providerBlockers.map((blocker) => typeof blocker === "number" ? `Blocked by: #${blocker}` : `Blocked by: ${blocker}`)
    : (draft.blockedBy ?? []).map((blocker) => `Blocked by: ${blocker}`);
  const sequence = draft.sequence === undefined ? [] : [`Sequence: ${draft.sequence}`];
  const metadata = [...blockers, ...sequence];
  const sections = draft.bodySections.map((section) => `## ${section.heading}\n\n${section.body.trim()}`);
  return [...metadata, "", `# ${draft.title}`, "", ...sections].join("\n").trimEnd() + "\n";
}

function readGitLabMetadata(value: unknown): { readonly blockedBy: readonly number[]; readonly labels: readonly string[]; readonly milestone?: string; readonly url?: string } {
  if (!isRecord(value)) {
    return { blockedBy: [], labels: [] };
  }
  const blockedBy = Array.isArray(value.blockedBy)
    ? value.blockedBy.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
  const labels = Array.isArray(value.labels)
    ? value.labels.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    blockedBy,
    labels,
    ...(typeof value.milestone === "string" && value.milestone.length > 0 ? { milestone: value.milestone } : {}),
    ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {}),
  };
}

function priorityLabel(priority: GitLabWorkItemDraft["priority"]): string {
  if (priority === "critical") return "P1-Critical";
  if (priority === "high") return "P2-High";
  if (priority === "low") return "P4-Low";
  return "P3-Normal";
}

function statusLabel(status: GitLabWorkItemDraft["status"]): string {
  if (status === "blocked") return "S-Blocked";
  if (status === "ready" || status === "rendered") return "S-Ready";
  return "S-Draft";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
