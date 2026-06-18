import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { BootstrapState } from "./state.js";
import {
  DYNAMIC_SPEC_CHAPTERS,
  REQUIRED_SPEC_CHAPTERS,
  selectSpecChapters,
  validateSpecSections,
  type SelectedSpecChapter,
  type SpecChapterId,
  type SpecSectionDraft,
  type SpecValidationResult
} from "./spec_chapters.js";

export interface SpecDraftResult {
  readonly specPath: string;
  readonly content: string;
  readonly chapters: readonly SelectedSpecChapter[];
  readonly unresolvedGaps: readonly string[];
}

export interface SpecValidationReport extends SpecValidationResult {
  readonly specPath: string;
  readonly sections: readonly SpecSectionDraft[];
}

export function createSpecDraft(state: BootstrapState, baseDir = process.cwd()): SpecDraftResult {
  const chapters = selectSpecChapters({
    shape: state.project.shape,
    constraints: state.project.constraints,
    coreJob: state.project.coreJob,
    reuseBoundary: state.project.reuseBoundary,
    planningSurface: state.project.planningSurface
  });
  const unresolvedGaps = [
    ...state.discovery.unresolvedQuestions,
    ...missingProjectGaps(state)
  ];
  return {
    specPath: resolveSpecPath(state, baseDir),
    content: renderSpecDraft(state, chapters, unresolvedGaps),
    chapters,
    unresolvedGaps
  };
}

export function writeSpecDraft(state: BootstrapState, baseDir = process.cwd()): SpecDraftResult {
  const draft = createSpecDraft(state, baseDir);
  const resolvedPath = draft.specPath;
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, draft.content);
  return {
    ...draft,
    specPath: resolvedPath
  };
}

export function validateSpecFile(state: BootstrapState, baseDir = process.cwd()): SpecValidationReport {
  const specPath = resolveSpecPath(state, baseDir);
  const content = readFileSync(specPath, "utf8");
  const sections = parseSpecMarkdownSections(content);
  const chapters = selectSpecChapters({
    shape: state.project.shape,
    constraints: state.project.constraints,
    coreJob: state.project.coreJob,
    reuseBoundary: state.project.reuseBoundary,
    planningSurface: state.project.planningSurface
  });
  const validation = validateSpecSections(chapters, sections);
  return {
    ...validation,
    specPath,
    sections
  };
}

export function specFileExists(state: BootstrapState, baseDir = process.cwd()): boolean {
  return existsSync(resolveSpecPath(state, baseDir));
}

export function resolveSpecPath(state: BootstrapState, baseDir = process.cwd()): string {
  return resolve(baseDir, state.artifacts.spec.path);
}

export function requiredSpecSectionIds(state: BootstrapState): readonly SpecChapterId[] {
  return selectSpecChapters({
    shape: state.project.shape,
    constraints: state.project.constraints,
    coreJob: state.project.coreJob,
    reuseBoundary: state.project.reuseBoundary,
    planningSurface: state.project.planningSurface
  })
    .filter((chapter) => chapter.required)
    .map((chapter) => chapter.id);
}

export function parseSpecMarkdownSections(content: string): readonly SpecSectionDraft[] {
  const sections: SpecSectionDraft[] = [];
  const lines = content.split(/\r?\n/u);
  let current: { id?: SpecChapterId; title: string; body: string[] } | undefined;

  for (const line of lines) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading) {
      if (current) {
        sections.push({
          ...(current.id ? { id: current.id } : {}),
          title: current.title,
          body: current.body.join("\n").trim()
        });
      }
      current = { title: heading[1]?.trim() ?? "", body: [] };
      continue;
    }

    if (!current) continue;
    const marker = /<!--\s*aib:spec-section\s+([a-z0-9_]+)\s*-->/u.exec(line);
    const markerId = marker?.[1] ?? "";
    if (isSpecChapterId(markerId)) {
      current.id = markerId;
      continue;
    }
    current.body.push(line);
  }

  if (current) {
    sections.push({
      ...(current.id ? { id: current.id } : {}),
      title: current.title,
      body: current.body.join("\n").trim()
    });
  }

  return sections;
}

function renderSpecDraft(
  state: BootstrapState,
  chapters: readonly SelectedSpecChapter[],
  unresolvedGaps: readonly string[]
): string {
  const lines = [
    "# Project spec",
    "",
    "This spec is the durable planning contract for milestones and work items.",
    "",
    ...chapters.flatMap((chapter) => renderChapter(state, chapter, unresolvedGaps)),
    "## Revision log",
    "<!-- aib:spec-section revision_log -->",
    "",
    `- Revision ${state.spec.revision + 1}: Drafted from current discovery state.`,
    "",
    "## Private-source handling",
    "<!-- aib:spec-section private_source_handling -->",
    "",
    "- Generated planning artifacts should preserve product conclusions without copying private reference paths, repo names, or chat-only context.",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function renderChapter(
  state: BootstrapState,
  chapter: SelectedSpecChapter,
  unresolvedGaps: readonly string[]
): readonly string[] {
  return [
    `## ${chapter.title}`,
    `<!-- aib:spec-section ${chapter.id} -->`,
    "",
    renderChapterBody(state, chapter.id, unresolvedGaps),
    ""
  ];
}

function renderChapterBody(
  state: BootstrapState,
  id: SpecChapterId,
  unresolvedGaps: readonly string[]
): string {
  const project = state.project;
  if (id === "purpose") return project.intent ?? "Assume a focused product intent from discovery.";
  if (id === "audience_stakeholders") return project.audience ?? "Assume the primary stakeholders named during discovery.";
  if (id === "success_narrative") return project.successNarrative ?? "A successful first version delivers the core job clearly enough for review.";
  if (id === "scope") return project.scope ?? "First useful version only; defer expansion until the spec is accepted.";
  if (id === "non_goals") return project.nonGoals ?? "Avoid implementation depth, provider coupling, and speculative future work until milestones are generated.";
  if (id === "project_shape") return project.shape ?? "Project shape is inferred from discovery and should be confirmed during review.";
  if (id === "functional_requirements") return project.coreJob ?? "The project must perform the first core job described during discovery.";
  if (id === "non_functional_requirements") return "Outputs must be resumable, reviewable, deterministic enough for agents, and safe to hand off without prior chat context.";
  if (id === "constraints_assumptions") {
    const assumptions = state.assumptions.length > 0 ? state.assumptions.map((item) => `- ${item}`).join("\n") : "- No explicit assumptions recorded yet.";
    return `${project.constraints ?? "No hard constraints have been confirmed yet."}\n\n${assumptions}`;
  }
  if (id === "feature_capability_map") return "Map each accepted requirement to a planned capability before work items are generated.";
  if (id === "risks_unknowns") {
    return unresolvedGaps.length > 0 ? unresolvedGaps.map((gap) => `- ${gap}`).join("\n") : "- No unresolved gaps recorded.";
  }
  if (id === "spec_acceptance_checklist") {
    return REQUIRED_SPEC_CHAPTERS.map((chapter) => `- [ ] ${chapter.title}`).join("\n");
  }
  if (id === "package_reuse_boundaries") return project.reuseBoundary ?? "Separate reusable package behavior from reference-project evidence.";
  if (id === "user_experience_workflows") return "Describe the primary command, screen, document, or workflow path the target user will follow.";
  if (id === "data_content_model") return "Describe the durable domain objects, content, or lifecycle states owned by the project.";
  if (id === "ai_model_behavior") return "Describe intended AI/model behavior, evaluation expectations, and local/privacy constraints.";
  if (id === "integrations") return "Describe provider boundaries, inputs, outputs, and failure behavior for integrations.";
  if (id === "privacy_safety_legal") return "Describe sensitive data handling, local-first constraints, safety limits, and legal/compliance assumptions.";
  if (id === "operations_support") return "Describe support, release, maintenance, and operating expectations.";
  if (id === "migration") return "Describe what existing material moves, what remains authoritative, and how reconciliation is verified.";
  if (id === "research_evidence_plan") return "Describe the evidence needed to make decisions and how sources will be validated.";
  if (id === "hardware_local_runtime") return "Describe local runtime, hardware, offline, and deployment constraints.";
  if (id === "documentation_content_structure") return "Describe document structure, audience flow, review path, and handoff format.";
  throw new TypeError(`Unsupported spec chapter id: ${id}`);
}

function missingProjectGaps(state: BootstrapState): readonly string[] {
  const gaps: string[] = [];
  const required: Array<[keyof BootstrapState["project"], string]> = [
    ["intent", "Confirm project intent."],
    ["audience", "Confirm audience and stakeholders."],
    ["coreJob", "Confirm the first core job."],
    ["shape", "Confirm project shape."],
    ["successNarrative", "Confirm success narrative."],
    ["scope", "Confirm first-version scope."],
    ["nonGoals", "Confirm non-goals."],
    ["constraints", "Confirm constraints and assumptions."]
  ];
  for (const [field, message] of required) {
    const value = state.project[field];
    if (typeof value !== "string" || value.trim().length === 0) gaps.push(message);
  }
  return gaps;
}

function isSpecChapterId(value: string): value is SpecChapterId {
  return [...REQUIRED_SPEC_CHAPTERS, ...DYNAMIC_SPEC_CHAPTERS].some((chapter) => chapter.id === value);
}
