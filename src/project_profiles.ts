export type ProjectProfileKind =
  | "coding"
  | "cli_package"
  | "local_ai"
  | "documentation"
  | "research"
  | "design"
  | "process"
  | "export_only"
  | "unknown";

export interface ProjectProfile {
  readonly kind: ProjectProfileKind;
  readonly label: string;
  readonly codingProject: boolean;
  readonly specChapters: readonly string[];
  readonly milestoneDeliverables: readonly string[];
  readonly workItemValidation: readonly string[];
  readonly allowsRepositoryMutation: boolean;
}

const GENERAL_SPEC_CHAPTERS = [
  "Purpose",
  "Audience and stakeholders",
  "Success narrative",
  "Scope",
  "Non-goals",
  "Project shape",
  "Functional requirements",
  "Non-functional requirements",
  "Constraints and assumptions",
  "Feature or capability map",
  "Risks and unknowns",
  "Spec acceptance checklist"
] as const;

const CODING_VALIDATION = ["tests", "build", "review", "acceptance"] as const;
const NON_CODE_VALIDATION = ["review", "evidence", "acceptance", "stakeholder signoff"] as const;

function immutableProfile(profile: ProjectProfile): ProjectProfile {
  return Object.freeze({
    ...profile,
    specChapters: Object.freeze([...profile.specChapters]),
    milestoneDeliverables: Object.freeze([...profile.milestoneDeliverables]),
    workItemValidation: Object.freeze([...profile.workItemValidation])
  });
}

const PROFILES: Readonly<Record<ProjectProfileKind, ProjectProfile>> = {
  coding: immutableProfile({
    kind: "coding",
    label: "Coding project",
    codingProject: true,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "User experience and workflows", "Data or content model", "Operations and support"],
    milestoneDeliverables: ["working capability", "test evidence", "documentation update"],
    workItemValidation: CODING_VALIDATION,
    allowsRepositoryMutation: true
  }),
  cli_package: immutableProfile({
    kind: "cli_package",
    label: "CLI or package project",
    codingProject: true,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "Command surface", "Configuration", "Package and release constraints"],
    milestoneDeliverables: ["CLI behavior", "package contract", "test evidence"],
    workItemValidation: CODING_VALIDATION,
    allowsRepositoryMutation: true
  }),
  local_ai: immutableProfile({
    kind: "local_ai",
    label: "Local AI project",
    codingProject: true,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "AI/model behavior", "Privacy, safety, compliance, or legal constraints", "Hardware, local runtime, or deployment constraints"],
    milestoneDeliverables: ["local model behavior", "privacy evidence", "test evidence"],
    workItemValidation: CODING_VALIDATION,
    allowsRepositoryMutation: true
  }),
  documentation: immutableProfile({
    kind: "documentation",
    label: "Documentation or content project",
    codingProject: false,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "Documentation/content structure", "Review and publication plan"],
    milestoneDeliverables: ["reviewable document set", "publication-ready draft", "acceptance evidence"],
    workItemValidation: ["review", "acceptance", "publication checklist"],
    allowsRepositoryMutation: false
  }),
  research: immutableProfile({
    kind: "research",
    label: "Research project",
    codingProject: false,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "Research or evidence plan", "Method and source constraints"],
    milestoneDeliverables: ["research brief", "evidence table", "reviewed recommendation"],
    workItemValidation: ["evidence", "review", "acceptance"],
    allowsRepositoryMutation: false
  }),
  design: immutableProfile({
    kind: "design",
    label: "Design project",
    codingProject: false,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "User experience and workflows", "Design review plan"],
    milestoneDeliverables: ["concept direction", "reviewable design artifact", "acceptance evidence"],
    workItemValidation: NON_CODE_VALIDATION,
    allowsRepositoryMutation: false
  }),
  process: immutableProfile({
    kind: "process",
    label: "Operations or process project",
    codingProject: false,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "Operations and support", "Process roles and handoffs"],
    milestoneDeliverables: ["process map", "operating checklist", "stakeholder signoff"],
    workItemValidation: NON_CODE_VALIDATION,
    allowsRepositoryMutation: false
  }),
  export_only: immutableProfile({
    kind: "export_only",
    label: "Export-only planning project",
    codingProject: false,
    specChapters: [...GENERAL_SPEC_CHAPTERS, "Documentation/content structure", "Export and handoff constraints"],
    milestoneDeliverables: ["markdown export", "review bundle", "handoff checklist"],
    workItemValidation: ["review", "acceptance"],
    allowsRepositoryMutation: false
  }),
  unknown: immutableProfile({
    kind: "unknown",
    label: "Unknown project shape",
    codingProject: false,
    specChapters: GENERAL_SPEC_CHAPTERS,
    milestoneDeliverables: ["clarified deliverable", "acceptance evidence"],
    workItemValidation: ["review", "acceptance"],
    allowsRepositoryMutation: false
  })
};

export function getProfileByKind(kind: ProjectProfileKind): ProjectProfile {
  return immutableProfile(PROFILES[kind]);
}

export function selectProjectProfile(shape: string | undefined): ProjectProfile {
  const normalized = (shape ?? "").toLowerCase();
  // Ordered from specific signals to broader project surfaces so mixed phrases keep the strongest profile.
  if (/\b(cli|command line|package|library|npm|sdk)\b/.test(normalized)) return getProfileByKind("cli_package");
  if (/\b(local ai|llm|embedding|rag (pipeline|retrieval|system)|offline ai|local model|ai model|ml model)\b/.test(normalized)) {
    return getProfileByKind("local_ai");
  }
  if (/\b(doc|documentation|content|article|guide|manual|course)\b/.test(normalized)) return getProfileByKind("documentation");
  if (/\b(research|evidence|study|research brief)\b/.test(normalized)) return getProfileByKind("research");
  if (/\b(design|prototype|wireframe|brand|ux)\b/.test(normalized)) return getProfileByKind("design");
  if (/\b(process|operations|workflow|policy|playbook|procedure)\b/.test(normalized)) return getProfileByKind("process");
  if (/\b(export|markdown-only|markdown only|no repo mutation)\b/.test(normalized)) return getProfileByKind("export_only");
  if (/\b(app|service|backend|frontend|desktop|web|api)\b/.test(normalized)) return getProfileByKind("coding");
  return getProfileByKind("unknown");
}

export function specChaptersForProject(shape: string | undefined): readonly string[] {
  return selectProjectProfile(shape).specChapters;
}

export function workItemValidationForProject(shape: string | undefined): readonly string[] {
  return selectProjectProfile(shape).workItemValidation;
}
