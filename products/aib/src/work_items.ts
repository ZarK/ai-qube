import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { MilestoneDraft, PlanningArtifact, WorkItemDraft } from "./contracts.js";
import { renderMarkdownWorkItemDraft, type MarkdownWorkItem } from "./renderers.js";
import type { BootstrapState } from "./state.js";

export interface WorkItemDraftResult {
  readonly milestone: MilestoneDraft;
  readonly drafts: readonly WorkItemDraft[];
  readonly rendered: readonly MarkdownWorkItem[];
  readonly artifacts: readonly PlanningArtifact[];
}

export function createWorkItemDrafts(
  state: BootstrapState,
  milestoneSelector: string | undefined,
  baseDir = process.cwd()
): WorkItemDraftResult {
  const milestone = selectMilestone(state, milestoneSelector, baseDir);
  const issuesDir = `${dirname(state.artifacts.spec.path)}/issues`;
  const drafts = createDraftsForMilestone(state, milestone);
  const rendered = drafts.map((draft) => renderMarkdownWorkItemDraft(draft, issuesDir));
  return {
    milestone,
    drafts,
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
          artifact: milestone.path,
          section: milestone.id
        }
      ],
      bodySections: [
        section("Summary", `${theme} work for milestone ${milestone.id}.`),
        section("Scope", milestone.boundaries.map((item) => `- ${item}`).join("\n")),
        section("Blockers", blockedBy.length > 0 ? blockedBy.map((item) => `- ${item}`).join("\n") : "- None."),
        section("Stable selectors", [
          `- milestone:${milestone.id}`,
          `- artifact:${milestone.path}`,
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
        section("Source anchors", milestone.specAnchors.map((anchor) => `- ${anchor}`).join("\n"))
      ],
      providerMetadata: {
        markdown: {
          sourceMilestone: milestone.id
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
