import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { renderGitLabIssueDraft, type GitLabIssueDraft } from "@tjalve/qube-adapter-gitlab";
import { renderJiraIssueDraft, type JiraIssueDraft } from "@tjalve/qube-adapter-jira";
import { renderLinearIssueDraft, type LinearIssueDraft } from "@tjalve/qube-adapter-linear";

import type { MilestoneDraft, PlanningArtifact, WorkItemDraft } from "./contracts.js";
import { renderGitHubIssueDraft, renderMarkdownWorkItemDraft, type GitHubIssueDraft, type MarkdownWorkItem } from "./renderers.js";
import type { BootstrapState } from "./state.js";

export type WorkItemRenderProvider = "github" | "gitlab" | "linear" | "jira" | "markdown";

export interface WorkItemDraftResult {
  readonly milestone: MilestoneDraft;
  readonly drafts: readonly WorkItemDraft[];
  readonly queueOrder: QueueOrderValidation;
  readonly rendered: readonly MarkdownWorkItem[];
  readonly artifacts: readonly PlanningArtifact[];
}

export interface RenderedGitHubWorkItem extends GitHubIssueDraft {
  readonly draftId: string;
}

export interface RenderedLinearWorkItem extends LinearIssueDraft {
  readonly draftId: string;
}

export interface RenderedGitLabWorkItem extends GitLabIssueDraft {
  readonly draftId: string;
}

export interface RenderedJiraWorkItem extends JiraIssueDraft {
  readonly draftId: string;
}

export interface RenderedMarkdownWorkItem extends MarkdownWorkItem {
  readonly draftId: string;
}

export interface WorkItemRenderResult {
  readonly provider: WorkItemRenderProvider;
  readonly drafts: readonly WorkItemDraft[];
  readonly queueOrder: QueueOrderValidation;
  readonly rendered: readonly (RenderedGitHubWorkItem | RenderedGitLabWorkItem | RenderedLinearWorkItem | RenderedJiraWorkItem | RenderedMarkdownWorkItem)[];
  readonly artifacts: readonly PlanningArtifact[];
}

export interface QueueOrderValidation {
  readonly ok: boolean;
  readonly conflicts: readonly string[];
}

export class WorkItemQueueOrderError extends Error {
  readonly conflicts: readonly string[];

  constructor(conflicts: readonly string[]) {
    super(`work item sequence conflicts: ${conflicts.join("; ")}`);
    this.name = "WorkItemQueueOrderError";
    this.conflicts = conflicts;
  }
}

export function createWorkItemDrafts(
  state: BootstrapState,
  milestoneSelector: string | undefined,
  baseDir = process.cwd()
): WorkItemDraftResult {
  const milestone = selectMilestone(state, milestoneSelector, baseDir);
  const issuesDir = `${dirname(state.artifacts.spec.path)}/issues`;
  const drafts = createDraftsForMilestone(state, milestone);
  const queueOrder = validateWorkItemDraftOrder(drafts);
  if (!queueOrder.ok) {
    throw new WorkItemQueueOrderError(queueOrder.conflicts);
  }
  const rendered = drafts.map((draft) => renderMarkdownWorkItemDraft(draft, issuesDir));
  return {
    milestone,
    drafts,
    queueOrder,
    rendered,
    artifacts: rendered.map((item) => ({
      path: item.path,
      status: "draft"
    }))
  };
}

export function writeWorkItemDrafts(
  state: BootstrapState,
  milestoneSelector: string | undefined,
  baseDir = process.cwd()
): WorkItemDraftResult {
  const result = createWorkItemDrafts(state, milestoneSelector, baseDir);
  for (const item of result.rendered) {
    const path = resolve(baseDir, item.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.content);
  }
  return result;
}

export function renderWorkItemDrafts(
  state: BootstrapState,
  provider: WorkItemRenderProvider,
  options: { readonly outputDir?: string } = {}
): WorkItemRenderResult {
  const drafts = state.planning.workItemDrafts;
  if (drafts.length === 0) {
    throw new TypeError("no work item drafts are recorded in bootstrap state");
  }
  const queueOrder = validateWorkItemDraftOrder(drafts);
  if (!queueOrder.ok) {
    throw new WorkItemQueueOrderError(queueOrder.conflicts);
  }

  if (provider === "github") {
    const rendered = drafts.map((draft) => ({
      draftId: draft.draftId,
      ...renderGitHubIssueDraft(draft)
    }));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  if (provider === "linear") {
    const rendered = drafts.map((draft) => ({
      draftId: draft.draftId,
      ...renderLinearIssueDraft(draft)
    }));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  if (provider === "gitlab") {
    const rendered = drafts.map((draft) => ({
      draftId: draft.draftId,
      ...renderGitLabIssueDraft(draft)
    }));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  if (provider === "jira") {
    const rendered = drafts.map((draft) => ({
      draftId: draft.draftId,
      ...renderJiraIssueDraft(draft)
    }));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  const outputDir = options.outputDir ?? `${dirname(state.artifacts.spec.path)}/issues`;
  const rendered = drafts.map((draft) => ({
    draftId: draft.draftId,
    ...renderMarkdownWorkItemDraft(draft, outputDir)
  }));
  return {
    provider,
    drafts,
    queueOrder,
    rendered,
    artifacts: rendered.map((item) => ({
      path: item.path,
      status: "ready"
    }))
  };
}

export function writeRenderedMarkdownWorkItems(
  state: BootstrapState,
  options: { readonly outputDir?: string; readonly baseDir?: string } = {}
): WorkItemRenderResult {
  const result = renderWorkItemDrafts(state, "markdown", options);
  const baseDir = resolve(options.baseDir ?? process.cwd());
  for (const item of result.rendered) {
    if (!("path" in item)) continue;
    const path = resolve(baseDir, item.path);
    const relativePath = relative(baseDir, path);
    if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new TypeError(`refusing to write work item outside project root: ${item.path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, item.content);
  }
  return result;
}

export function validateWorkItemDraftOrder(drafts: readonly WorkItemDraft[]): QueueOrderValidation {
  const conflicts: string[] = [];
  const sequenceById = new Map<string, number>();
  const seenSequences = new Map<number, string>();
  for (const draft of drafts) {
    if (draft.sequence === undefined || !Number.isSafeInteger(draft.sequence)) {
      conflicts.push(`${draft.draftId} is missing a stable sequence.`);
      continue;
    }
    const previous = seenSequences.get(draft.sequence);
    if (previous) {
      conflicts.push(`${draft.draftId} and ${previous} both use Sequence: ${draft.sequence}.`);
    }
    seenSequences.set(draft.sequence, draft.draftId);
    sequenceById.set(draft.draftId, draft.sequence);
  }

  for (const draft of drafts) {
    if (draft.sequence === undefined) continue;
    for (const blocker of draft.blockedBy ?? []) {
      const blockerSequence = sequenceById.get(blocker);
      if (blockerSequence !== undefined && blockerSequence >= draft.sequence) {
        conflicts.push(`${draft.draftId} has Sequence: ${draft.sequence} but is blocked by ${blocker} at Sequence: ${blockerSequence}.`);
      }
    }
  }
  return {
    ok: conflicts.length === 0,
    conflicts
  };
}

function createDraftsForMilestone(state: BootstrapState, milestone: MilestoneDraft): readonly WorkItemDraft[] {
  const component = componentForState(state);
  const baseSequence = sequenceFromMilestone(milestone);
  const workThemes = milestone.likelyWorkItemThemes.length > 0
    ? milestone.likelyWorkItemThemes.slice(0, 3)
    : ["scope", "validation", "handoff"];
  return workThemes.map((theme, index) => {
    const draftId = `${milestone.id}-work-${String(index + 1).padStart(2, "0")}-${slugify(theme)}`;
    const previousDraftId = index === 0 ? undefined : `${milestone.id}-work-${String(index).padStart(2, "0")}-${slugify(workThemes[index - 1] ?? "previous")}`;
    const blockedBy = [
      ...(index === 0 ? milestone.dependencies : []),
      ...(previousDraftId ? [previousDraftId] : [])
    ];
    return {
      draftId,
      title: `${milestone.title}: ${titleCase(theme)}`,
      priority: index === 0 ? "high" : "normal",
      status: blockedBy.length > 0 ? "blocked" : "ready",
      components: [component],
      ...(blockedBy.length > 0 ? { blockedBy } : {}),
      sequence: baseSequence + index + 1,
      sourceAnchors: [
        {
          artifact: milestone.id,
          section: "spec anchors"
        }
      ],
      bodySections: [
        section("Summary", `${theme} work for milestone ${milestone.id}.`),
        section("Scope", milestone.boundaries.map((item) => `- ${item}`).join("\n")),
        section("Blockers", blockedBy.length > 0 ? blockedBy.map((item) => `- ${item}`).join("\n") : "- None."),
        section("Stable selectors", [
          `- milestone:${milestone.id}`,
          `- draft:${draftId}`
        ].join("\n")),
        section("Named E2E tests", [
          `- e2e:${draftId}:happy-path`,
          `- e2e:${draftId}:blocked-path`
        ].join("\n")),
        section("Acceptance criteria", milestone.acceptanceCriteria.map((item) => `- ${item}`).join("\n")),
        section("Definition of done", [
          "- Draft output is reviewable without prior chat context.",
          "- Validation evidence is named and reproducible for this milestone.",
          "- No placeholder commands, fake tests, product-visible mock paths, or source-provenance leakage are introduced."
        ].join("\n")),
        section("Supply-chain and safety", [
          "- Prefer existing repository code and dependencies.",
          "- Do not add packages without explicit dependency intake.",
          "- Keep generated artifacts in product language."
        ].join("\n")),
        section("Spec anchors", milestone.specAnchors.map((anchor) => `- ${anchor}`).join("\n"))
      ],
      providerMetadata: {
        markdown: {
          sourceMilestone: milestone.id
        },
        executor: {
          sequence: baseSequence + index + 1,
          blockedBy
        }
      }
    };
  });
}

function selectMilestone(state: BootstrapState, selector: string | undefined, baseDir: string): MilestoneDraft {
  const candidates = state.planning.milestoneDrafts;
  const selected = selector
    ? candidates.find((milestone) => milestone.id === selector || milestone.path === selector)
    : candidates[0];
  if (!selected) {
    throw new TypeError(selector ? `milestone not found: ${selector}` : "no milestone drafts are recorded in bootstrap state");
  }
  readFileSync(resolve(baseDir, selected.path), "utf8");
  return selected;
}

function section(heading: string, body: string): WorkItemDraft["bodySections"][number] {
  return { heading, body };
}

function componentForState(state: BootstrapState): string {
  const shape = (state.project.shape ?? "planning").toLowerCase();
  if (/\b(cli|package|library|sdk)\b/u.test(shape)) return "aib";
  if (/\b(doc|research|process|design)\b/u.test(shape)) return "planning";
  return "product";
}

function sequenceFromMilestone(milestone: MilestoneDraft): number {
  const match = /^milestone-(\d+)/u.exec(milestone.id);
  return match ? Number.parseInt(match[1] ?? "1", 10) * 100 : 100;
}

function titleCase(value: string): string {
  return value.replace(/\w\S*/gu, (word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return slug.length > 0 ? slug : "work";
}
