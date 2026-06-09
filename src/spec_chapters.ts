export type SpecChapterId =
  | "purpose"
  | "audience_stakeholders"
  | "success_narrative"
  | "scope"
  | "non_goals"
  | "project_shape"
  | "functional_requirements"
  | "non_functional_requirements"
  | "constraints_assumptions"
  | "feature_capability_map"
  | "risks_unknowns"
  | "spec_acceptance_checklist"
  | "user_experience_workflows"
  | "data_content_model"
  | "ai_model_behavior"
  | "integrations"
  | "privacy_safety_legal"
  | "operations_support"
  | "migration"
  | "research_evidence_plan"
  | "hardware_local_runtime"
  | "documentation_content_structure"
  | "package_reuse_boundaries";

export interface SpecChapter {
  readonly id: SpecChapterId;
  readonly title: string;
  readonly required: boolean;
  readonly reason: string;
}

export interface SelectedSpecChapter extends SpecChapter {
  readonly selectedReason: string;
}

export interface SpecSectionDraft {
  readonly id?: SpecChapterId;
  readonly title: string;
  readonly body: string;
}

export interface SpecValidationResult {
  readonly ok: boolean;
  readonly missingRequiredSections: readonly SpecChapterId[];
  readonly placeholderSections: readonly string[];
}

export interface SpecAcceptanceStatus {
  readonly acceptedSectionIds: readonly SpecChapterId[];
  readonly acceptedDynamicSectionIds: readonly SpecChapterId[];
  readonly missingRequiredAcceptance: readonly SpecChapterId[];
  readonly canGenerateMilestones: boolean;
}

export const REQUIRED_SPEC_CHAPTERS: readonly SpecChapter[] = Object.freeze([
  chapter("purpose", "Purpose", true, "Defines why the project exists."),
  chapter("audience_stakeholders", "Audience and stakeholders", true, "Identifies who the project is for and who must accept it."),
  chapter("success_narrative", "Success narrative", true, "States what a successful first useful version feels like."),
  chapter("scope", "Scope", true, "Defines the first useful boundary."),
  chapter("non_goals", "Non-goals", true, "Prevents premature expansion."),
  chapter("project_shape", "Project shape", true, "Classifies the project before applying templates."),
  chapter("functional_requirements", "Functional requirements", true, "Captures what the project must do."),
  chapter("non_functional_requirements", "Non-functional requirements", true, "Captures quality, trust, and operating expectations."),
  chapter("constraints_assumptions", "Constraints and assumptions", true, "Records known limits and explicit assumptions."),
  chapter("feature_capability_map", "Feature or capability map", true, "Connects requirements to planned capabilities."),
  chapter("risks_unknowns", "Risks and unknowns", true, "Surfaces blockers and deferred questions."),
  chapter("spec_acceptance_checklist", "Spec acceptance checklist", true, "Makes spec acceptance section-aware.")
]);

export const DYNAMIC_SPEC_CHAPTERS: readonly SpecChapter[] = Object.freeze([
  chapter("user_experience_workflows", "User experience and workflows", false, "Needed for screens, navigation, interaction flows, commands, or user journeys."),
  chapter("data_content_model", "Data or content model", false, "Needed when the project owns structured data, content, or lifecycle states."),
  chapter("ai_model_behavior", "AI/model behavior", false, "Needed for local AI, LLM, embedding, retrieval, or model-behavior work."),
  chapter("integrations", "Integrations", false, "Needed when external systems, providers, imports, exports, or handoffs matter."),
  chapter("privacy_safety_legal", "Privacy, safety, compliance, or legal constraints", false, "Needed when trust, offline behavior, secrets, sensitive data, or policy constraints matter."),
  chapter("operations_support", "Operations and support", false, "Needed for maintenance, support, release, observability, or operating workflows."),
  chapter("migration", "Migration", false, "Needed when existing data, users, docs, or systems must move safely."),
  chapter("research_evidence_plan", "Research or evidence plan", false, "Needed for research, evaluation, evidence gathering, or recommendation work."),
  chapter("hardware_local_runtime", "Hardware, local runtime, or deployment constraints", false, "Needed for local runtimes, desktop constraints, hardware, deployment, or offline work."),
  chapter("documentation_content_structure", "Documentation/content structure", false, "Needed for document sets, guides, courses, content projects, or markdown exports."),
  chapter("package_reuse_boundaries", "Package/reuse boundaries", false, "Needed when reusable package behavior must be separated from reference-project details.")
]);

const DYNAMIC_BY_ID = new Map(DYNAMIC_SPEC_CHAPTERS.map((item) => [item.id, item]));

export function selectSpecChapters(input: {
  readonly shape?: string;
  readonly constraints?: string;
  readonly coreJob?: string;
  readonly reuseBoundary?: string;
  readonly planningSurface?: string;
} = {}): readonly SelectedSpecChapter[] {
  const haystack = `${input.shape ?? ""} ${input.constraints ?? ""} ${input.coreJob ?? ""} ${input.reuseBoundary ?? ""} ${input.planningSurface ?? ""}`.toLowerCase();
  const selected = new Map<SpecChapterId, string>();

  if (/\b(app|web|desktop|ui|ux|screen|workflow|cli|command)\b/.test(haystack)) select(selected, "user_experience_workflows", "Project shape implies user-facing workflows or command surfaces.");
  if (/\b(data|content|document|photo|media|catalog|state|model)\b/.test(haystack)) select(selected, "data_content_model", "Project owns data, content, or lifecycle concepts.");
  if (/\b(ai|llm|model|embedding|rag|retrieval|local[- ]?ai)\b/.test(haystack)) select(selected, "ai_model_behavior", "Project includes AI or model behavior.");
  if (/\b(integration|provider|import|export|handoff|api|webhook|sync)\b/.test(haystack)) select(selected, "integrations", "Project crosses system or provider boundaries.");
  if (/\b(privacy|safe|safety|legal|compliance|secret|offline|local-first|restricted|sensitive)\b/.test(haystack)) select(selected, "privacy_safety_legal", "Project has trust, privacy, safety, or policy constraints.");
  if (/\b(operations|support|maintenance|release|monitor|observability|process|playbook)\b/.test(haystack)) select(selected, "operations_support", "Project has operating or support concerns.");
  if (/\b(migration|migrate|legacy|existing|backfill|import existing)\b/.test(haystack)) select(selected, "migration", "Project changes or moves existing material.");
  if (/\b(research|evidence|study|evaluation|recommendation)\b/.test(haystack)) select(selected, "research_evidence_plan", "Project depends on evidence or research method.");
  if (/\b(hardware|runtime|deploy|deployment|desktop|offline|local)\b/.test(haystack)) select(selected, "hardware_local_runtime", "Project has local runtime, hardware, or deployment constraints.");
  if (/\b(doc|documentation|content|guide|manual|course|markdown|export)\b/.test(haystack)) select(selected, "documentation_content_structure", "Project is documentation, content, or export oriented.");
  if (/\b(reusable|package|library|sdk|cli|tooling)\b/.test(haystack)) select(selected, "package_reuse_boundaries", "Reusable behavior must be separated from project-specific references.");

  return Object.freeze([
    ...REQUIRED_SPEC_CHAPTERS.map((item) => ({ ...item, selectedReason: "Required for every dry spec." })),
    ...[...selected.entries()].map(([id, selectedReason]) => {
      const chapter = DYNAMIC_BY_ID.get(id);
      if (!chapter) throw new Error(`unknown dynamic spec chapter: ${id}`);
      return { ...chapter, selectedReason };
    })
  ]);
}

export function validateSpecSections(chapters: readonly SpecChapter[], sections: readonly SpecSectionDraft[]): SpecValidationResult {
  const byIdOrTitle = new Map<string, SpecSectionDraft>();
  for (const section of sections) {
    if (section.id) byIdOrTitle.set(section.id, section);
    byIdOrTitle.set(normalizeTitle(section.title), section);
  }
  const missingRequiredSections: SpecChapterId[] = [];
  const placeholderSections: string[] = [];
  for (const chapter of chapters) {
    if (!chapter.required) continue;
    const section = byIdOrTitle.get(chapter.id) ?? byIdOrTitle.get(normalizeTitle(chapter.title));
    if (!section) {
      missingRequiredSections.push(chapter.id);
      continue;
    }
    if (isPlaceholderBody(section.body)) placeholderSections.push(chapter.title);
  }
  return {
    ok: missingRequiredSections.length === 0 && placeholderSections.length === 0,
    missingRequiredSections,
    placeholderSections
  };
}

export function specAcceptanceStatus(chapters: readonly SpecChapter[], acceptedSectionIds: readonly string[]): SpecAcceptanceStatus {
  const accepted = new Set(acceptedSectionIds);
  const requiredIds = chapters.filter((chapter) => chapter.required).map((chapter) => chapter.id);
  const dynamicIds = chapters.filter((chapter) => !chapter.required).map((chapter) => chapter.id);
  const missingRequiredAcceptance = requiredIds.filter((id) => !accepted.has(id));
  return {
    acceptedSectionIds: requiredIds.filter((id) => accepted.has(id)),
    acceptedDynamicSectionIds: dynamicIds.filter((id) => accepted.has(id)),
    missingRequiredAcceptance,
    canGenerateMilestones: missingRequiredAcceptance.length === 0
  };
}

function chapter(id: SpecChapterId, title: string, required: boolean, reason: string): SpecChapter {
  return Object.freeze({ id, title, required, reason });
}

function select(selected: Map<SpecChapterId, string>, id: SpecChapterId, reason: string): void {
  if (!selected.has(id)) selected.set(id, reason);
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function isPlaceholderBody(body: string): boolean {
  const normalized = body.trim().toLowerCase();
  return normalized.length < 4
    || normalized === "tbd"
    || normalized === "todo"
    || normalized === "n/a"
    || normalized.includes("lorem ipsum")
    || normalized.includes("placeholder")
    || normalized.includes("to be written");
}
