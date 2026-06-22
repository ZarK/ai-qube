export interface LinearWorkItemDraft {
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
    readonly linear?: unknown;
  };
}

export interface LinearIssueDraft {
  readonly title: string;
  readonly description: string;
  readonly priority: number;
  readonly labelNames: readonly string[];
  readonly blockedBy: readonly string[];
  readonly teamKey?: string;
  readonly url?: string;
}

export function renderLinearIssueDraft(draft: LinearWorkItemDraft): LinearIssueDraft {
  const metadata = readLinearMetadata(draft.providerMetadata?.linear);
  return {
    title: draft.title,
    description: renderDraftBody(draft, metadata.blockedBy),
    priority: metadata.priority ?? linearPriority(draft.priority),
    labelNames: metadata.labelNames.length > 0 ? metadata.labelNames : [
      statusName(draft.status),
      ...draft.components.map((component) => component.toLowerCase()),
    ],
    blockedBy: metadata.blockedBy,
    ...(metadata.teamKey ? { teamKey: metadata.teamKey } : {}),
    ...(metadata.url ? { url: metadata.url } : {}),
  };
}

function renderDraftBody(draft: LinearWorkItemDraft, providerBlockers: readonly string[] = []): string {
  const blockers = providerBlockers.length > 0
    ? providerBlockers.map((blocker) => `Blocked by: ${blocker}`)
    : (draft.blockedBy ?? []).map((blocker) => `Blocked by: ${blocker}`);
  const sequence = draft.sequence === undefined ? [] : [`Sequence: ${draft.sequence}`];
  const metadata = [...blockers, ...sequence];
  const sections = draft.bodySections.map((section) => `## ${section.heading}\n\n${section.body.trim()}`);
  return [...metadata, "", `# ${draft.title}`, "", ...sections].join("\n").trimEnd() + "\n";
}

function readLinearMetadata(value: unknown): { readonly blockedBy: readonly string[]; readonly labelNames: readonly string[]; readonly priority?: number; readonly teamKey?: string; readonly url?: string } {
  if (!isRecord(value)) {
    return { blockedBy: [], labelNames: [] };
  }
  const blockedBy = Array.isArray(value.blockedBy)
    ? value.blockedBy.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const labelNames = Array.isArray(value.labelNames)
    ? value.labelNames.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  return {
    blockedBy,
    labelNames,
    ...(typeof value.priority === "number" && Number.isInteger(value.priority) && value.priority >= 0 && value.priority <= 4 ? { priority: value.priority } : {}),
    ...(typeof value.teamKey === "string" && value.teamKey.length > 0 ? { teamKey: value.teamKey } : {}),
    ...(typeof value.url === "string" && value.url.length > 0 ? { url: value.url } : {}),
  };
}

function linearPriority(priority: LinearWorkItemDraft["priority"]): number {
  if (priority === "critical") return 1;
  if (priority === "high") return 2;
  if (priority === "low") return 4;
  return 3;
}

function statusName(status: LinearWorkItemDraft["status"]): string {
  if (status === "blocked") return "blocked";
  if (status === "ready" || status === "rendered") return "ready";
  return "draft";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
