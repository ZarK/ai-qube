import type { WorkItemDraft } from "./contracts.js";

export interface WorkItemLintDiagnostic {
  readonly code: string;
  readonly draftId: string;
  readonly message: string;
}

export class WorkItemLintError extends Error {
  readonly diagnostics: readonly WorkItemLintDiagnostic[];

  constructor(diagnostics: readonly WorkItemLintDiagnostic[]) {
    super(`work item lint failed: ${diagnostics.map((entry) => `[${entry.code}] ${entry.draftId}: ${entry.message}`).join("; ")}`);
    this.name = "WorkItemLintError";
    this.diagnostics = diagnostics;
  }
}

const CRITERION_LINE = /^- \[[ x]\] (.*)$/u;
const VERIFICATION_MARKER = /\(verify: (?:unit|integration|manual observation|artifact review)(?:;|\))/u;
const SHARED_MARKER = /\(verify: [^)]*; shared with /u;
const SHARED_REASON = /; shared with [^:)]+: [^)]+(?:;|\))/u;
const DEFAULTED_ALLOCATION = /; allocation defaulted: no theme matched\)/u;
const VAGUE_PHRASES = /\b(?:works?\s+correctly|handles?\s+errors?|is\s+robust|functions?\s+properly|behaves?\s+as\s+expected)\b/iu;
const OBSERVABLE_OUTCOME = /\b(?:loud(?:ly)?|exit\s+code|error\s+message|returns?|renders?|rejects?\s+with|asserts?|fails?\s+with|reports?|lists?|exposes?|counts?|checkbox)\b/iu;

function criteriaLines(draft: WorkItemDraft): string[] {
  const criteriaSection = draft.bodySections.find((section) => section.heading.toLowerCase() === "acceptance criteria");
  if (!criteriaSection) return [];
  return criteriaSection.body
    .split("\n")
    .map((line) => line.trim())
    .map((line) => CRITERION_LINE.exec(line)?.[1])
    .filter((line): line is string => line !== undefined && line.length > 0);
}

function isExecutable(draft: WorkItemDraft): boolean {
  return draft.status !== "draft";
}

export function lintWorkItemDrafts(drafts: readonly WorkItemDraft[]): readonly WorkItemLintDiagnostic[] {
  const diagnostics: WorkItemLintDiagnostic[] = [];
  const criteriaByDraft = new Map(drafts.map((draft) => [draft.draftId, criteriaLines(draft)]));

  for (const draft of drafts) {
    const criteria = criteriaByDraft.get(draft.draftId) ?? [];
    if (isExecutable(draft) && criteria.length === 0) {
      diagnostics.push({ code: "work-item-empty-criteria", draftId: draft.draftId, message: "Executable work item has no acceptance criteria checkboxes." });
    }
    for (const criterion of criteria) {
      if (!VERIFICATION_MARKER.test(criterion)) {
        diagnostics.push({ code: "work-item-missing-verification", draftId: draft.draftId, message: `Criterion has no verification kind: "${criterion}"` });
      }
      if (VAGUE_PHRASES.test(criterion) && !OBSERVABLE_OUTCOME.test(criterion)) {
        diagnostics.push({ code: "work-item-vague-criterion", draftId: draft.draftId, message: `Criterion states no observable behavior: "${criterion}"` });
      }
      if (SHARED_MARKER.test(criterion) && !SHARED_REASON.test(criterion)) {
        diagnostics.push({ code: "work-item-shared-without-reason", draftId: draft.draftId, message: `Shared criterion has no stated reason: "${criterion}"` });
      }
      // A defaulted owner is safe when the milestone yields one slice (ownership by elimination);
      // with siblings present it is an undecided allocation and must be resolved by the author.
      if (drafts.length > 1 && DEFAULTED_ALLOCATION.test(criterion)) {
        diagnostics.push({ code: "work-item-unallocated-criterion", draftId: draft.draftId, message: `Criterion matched no theme and was defaulted while sibling slices exist: "${criterion}"` });
      }
    }
  }

  if (drafts.length > 1) {
    const sets = drafts.map((draft) => (criteriaByDraft.get(draft.draftId) ?? []).join("\n"));
    const allIdentical = sets.every((set) => set === sets[0]) && sets[0] !== "";
    if (allIdentical) {
      for (const draft of drafts) {
        diagnostics.push({ code: "work-item-duplicate-criteria", draftId: draft.draftId, message: "All sibling work items carry an identical acceptance criteria set." });
      }
    }
  }

  return diagnostics;
}

export function assertWorkItemDraftsLint(drafts: readonly WorkItemDraft[]): void {
  const diagnostics = lintWorkItemDrafts(drafts);
  if (diagnostics.length > 0) throw new WorkItemLintError(diagnostics);
}
