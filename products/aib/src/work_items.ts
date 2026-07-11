import { selectRiskCards } from "@tjalve/aie";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  renderGitLabIssueDraft,
  renderJiraIssueDraft,
  renderLinearIssueDraft,
  type GitLabIssueDraft,
  type JiraIssueDraft,
  type LinearIssueDraft
} from "./adapter_exports.js";
import type { MilestoneDraft, PlanningArtifact, WorkItemDraft } from "./contracts.js";
import { renderGitHubIssueDraft, renderMarkdownWorkItemDraft, type GitHubIssueDraft, type MarkdownWorkItem } from "./renderers.js";
import type { BootstrapState } from "./state.js";
import { assertWorkItemDraftsLint } from "./work_item_lint.js";

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
  assertWorkItemDraftsLint(drafts);
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

export async function renderWorkItemDrafts(
  state: BootstrapState,
  provider: WorkItemRenderProvider,
  options: { readonly outputDir?: string } = {}
): Promise<WorkItemRenderResult> {
  const drafts = state.planning.workItemDrafts;
  if (drafts.length === 0) {
    throw new TypeError("no work item drafts are recorded in bootstrap state");
  }
  assertWorkItemDraftsLint(drafts);
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
    const rendered = await Promise.all(drafts.map(async (draft) => ({
      draftId: draft.draftId,
      ...(await renderLinearIssueDraft(draft))
    })));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  if (provider === "gitlab") {
    const rendered = await Promise.all(drafts.map(async (draft) => ({
      draftId: draft.draftId,
      ...(await renderGitLabIssueDraft(draft))
    })));
    return {
      provider,
      drafts,
      queueOrder,
      rendered,
      artifacts: []
    };
  }

  if (provider === "jira") {
    const rendered = await Promise.all(drafts.map(async (draft) => ({
      draftId: draft.draftId,
      ...(await renderJiraIssueDraft(draft))
    })));
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

export async function writeRenderedMarkdownWorkItems(
  state: BootstrapState,
  options: { readonly outputDir?: string; readonly baseDir?: string } = {}
): Promise<WorkItemRenderResult> {
  const result = await renderWorkItemDrafts(state, "markdown", options);
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

type CriterionVerificationKind = "unit" | "integration" | "manual observation" | "artifact review";

interface AllocatedCriterion {
  readonly text: string;
  readonly kind: CriterionVerificationKind;
  readonly sharedWith: readonly string[];
  readonly sharedReason: string | null;
  readonly defaulted: boolean;
}

function themeTokens(theme: string): readonly string[] {
  return theme.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 2);
}

function criterionThemeScore(criterion: string, theme: string): number {
  const haystack = criterion.toLowerCase();
  let score = 0;
  for (const token of themeTokens(theme)) {
    if (new RegExp(`(?:^|[^a-z0-9_])${token}(?:$|[^a-z0-9_])`, "u").test(haystack)) score += 1;
  }
  return score;
}

function verificationKindFor(criterion: string): CriterionVerificationKind {
  if (/\b(?:end-to-end|e2e|cli|command|workflow|round-?trip|integration)\b/iu.test(criterion)) return "integration";
  if (/\b(?:manual|manually|screenshot|browser|visual|visually|observe[ds]?|observation)\b/iu.test(criterion)) return "manual observation";
  if (/\b(?:docs?|documentation|readme|rendered\s+body|prose|wording|artifact)\b/iu.test(criterion)) return "artifact review";
  return "unit";
}

function allocateCriteria(criteria: readonly string[], themes: readonly string[]): ReadonlyMap<string, AllocatedCriterion[]> {
  const allocation = new Map<string, AllocatedCriterion[]>(themes.map((theme) => [theme, []]));
  for (const criterion of criteria) {
    const scores = themes.map((theme) => criterionThemeScore(criterion, theme));
    const top = Math.max(...scores);
    const defaulted = top === 0;
    const owners = defaulted ? [themes[0] ?? "scope"] : themes.filter((theme, index) => scores[index] === top);
    const shared = owners.length > 1;
    const entry = (owner: string): AllocatedCriterion => ({
      text: criterion,
      kind: verificationKindFor(criterion),
      sharedWith: shared ? owners.filter((theme) => theme !== owner) : [],
      sharedReason: shared ? `names behavior spanning the ${owners.join(" and ")} slices` : null,
      defaulted
    });
    for (const owner of owners) allocation.get(owner)?.push(entry(owner));
  }
  return allocation;
}

function renderCriterion(criterion: AllocatedCriterion): string {
  const sharedSuffix = criterion.sharedReason !== null && criterion.sharedWith.length > 0
    ? `; shared with ${criterion.sharedWith.join(" and ")}: ${criterion.sharedReason}`
    : "";
  // Defaulted ownership is rendered explicitly so linting can diagnose it on multi-slice milestones.
  const defaultedSuffix = criterion.defaulted ? "; allocation defaulted: no theme matched" : "";
  return `- [ ] ${criterion.text} (verify: ${criterion.kind}${sharedSuffix}${defaultedSuffix})`;
}

function sliceScope(milestone: MilestoneDraft, theme: string): readonly string[] {
  const matched = [...milestone.technicalDecisions, ...milestone.specAnchors]
    .filter((entry) => criterionThemeScore(entry, theme) > 0);
  if (matched.length > 0) return matched.map((entry) => `- ${entry}`);
  return [`- Surfaces introduced by the ${theme} slice of ${milestone.id}.`];
}

function sliceSummary(milestone: MilestoneDraft, theme: string, siblingThemes: readonly string[], ownedCount: number): string {
  const siblings = siblingThemes.length > 0
    ? `Sibling work items deliver ${siblingThemes.join(" and ")}; this slice is separate so ${theme} lands with its own reviewable proof.`
    : "This is the only work item for the milestone.";
  return `Deliver the ${theme} slice of ${milestone.title}, owning ${ownedCount} acceptance criteri${ownedCount === 1 ? "on" : "a"} listed below. ${siblings}`;
}

function guidanceSection(title: string, criteria: readonly AllocatedCriterion[], scope: readonly string[]): WorkItemDraft["bodySections"][number] | null {
  const issueText = [title, ...criteria.map((criterion) => criterion.text), ...scope].join("\n");
  const cards = selectRiskCards({ issueText });
  if (cards.length === 0) return null;
  const body = cards
    .map((card) => `- ${card.id}: ${card.title}\n  ${card.implementerFace.trim()}`)
    .join("\n");
  return section("Implementation guidance", body);
}

function createDraftsForMilestone(state: BootstrapState, milestone: MilestoneDraft): readonly WorkItemDraft[] {
  const component = componentForState(state);
  const baseSequence = sequenceFromMilestone(milestone);
  const candidateThemes = milestone.likelyWorkItemThemes.length > 0
    ? milestone.likelyWorkItemThemes.slice(0, 3)
    : ["scope", "validation", "handoff"];
  const allocation = allocateCriteria(milestone.acceptanceCriteria, candidateThemes);
  // A slice that owns no acceptance criteria is not an executable work item; drop it
  // instead of emitting an issue that fails the empty-criteria lint.
  const ownedThemes = candidateThemes.filter((theme) => (allocation.get(theme) ?? []).length > 0);
  const workThemes = ownedThemes.length > 0 ? ownedThemes : candidateThemes.slice(0, 1);
  return workThemes.map((theme, index) => {
    const draftId = `${milestone.id}-work-${String(index + 1).padStart(2, "0")}-${slugify(theme)}`;
    const previousDraftId = index === 0 ? undefined : `${milestone.id}-work-${String(index).padStart(2, "0")}-${slugify(workThemes[index - 1] ?? "previous")}`;
    const blockedBy = [
      ...(index === 0 ? milestone.dependencies : []),
      ...(previousDraftId ? [previousDraftId] : [])
    ];
    const ownedCriteria = allocation.get(theme) ?? [];
    const siblingThemes = workThemes.filter((candidate) => candidate !== theme);
    const scope = sliceScope(milestone, theme);
    const guidance = guidanceSection(`${milestone.title}: ${titleCase(theme)}`, ownedCriteria, scope);
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
        section("Summary", sliceSummary(milestone, theme, siblingThemes, ownedCriteria.length)),
        section("Scope", scope.join("\n")),
        section("Blockers", blockedBy.length > 0 ? blockedBy.map((item) => `- ${item}`).join("\n") : "- None."),
        section("Stable selectors", [
          `- milestone:${milestone.id}`,
          `- draft:${draftId}`
        ].join("\n")),
        section("Acceptance criteria", ownedCriteria.map((criterion) => renderCriterion(criterion)).join("\n")),
        ...(guidance ? [guidance] : []),
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
