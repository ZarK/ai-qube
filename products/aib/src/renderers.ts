import type { WorkItemDraft } from "./contracts.js";

export interface MarkdownWorkItem {
  readonly path: string;
  readonly content: string;
}

export interface GitHubIssueDraft {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly blockedBy: readonly number[];
  readonly url?: string;
}

export function renderMarkdownWorkItemDraft(draft: WorkItemDraft, outputDir = "docs/issues"): MarkdownWorkItem {
  return {
    path: `${outputDir}/${safeFileName(draft.draftId)}.md`,
    content: renderDraftBody(draft)
  };
}

export function renderGitHubIssueDraft(draft: WorkItemDraft): GitHubIssueDraft {
  const metadata = readGithubMetadata(draft.providerMetadata?.github);
  const labels = [
    priorityLabel(draft.priority),
    statusLabel(draft.status),
    ...draft.components.map((component) => `C-${component}`)
  ];

  return {
    title: draft.title,
    body: renderDraftBody(draft, metadata.blockedBy),
    labels,
    blockedBy: metadata.blockedBy,
    ...(metadata.url ? { url: metadata.url } : {})
  };
}

function renderDraftBody(draft: WorkItemDraft, providerBlockers: readonly (number | string)[] = []): string {
  const blockers = providerBlockers.length > 0
    ? providerBlockers.map((blocker) => typeof blocker === "number" ? `Blocked by: #${blocker}` : `Blocked by: ${blocker}`)
    : (draft.blockedBy ?? []).map((blocker) => `Blocked by: ${blocker}`);
  const sequence = draft.sequence === undefined ? [] : [`Sequence: ${draft.sequence}`];
  const metadata = [...blockers, ...sequence];
  const sections = draft.bodySections.map((section) => `## ${section.heading}\n\n${section.body.trim()}`);
  return [...metadata, "", `# ${draft.title}`, "", ...sections].join("\n").trimEnd() + "\n";
}

function readGithubMetadata(value: unknown): { readonly blockedBy: readonly number[]; readonly url?: string } {
  if (!isRecord(value)) {
    return { blockedBy: [] };
  }
  const blockedBy = Array.isArray(value.blockedBy)
    ? value.blockedBy.filter((item): item is number => Number.isSafeInteger(item) && item > 0)
    : [];
  return {
    blockedBy,
    ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {})
  };
}

function priorityLabel(priority: WorkItemDraft["priority"]): string {
  if (priority === "critical") return "P1-Critical";
  if (priority === "high") return "P2-High";
  if (priority === "low") return "P4-Low";
  return "P3-Normal";
}

function statusLabel(status: WorkItemDraft["status"]): string {
  if (status === "blocked") return "S-Blocked";
  if (status === "ready" || status === "rendered") return "S-Ready";
  return "S-Draft";
}

function safeFileName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "work-item";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
