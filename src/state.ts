import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentHostKind, AgentNextAction, ContextInspectionTarget, PlanningState } from "./contracts.js";
import { createInitialPlanningState } from "./contracts.js";

export type BootstrapPhase = "discovery" | "spec_drafting" | "spec_acceptance" | "milestone_generation" | "work_item_generation" | "finalized" | "blocked";
export type AnswerErrorKind = "answer-field-invalid" | "answer-value-invalid" | "answer-transition-invalid";

export interface DiscoveryQuestion {
  readonly id: string;
  readonly phase: "project_clarification" | "spec_completion" | "milestone_boundary" | "work_item_detail";
  readonly depth: "high" | "spec" | "milestone" | "work_item";
  readonly text: string;
  readonly why: string;
  readonly recommendedDefault: string;
  readonly answerType: "short-text" | "bullets";
  readonly stateFields: readonly string[];
}

export interface BootstrapState {
  readonly version: 1;
  readonly phase: BootstrapPhase;
  readonly project: {
    readonly intent?: string;
    readonly audience?: string;
    readonly coreJob?: string;
    readonly shape?: string;
    readonly successNarrative?: string;
    readonly scope?: string;
    readonly nonGoals?: string;
    readonly constraints?: string;
    readonly reuseBoundary?: string;
    readonly planningSurface?: string;
  };
  readonly discovery: {
    readonly referencePaths: readonly string[];
    readonly inspectCurrentRepo: boolean;
    readonly inspectDocs: boolean;
    readonly inspectSiblingRepos: boolean;
    // Agent-private discovery bookkeeping. These values preserve context without changing product conclusions by themselves.
    readonly inspectedSources: readonly string[];
    readonly knownDecisions: readonly string[];
    readonly unresolvedQuestions: readonly string[];
  };
  readonly agent: {
    readonly host?: AgentHostKind;
    readonly questionBudget: number;
  };
  readonly assumptions: readonly string[];
  readonly artifacts: PlanningState["artifacts"];
  readonly planning: PlanningState;
}

export interface StateEnvelope {
  readonly statePath: string;
  readonly state: BootstrapState;
}

export interface ComputedNextAction extends AgentNextAction {
  readonly questions?: readonly DiscoveryQuestion[];
  readonly missingDecisions: readonly string[];
  readonly nextCommand?: string;
  readonly stopCondition?: string;
}

export class AnswerError extends TypeError {
  readonly kind: AnswerErrorKind;

  constructor(kind: AnswerErrorKind, message: string) {
    super(message);
    this.name = "AnswerError";
    this.kind = kind;
  }
}

const DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = [
  {
    id: "project.intent",
    phase: "project_clarification",
    depth: "high",
    text: "What are you trying to create?",
    why: "This anchors the spec around the project goal before implementation details appear.",
    recommendedDefault: "A one-sentence project intent is enough for now.",
    answerType: "short-text",
    stateFields: ["project.intent"]
  },
  {
    id: "project.audience",
    phase: "project_clarification",
    depth: "high",
    text: "Who is this for?",
    why: "Audience changes the product shape, UX expectations, language, and validation criteria.",
    recommendedDefault: "Name the primary user or stakeholder group; use 'not sure' if it is not known yet.",
    answerType: "short-text",
    stateFields: ["project.audience"]
  },
  {
    id: "project.coreJob",
    phase: "project_clarification",
    depth: "high",
    text: "What core job should it do first?",
    why: "A clear first job prevents the initial spec from becoming a feature list without a center.",
    recommendedDefault: "Describe the first valuable outcome rather than every future feature.",
    answerType: "short-text",
    stateFields: ["project.coreJob"]
  },
  {
    id: "project.shape",
    phase: "project_clarification",
    depth: "high",
    text: "What kind of project is this: app, CLI, service, document set, research effort, process, or something else?",
    why: "Project shape controls which spec chapters and milestone templates apply.",
    recommendedDefault: "If uncertain, say the closest shape and mark it as an assumption.",
    answerType: "short-text",
    stateFields: ["project.shape"]
  },
  {
    id: "project.successNarrative",
    phase: "project_clarification",
    depth: "high",
    text: "What should feel successful when the first useful version works?",
    why: "The success narrative gives milestones and work items a concrete target.",
    recommendedDefault: "List the concrete moment where the target user would say the first version works.",
    answerType: "bullets",
    stateFields: ["project.successNarrative"]
  },
  {
    id: "project.scope",
    phase: "project_clarification",
    depth: "high",
    text: "What is in scope for the first version?",
    why: "Scope defines the boundary between spec work and later ideas.",
    recommendedDefault: "Keep this to the smallest useful release or deliverable.",
    answerType: "bullets",
    stateFields: ["project.scope"]
  },
  {
    id: "project.nonGoals",
    phase: "project_clarification",
    depth: "high",
    text: "What should it intentionally not do yet?",
    why: "Non-goals protect the plan from premature implementation depth.",
    recommendedDefault: "Call out the tempting but deferred work.",
    answerType: "bullets",
    stateFields: ["project.nonGoals"]
  },
  {
    id: "project.constraints",
    phase: "project_clarification",
    depth: "high",
    text: "Are there any important platform, runtime, offline, privacy, organization, or audience constraints?",
    why: "High-level constraints shape the spec without forcing technical design too early.",
    recommendedDefault: "Use 'not sure' if there are no known constraints yet.",
    answerType: "bullets",
    stateFields: ["project.constraints"]
  },
  {
    id: "project.reuseBoundary",
    phase: "project_clarification",
    depth: "high",
    text: "Should this be planned as a reusable package/tool, a one-project solution, or both with a clear boundary?",
    why: "Reusable work needs requirements separated from reference-project evidence and consumer-specific details.",
    recommendedDefault: "Default to a reusable core plus project-specific examples only when the user says reuse matters.",
    answerType: "short-text",
    stateFields: ["project.reuseBoundary"]
  },
  {
    id: "project.planningSurface",
    phase: "project_clarification",
    depth: "high",
    text: "Should planning outputs stay as local markdown first, use a work tracker later, or both?",
    why: "This makes repository mutation and work-item rendering explicit instead of hidden assumptions.",
    recommendedDefault: "Default to local markdown drafts first, then render to a tracker only after review.",
    answerType: "short-text",
    stateFields: ["project.planningSurface"]
  }
];

export function defaultStatePath(target: string | undefined, stateDir = ".bootstrap"): string {
  return resolve(target && target.length > 0 ? target : ".", stateDir, "session.json");
}

export function createBootstrapState(input: {
  readonly intent?: string;
  readonly agentHost?: AgentHostKind;
  readonly questionBudget?: number;
  readonly referencePaths?: readonly string[];
  readonly inspectCurrentRepo?: boolean;
  readonly inspectDocs?: boolean;
  readonly inspectSiblingRepos?: boolean;
  readonly specPath?: string;
}): BootstrapState {
  const planning = createInitialPlanningState({
    intent: input.intent,
    specPath: input.specPath
  });
  return {
    version: 1,
    phase: "discovery",
    project: {
      ...(input.intent ? { intent: input.intent } : {})
    },
    discovery: {
      referencePaths: input.referencePaths ?? [],
      inspectCurrentRepo: input.inspectCurrentRepo ?? false,
      inspectDocs: input.inspectDocs ?? false,
      inspectSiblingRepos: input.inspectSiblingRepos ?? false,
      inspectedSources: [],
      knownDecisions: [],
      unresolvedQuestions: []
    },
    agent: {
      ...(input.agentHost ? { host: input.agentHost } : {}),
      questionBudget: input.questionBudget ?? 3
    },
    assumptions: [],
    artifacts: planning.artifacts,
    planning
  };
}

export function readBootstrapState(statePath: string): StateEnvelope {
  const resolved = resolve(statePath);
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  return {
    statePath: resolved,
    state: parseBootstrapState(parsed)
  };
}

export function writeBootstrapState(statePath: string, state: BootstrapState): StateEnvelope {
  const resolved = resolve(statePath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`);
  return { statePath: resolved, state };
}

export function parseBootstrapState(value: unknown): BootstrapState {
  if (!isRecord(value)) throw new TypeError("bootstrap state must be a JSON object.");
  if (value.version !== 1) throw new TypeError("bootstrap state version must be 1.");
  if (!isPhase(value.phase)) throw new TypeError("bootstrap state phase is missing or invalid.");
  const project = requireRecord(value.project, "project");
  const agent = requireRecord(value.agent, "agent");
  const discovery = value.discovery === undefined ? undefined : requireRecord(value.discovery, "discovery");
  const artifacts = parseArtifacts(value.artifacts);
  const planning = parsePlanning(value.planning);
  const assumptions = Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string") : [];
  const questionBudget = agent.questionBudget;
  if (typeof questionBudget !== "number" || !Number.isInteger(questionBudget) || questionBudget < 1 || questionBudget > 8) {
    throw new TypeError("bootstrap state agent.questionBudget must be an integer between 1 and 8.");
  }
  return {
    version: 1,
    phase: value.phase,
    project: parseProject(project),
    discovery: parseDiscovery(discovery),
    agent: {
      ...(typeof agent.host === "string" && isAgentHost(agent.host) ? { host: agent.host } : {}),
      questionBudget
    },
    assumptions,
    artifacts,
    planning
  };
}

export function computeNextAction(state: BootstrapState): ComputedNextAction {
  if (state.phase !== "discovery") {
    if (state.phase === "finalized" || state.phase === "blocked") {
      return {
        kind: "stop",
        actor: "agent",
        summary: state.phase === "finalized" ? "Bootstrap planning is finalized." : "Bootstrap planning is blocked.",
        missingDecisions: [],
        nextCommand: "aib status --json",
        stopCondition: state.phase === "blocked" ? "Stop until the blocker is resolved in bootstrap state." : "Stop because no further bootstrap action is required."
      };
    }
    if (state.phase === "spec_drafting") {
      return {
        kind: "draft_spec",
        actor: "agent",
        summary: "Draft the project spec from recorded discovery state.",
        missingDecisions: [],
        stateFields: ["artifacts.spec"],
        nextCommand: "aib status --json",
        stopCondition: "Stop after drafting or updating the spec artifact, then record the phase change in state."
      };
    }
    if (state.phase === "spec_acceptance") {
      return {
        kind: "request_acceptance",
        actor: "agent",
        summary: "Ask the human to review and accept the current spec sections.",
        missingDecisions: [],
        stateFields: ["artifacts.spec"],
        nextCommand: "aib status --json",
        stopCondition: "Stop after requesting spec acceptance and wait for the human's decision."
      };
    }
    return {
      kind: "generate_artifacts",
      actor: "agent",
      summary: `Continue ${state.phase}.`,
      missingDecisions: [],
      nextCommand: "aib status --json"
    };
  }

  const inspectionTargets = contextInspectionTargets(state);
  if (inspectionTargets.length > 0) {
    return {
      kind: "inspect_context",
      actor: "agent",
      summary: "Inspect repository and reference context before asking the human more questions.",
      contextInspection: {
        targets: inspectionTargets,
        instructions: [
          "Read only enough context to identify existing docs, specs, project shape, constraints, and reusable boundaries.",
          "Summarize decisions, assumptions, and unresolved questions in product language.",
          "Do not copy local paths, private repo names, or reference evidence into generated product artifacts by default."
        ],
        evidencePolicy: "Store reference evidence in bootstrap state or issue comments; generated specs should use product conclusions, not private source provenance."
      },
      missingDecisions: ["discovery.inspectedSources"],
      stateFields: ["discovery.inspectedSources", "discovery.knownDecisions", "discovery.unresolvedQuestions"],
      nextCommand: "aib answer --field discovery.inspectedSources --value <inspection-summary> --json",
      stopCondition: "Stop after inspecting these sources and record the private summary before asking more human questions."
    };
  }

  const missing = missingDiscoveryFields(state);
  if (missing.length === 0) {
    return {
      kind: "draft_spec",
      actor: "agent",
      summary: "Discovery has enough high-level project context. Draft the initial spec next.",
      missingDecisions: [],
      stateFields: ["artifacts.spec"],
      nextCommand: "aib status --json",
      stopCondition: "Stop after drafting the spec artifact, then update bootstrap state before continuing."
    };
  }

  const questions = missing.slice(0, state.agent.questionBudget);
  return {
    kind: "ask_human",
    actor: "agent",
    summary: "Ask the human the next small batch of discovery questions.",
    questionBudget: state.agent.questionBudget,
    questions,
    missingDecisions: missing.map((question) => question.id),
    stateFields: questions.flatMap((question) => question.stateFields),
    nextCommand: `aib answer --field ${questions[0]?.id ?? "project.intent"} --value <answer> --json`,
    stopCondition: "Stop after asking this batch and wait for the human's answers."
  };
}

export function applyAnswer(state: BootstrapState, field: string, value: string, assumption: boolean): BootstrapState {
  if (state.phase !== "discovery") {
    throw new AnswerError("answer-transition-invalid", `answer can only update discovery state; current phase is ${state.phase}.`);
  }
  const raw = value.trim();
  const defaulted = isDefaultAnswer(raw);
  const normalized = defaulted ? `Assume a reasonable default for ${field}.` : raw;
  if (normalized.length === 0) throw new AnswerError("answer-value-invalid", "answer value must not be empty.");
  if (field.startsWith("discovery.")) {
    return applyDiscoveryAnswer(state, field, normalized, assumption || defaulted);
  }
  const question = DISCOVERY_QUESTIONS.find((candidate) => candidate.id === field);
  if (!question) throw new AnswerError("answer-field-invalid", `unsupported answer field: ${field}.`);
  const key = field.slice("project.".length);
  const project = { ...state.project, [key]: normalized };
  const nextAction = computeNextAction({ ...state, project });
  const planning = createInitialPlanningState({
    intent: project.intent,
    specPath: state.artifacts.spec.path
  });
  return {
    ...state,
    project,
    assumptions: assumption || defaulted ? [...state.assumptions, `${field}: ${normalized}`] : state.assumptions,
    planning: {
      ...planning,
      project: {
        ...planning.project,
        intent: project.intent,
        type: project.shape
      },
      artifacts: state.artifacts,
      nextAction
    }
  };
}

export function isAgentHost(value: string): value is AgentHostKind {
  return value === "codex" || value === "opencode" || value === "claude-code" || value === "gemini" || value === "other";
}

export function missingDiscoveryFields(state: BootstrapState): readonly DiscoveryQuestion[] {
  return DISCOVERY_QUESTIONS.filter((question) => {
    if (question.id === "project.reuseBoundary" && !isReusablePackageState(state)) return false;
    if (question.id === "project.planningSurface" && !needsPlanningSurfaceDecision(state)) return false;
    const key = question.id.slice("project.".length) as keyof BootstrapState["project"];
    const value = state.project[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

function applyDiscoveryAnswer(state: BootstrapState, field: string, value: string, assumption: boolean): BootstrapState {
  if (field !== "discovery.inspectedSources" && field !== "discovery.knownDecisions" && field !== "discovery.unresolvedQuestions") {
    throw new AnswerError("answer-field-invalid", `unsupported answer field: ${field}.`);
  }
  const key = field.slice("discovery.".length) as "inspectedSources" | "knownDecisions" | "unresolvedQuestions";
  const updatedState = {
    ...state,
    discovery: {
      ...state.discovery,
      [key]: [...state.discovery[key], value]
    },
    assumptions: assumption ? [...state.assumptions, `${field}: ${value}`] : state.assumptions
  };
  return {
    ...updatedState,
    planning: {
      ...updatedState.planning,
      nextAction: computeNextAction(updatedState)
    }
  };
}

function contextInspectionTargets(state: BootstrapState): readonly ContextInspectionTarget[] {
  // Inspection is one-shot per session until a later command records per-target status.
  if (!state.project.intent || state.discovery.inspectedSources.length > 0) return [];
  const haystack = `${state.project.intent} ${state.project.shape ?? ""}`.toLowerCase();
  const inspectCurrentRepo = state.discovery.inspectCurrentRepo || /\b(existing repo|repository|workspace|nearby repo|reference repo)\b/.test(haystack);
  const targets: ContextInspectionTarget[] = [];
  if (inspectCurrentRepo) {
    targets.push({
      id: "current-repo",
      kind: "current_repo",
      path: ".",
      reason: "The idea or config indicates local repository context may already contain decisions or constraints.",
      privacy: "local-only"
    });
  }
  if (state.discovery.inspectDocs) {
    targets.push({
      id: "docs",
      kind: "docs",
      path: dirname(state.artifacts.spec.path),
      reason: "Existing docs may already contain product intent, specs, milestones, or non-goals.",
      privacy: "local-only"
    });
  }
  if (state.discovery.inspectSiblingRepos) {
    targets.push({
      id: "sibling-repos",
      kind: "sibling_repo",
      path: "..",
      reason: "Sibling repositories may provide reference shape or reusable package boundaries.",
      privacy: "local-only"
    });
  }
  for (const [index, path] of state.discovery.referencePaths.entries()) {
    targets.push({
      id: `reference-${index + 1}`,
      kind: "reference",
      path,
      reason: "Explicitly provided reference material should inform questions without leaking source-specific details.",
      privacy: "local-only"
    });
  }
  return targets;
}

function isReusablePackageState(state: BootstrapState): boolean {
  const haystack = `${state.project.intent ?? ""} ${state.project.shape ?? ""}`.toLowerCase();
  return /\b(reusable|package|library|sdk|cli|tooling)\b/.test(haystack);
}

function needsPlanningSurfaceDecision(state: BootstrapState): boolean {
  const haystack = `${state.project.intent ?? ""} ${state.project.shape ?? ""}`.toLowerCase();
  return state.discovery.referencePaths.length > 0
    || state.discovery.inspectCurrentRepo
    || state.discovery.inspectDocs
    || state.discovery.inspectSiblingRepos
    || isReusablePackageState(state)
    || /\b(repo|repository|work item|issue tracker|work tracker|github|linear|jira)\b/.test(haystack);
}

function parseProject(value: Readonly<Record<string, unknown>>): BootstrapState["project"] {
  return {
    ...(typeof value.intent === "string" ? { intent: value.intent } : {}),
    ...(typeof value.audience === "string" ? { audience: value.audience } : {}),
    ...(typeof value.coreJob === "string" ? { coreJob: value.coreJob } : {}),
    ...(typeof value.shape === "string" ? { shape: value.shape } : {}),
    ...(typeof value.successNarrative === "string" ? { successNarrative: value.successNarrative } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.nonGoals === "string" ? { nonGoals: value.nonGoals } : {}),
    ...(typeof value.constraints === "string" ? { constraints: value.constraints } : {}),
    ...(typeof value.reuseBoundary === "string" ? { reuseBoundary: value.reuseBoundary } : {}),
    ...(typeof value.planningSurface === "string" ? { planningSurface: value.planningSurface } : {})
  };
}

function parseDiscovery(value: Readonly<Record<string, unknown>> | undefined): BootstrapState["discovery"] {
  return {
    referencePaths: parseStringArray(value?.referencePaths),
    inspectCurrentRepo: typeof value?.inspectCurrentRepo === "boolean" ? value.inspectCurrentRepo : false,
    inspectDocs: typeof value?.inspectDocs === "boolean" ? value.inspectDocs : false,
    inspectSiblingRepos: typeof value?.inspectSiblingRepos === "boolean" ? value.inspectSiblingRepos : false,
    inspectedSources: parseStringArray(value?.inspectedSources),
    knownDecisions: parseStringArray(value?.knownDecisions),
    unresolvedQuestions: parseStringArray(value?.unresolvedQuestions)
  };
}

function parseStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isDefaultAnswer(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "default" || normalized === "not sure" || normalized === "not sure yet" || normalized === "unknown" || normalized === "tbd";
}

function parseArtifacts(value: unknown, field = "artifacts"): BootstrapState["artifacts"] {
  const record = requireRecord(value, field);
  const spec = parseArtifact(record.spec, `${field}.spec`);
  const milestones = parseArtifactArray(record.milestones, `${field}.milestones`);
  const workItems = parseArtifactArray(record.workItems, `${field}.workItems`);
  return { spec, milestones, workItems };
}

function parsePlanning(value: unknown): PlanningState {
  const record = requireRecord(value, "planning");
  const project = requireRecord(record.project, "planning.project");
  const artifacts = parseArtifacts(record.artifacts, "planning.artifacts");
  const nextAction = requireRecord(record.nextAction, "planning.nextAction");
  if (record.version !== 1) throw new TypeError("bootstrap state planning.version must be 1.");
  if (typeof nextAction.kind !== "string") throw new TypeError("bootstrap state planning.nextAction.kind must be a string.");
  if (nextAction.actor !== "agent") throw new TypeError("bootstrap state planning.nextAction.actor must be agent.");
  if (typeof nextAction.summary !== "string") throw new TypeError("bootstrap state planning.nextAction.summary must be a string.");
  return {
    version: 1,
    project: {
      ...(typeof project.intent === "string" ? { intent: project.intent } : {}),
      ...(typeof project.name === "string" ? { name: project.name } : {}),
      ...(typeof project.type === "string" ? { type: project.type } : {})
    },
    artifacts,
    workItemDrafts: Array.isArray(record.workItemDrafts) ? record.workItemDrafts as PlanningState["workItemDrafts"] : [],
    providers: Array.isArray(record.providers) ? record.providers as PlanningState["providers"] : [],
    agentHosts: Array.isArray(record.agentHosts) ? record.agentHosts as PlanningState["agentHosts"] : [],
    nextAction: {
      kind: nextAction.kind as PlanningState["nextAction"]["kind"],
      actor: "agent",
      summary: nextAction.summary,
      ...(typeof nextAction.questionBudget === "number" ? { questionBudget: nextAction.questionBudget } : {}),
      ...(Array.isArray(nextAction.stateFields) ? { stateFields: nextAction.stateFields.filter((item): item is string => typeof item === "string") } : {})
    }
  };
}

function parseArtifact(value: unknown, field: string): BootstrapState["artifacts"]["spec"] {
  const record = requireRecord(value, field);
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw new TypeError(`bootstrap state ${field}.path must be a non-empty string.`);
  }
  if (!isArtifactStatus(record.status)) {
    throw new TypeError(`bootstrap state ${field}.status is missing or invalid.`);
  }
  return {
    path: record.path,
    status: record.status
  };
}

function parseArtifactArray(value: unknown, field: string): BootstrapState["artifacts"]["milestones"] {
  if (!Array.isArray(value)) throw new TypeError(`bootstrap state ${field} must be an array.`);
  return value.map((item, index) => parseArtifact(item, `${field}[${index}]`));
}

function isArtifactStatus(value: unknown): value is BootstrapState["artifacts"]["spec"]["status"] {
  return value === "missing" || value === "draft" || value === "ready" || value === "accepted" || value === "blocked" || value === "unknown";
}

function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`bootstrap state ${field} must be an object.`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPhase(value: unknown): value is BootstrapPhase {
  return value === "discovery" || value === "spec_drafting" || value === "spec_acceptance" || value === "milestone_generation" || value === "work_item_generation" || value === "finalized" || value === "blocked";
}
