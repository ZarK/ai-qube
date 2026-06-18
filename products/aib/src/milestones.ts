import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { MilestoneDraft, PlanningArtifact } from "./contracts.js";
import { selectProjectProfile } from "./project_profiles.js";
import { parseSpecMarkdownSections, resolveSpecPath } from "./spec.js";
import type { BootstrapState } from "./state.js";

export interface MilestoneDraftResult {
  readonly milestoneDir: string;
  readonly milestones: readonly MilestoneDraft[];
  readonly artifacts: readonly PlanningArtifact[];
  readonly recommendation: string;
}

export function createMilestoneDrafts(state: BootstrapState, baseDir = process.cwd()): MilestoneDraftResult {
  const milestoneDir = resolveMilestoneDir(state, baseDir);
  const milestonePathPrefix = `${dirname(state.artifacts.spec.path)}/milestones`;
  const sections = parseSpecMarkdownSections(readFileSync(resolveSpecPath(state, baseDir), "utf8"));
  const featureSection = sections.find((section) => section.id === "feature_capability_map");
  const features = extractFeatureLines(featureSection?.body);
  const milestones = features.length >= 2
    ? createFeatureMilestones(features, milestonePathPrefix)
    : createSequentialMilestones(state, milestonePathPrefix);
  return {
    milestoneDir,
    milestones,
    artifacts: milestones.map((milestone) => ({
      path: milestone.path,
      status: "draft"
    })),
    recommendation: "Plan at least the first three milestones before generating work items unless the human explicitly overrides."
  };
}

export function writeMilestoneDrafts(state: BootstrapState, baseDir = process.cwd()): MilestoneDraftResult {
  const result = createMilestoneDrafts(state, baseDir);
  mkdirSync(result.milestoneDir, { recursive: true });
  for (const milestone of result.milestones) {
    writeFileSync(resolve(baseDir, milestone.path), renderMilestoneMarkdown(milestone));
  }
  return result;
}

export function milestoneDocsExist(state: BootstrapState, baseDir = process.cwd()): boolean {
  if (state.artifacts.milestones.length === 0) return false;
  return state.artifacts.milestones.every((artifact) => {
    try {
      readFileSync(resolve(baseDir, artifact.path), "utf8");
      return true;
    } catch {
      return false;
    }
  });
}

function createSequentialMilestones(state: BootstrapState, milestonePathPrefix: string): readonly MilestoneDraft[] {
  const profile = selectProjectProfile(state.project.shape);
  const deliverable = profile.milestoneDeliverables[0] ?? "accepted deliverable";
  const validation = profile.workItemValidation.join(", ");
  return [
    milestone({
      index: 1,
      milestonePathPrefix,
      title: "Planning foundation",
      summary: `Confirm the accepted spec can guide ${state.project.coreJob ?? "the first project outcome"} without relying on transcript memory.`,
      boundaries: [
        "Use the accepted spec as the source of truth.",
        "Resolve milestone boundaries and sequencing assumptions.",
        "Avoid production implementation and detailed schemas."
      ],
      dependencies: [],
      proofOfCompletion: [`The milestone plan identifies the first ${deliverable} and its acceptance evidence.`],
      acceptanceCriteria: [
        "The first three milestone candidates are reviewable together.",
        "Cross-cutting decisions are called out before work items are generated."
      ],
      likelyWorkItemThemes: ["planning state", "artifact structure", "review evidence"],
      technicalDecisions: ["Decide which milestone boundaries are sequential and which can run independently."],
      specAnchors: ["feature_capability_map", "constraints_assumptions", "risks_unknowns"]
    }),
    milestone({
      index: 2,
      milestonePathPrefix,
      title: "First useful capability",
      summary: state.project.successNarrative ?? "Deliver the first reviewable outcome from the accepted spec.",
      boundaries: [
        "Focus on one coherent user-visible or reviewer-visible capability.",
        "Include the acceptance evidence needed for handoff.",
        "Defer adjacent capabilities until their own milestone."
      ],
      dependencies: ["milestone-01-planning-foundation"],
      proofOfCompletion: [`A reviewer can validate the first ${deliverable} using ${validation || "acceptance evidence"}.`],
      acceptanceCriteria: [
        "The milestone outcome is visible or reviewable without reading implementation notes.",
        "Known edge cases are named at milestone depth."
      ],
      likelyWorkItemThemes: ["core behavior", "review path", "acceptance evidence"],
      technicalDecisions: ["Choose the minimum viable outcome that proves the core job."],
      specAnchors: ["functional_requirements", "success_narrative", "scope"]
    }),
    milestone({
      index: 3,
      milestonePathPrefix,
      title: "Validation and handoff",
      summary: "Make the planned outcome reproducible, reviewable, and safe to turn into work items.",
      boundaries: [
        "Capture validation and handoff evidence.",
        "Document unresolved risks that should become work item blockers.",
        "Avoid provider-specific issue details until work-item rendering."
      ],
      dependencies: ["milestone-02-first-useful-capability"],
      proofOfCompletion: ["The milestone docs are sufficient to generate executable work item drafts."],
      acceptanceCriteria: [
        "Dependencies and proof of completion are explicit.",
        "Work item themes are concrete without becoming production code."
      ],
      likelyWorkItemThemes: ["validation", "documentation", "handoff"],
      technicalDecisions: ["Decide whether work items should be generated incrementally or for all ready milestones."],
      specAnchors: ["non_functional_requirements", "risks_unknowns", "spec_acceptance_checklist"]
    })
  ];
}

function createFeatureMilestones(features: readonly string[], milestonePathPrefix: string): readonly MilestoneDraft[] {
  const foundation = milestone({
    index: 1,
    milestonePathPrefix,
    title: "Milestone foundation",
    summary: "Establish shared planning boundaries before independent feature milestones are drafted.",
    boundaries: [
      "Confirm common constraints and acceptance evidence.",
      "Identify feature dependencies before work items are generated.",
      "Avoid production implementation and detailed schemas."
    ],
    dependencies: [],
    proofOfCompletion: ["Feature milestone boundaries are explicit and dependency-safe."],
    acceptanceCriteria: [
      "At least two feature milestones can be reviewed independently.",
      "Shared risks and unknowns are captured before issue breakdown."
    ],
    likelyWorkItemThemes: ["shared planning", "dependency map", "acceptance evidence"],
    technicalDecisions: ["Decide which feature milestones depend only on the foundation."],
    specAnchors: ["feature_capability_map", "constraints_assumptions"]
  });

  const featureMilestones = features.slice(0, 4).map((feature, featureIndex) => milestone({
    index: featureIndex + 2,
    milestonePathPrefix,
    title: featureTitle(feature),
    summary: feature,
    boundaries: [
      "Deliver this feature or capability as its own reviewable slice.",
      "Use shared foundation decisions without coupling to sibling feature delivery.",
      "Keep detailed work item splitting for the next phase."
    ],
    dependencies: [foundation.id],
    proofOfCompletion: [`The ${featureTitle(feature).toLowerCase()} capability is described well enough to split into work items.`],
    acceptanceCriteria: [
      "The visible outcome and acceptance evidence are clear.",
      "Sibling feature milestones are not required unless named as dependencies."
    ],
    likelyWorkItemThemes: ["capability behavior", "edge cases", "acceptance evidence"],
    technicalDecisions: ["Confirm any integration or state boundary that affects this feature's work items."],
    specAnchors: ["feature_capability_map", "functional_requirements"]
  }));

  return [foundation, ...featureMilestones].slice(0, Math.max(3, Math.min(5, features.length + 1)));
}

function milestone(input: {
  readonly index: number;
  readonly milestonePathPrefix: string;
  readonly title: string;
  readonly summary: string;
  readonly boundaries: readonly string[];
  readonly dependencies: readonly string[];
  readonly proofOfCompletion: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly likelyWorkItemThemes: readonly string[];
  readonly technicalDecisions: readonly string[];
  readonly specAnchors: readonly string[];
}): MilestoneDraft {
  const slug = slugify(input.title);
  const id = `milestone-${String(input.index).padStart(2, "0")}-${slug}`;
  return {
    id,
    title: input.title,
    path: `${input.milestonePathPrefix}/${String(input.index).padStart(3, "0")}-${slug}.md`,
    summary: input.summary,
    boundaries: input.boundaries,
    dependencies: input.dependencies,
    proofOfCompletion: input.proofOfCompletion,
    acceptanceCriteria: input.acceptanceCriteria,
    likelyWorkItemThemes: input.likelyWorkItemThemes,
    technicalDecisions: input.technicalDecisions,
    specAnchors: input.specAnchors
  };
}

function renderMilestoneMarkdown(milestone: MilestoneDraft): string {
  const lines = [
    `# ${milestone.title}`,
    "",
    `Milestone ID: ${milestone.id}`,
    "",
    "## Delivery goal",
    "",
    milestone.summary,
    "",
    "## Boundaries",
    "",
    ...milestone.boundaries.map((item) => `- ${item}`),
    "",
    "## Dependencies",
    "",
    ...(milestone.dependencies.length > 0 ? milestone.dependencies.map((item) => `- ${item}`) : ["- None."]),
    "",
    "## Proof of completion",
    "",
    ...milestone.proofOfCompletion.map((item) => `- ${item}`),
    "",
    "## Acceptance criteria",
    "",
    ...milestone.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Likely work item themes",
    "",
    ...milestone.likelyWorkItemThemes.map((item) => `- ${item}`),
    "",
    "## Technical decisions before issue breakdown",
    "",
    ...milestone.technicalDecisions.map((item) => `- ${item}`),
    "",
    "## Spec anchors",
    "",
    ...milestone.specAnchors.map((item) => `- ${item}`),
    "",
    "## Planning-depth guardrails",
    "",
    "- This milestone may include pseudo-algorithm notes, flow diagrams, state diagrams, or model descriptions when they clarify scope.",
    "- Do not include production code, detailed API models, or full implementation schemas in this milestone doc.",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function resolveMilestoneDir(state: BootstrapState, baseDir: string): string {
  return resolve(baseDir, dirname(state.artifacts.spec.path), "milestones");
}

function extractFeatureLines(body: string | undefined): readonly string[] {
  if (!body) return [];
  return body
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*[-*]\s+/u, "").replace(/^\s*\d+[.)]\s+/u, "").trim())
    .filter((line) => line.length > 0 && !/^(map each|tbd|todo|placeholder)/iu.test(line))
    .slice(0, 6);
}

function featureTitle(feature: string): string {
  return feature
    .replace(/^(the project must|must|should|can|allow users to|provide)\s+/iu, "")
    .replace(/[.:;]+$/u, "")
    .split(/\s+/u)
    .slice(0, 6)
    .join(" ")
    || "Feature capability";
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return slug.length > 0 ? slug : "milestone";
}
