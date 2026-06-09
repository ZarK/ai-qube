import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { AgentHostKind, AgentNextAction, PlanningState } from "./contracts.js";
import { createInitialPlanningState } from "./contracts.js";

export type BootstrapPhase = "discovery" | "spec_drafting" | "spec_acceptance" | "milestone_generation" | "work_item_generation" | "finalized" | "blocked";

export interface DiscoveryQuestion {
  readonly id: string;
  readonly text: string;
  readonly why: string;
  readonly answerType: "short-text" | "bullets";
  readonly affects: readonly string[];
}

export interface BootstrapState {
  readonly version: 1;
  readonly phase: BootstrapPhase;
  readonly project: {
    readonly intent?: string;
    readonly audience?: string;
    readonly coreJob?: string;
    readonly successNarrative?: string;
    readonly scope?: string;
    readonly nonGoals?: string;
    readonly shape?: string;
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

const DISCOVERY_QUESTIONS: readonly DiscoveryQuestion[] = [
  {
    id: "project.intent",
    text: "What are you trying to create?",
    why: "This anchors the spec around the project goal before implementation details appear.",
    answerType: "short-text",
    affects: ["project.intent"]
  },
  {
    id: "project.audience",
    text: "Who is this for?",
    why: "Audience changes the product shape, UX expectations, language, and validation criteria.",
    answerType: "short-text",
    affects: ["project.audience"]
  },
  {
    id: "project.coreJob",
    text: "What core job should it do first?",
    why: "A clear first job prevents the initial spec from becoming a feature list without a center.",
    answerType: "short-text",
    affects: ["project.coreJob"]
  },
  {
    id: "project.successNarrative",
    text: "What should feel successful when the first useful version works?",
    why: "The success narrative gives milestones and work items a concrete target.",
    answerType: "bullets",
    affects: ["project.successNarrative"]
  },
  {
    id: "project.scope",
    text: "What is in scope for the first version?",
    why: "Scope defines the boundary between spec work and later ideas.",
    answerType: "bullets",
    affects: ["project.scope"]
  },
  {
    id: "project.nonGoals",
    text: "What should it intentionally not do yet?",
    why: "Non-goals protect the plan from premature implementation depth.",
    answerType: "bullets",
    affects: ["project.nonGoals"]
  },
  {
    id: "project.shape",
    text: "What kind of project is this: app, CLI, service, document set, research effort, process, or something else?",
    why: "Project shape controls which spec chapters and milestone templates apply.",
    answerType: "short-text",
    affects: ["project.shape"]
  }
];

export function defaultStatePath(target: string | undefined, stateDir = ".bootstrap"): string {
  return resolve(target && target.length > 0 ? target : ".", stateDir, "session.json");
}

export function createBootstrapState(input: {
  readonly intent?: string;
  readonly agentHost?: AgentHostKind;
  readonly questionBudget?: number;
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
  const artifacts = requireRecord(value.artifacts, "artifacts") as unknown as BootstrapState["artifacts"];
  const planning = requireRecord(value.planning, "planning") as unknown as PlanningState;
  const assumptions = Array.isArray(value.assumptions) ? value.assumptions.filter((item): item is string => typeof item === "string") : [];
  const questionBudget = agent.questionBudget;
  if (typeof questionBudget !== "number" || !Number.isInteger(questionBudget) || questionBudget < 1 || questionBudget > 8) {
    throw new TypeError("bootstrap state agent.questionBudget must be an integer between 1 and 8.");
  }
  return {
    version: 1,
    phase: value.phase,
    project: parseProject(project),
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
    return {
      kind: state.phase === "finalized" ? "stop" : "generate_artifacts",
      actor: "agent",
      summary: `Continue ${state.phase}.`,
      missingDecisions: [],
      nextCommand: "aib status --json"
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
      nextCommand: "aib spec draft --json"
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
    stateFields: questions.flatMap((question) => question.affects),
    nextCommand: `aib answer --field ${questions[0]?.id ?? "project.intent"} --value <answer> --json`,
    stopCondition: "Stop after asking this batch and wait for the human's answers."
  };
}

export function applyAnswer(state: BootstrapState, field: string, value: string, assumption: boolean): BootstrapState {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError("answer value must not be empty.");
  const question = DISCOVERY_QUESTIONS.find((candidate) => candidate.id === field);
  if (!question) throw new TypeError(`unsupported answer field: ${field}.`);
  const key = field.slice("project.".length);
  const project = { ...state.project, [key]: normalized };
  const planning = createInitialPlanningState({
    intent: project.intent,
    specPath: state.artifacts.spec.path
  });
  return {
    ...state,
    project,
    assumptions: assumption ? [...state.assumptions, `${field}: ${normalized}`] : state.assumptions,
    planning: {
      ...planning,
      project: {
        ...planning.project,
        intent: project.intent,
        type: project.shape
      },
      artifacts: state.artifacts,
      nextAction: computeNextAction({ ...state, project }).kind === "ask_human" ? planning.nextAction : {
        kind: "draft_spec",
        actor: "agent",
        summary: "Discovery has enough high-level project context. Draft the initial spec next."
      }
    }
  };
}

export function missingDiscoveryFields(state: BootstrapState): readonly DiscoveryQuestion[] {
  return DISCOVERY_QUESTIONS.filter((question) => {
    const key = question.id.slice("project.".length) as keyof BootstrapState["project"];
    const value = state.project[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
}

function parseProject(value: Readonly<Record<string, unknown>>): BootstrapState["project"] {
  return {
    ...(typeof value.intent === "string" ? { intent: value.intent } : {}),
    ...(typeof value.audience === "string" ? { audience: value.audience } : {}),
    ...(typeof value.coreJob === "string" ? { coreJob: value.coreJob } : {}),
    ...(typeof value.successNarrative === "string" ? { successNarrative: value.successNarrative } : {}),
    ...(typeof value.scope === "string" ? { scope: value.scope } : {}),
    ...(typeof value.nonGoals === "string" ? { nonGoals: value.nonGoals } : {}),
    ...(typeof value.shape === "string" ? { shape: value.shape } : {})
  };
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

function isAgentHost(value: string): value is AgentHostKind {
  return value === "codex" || value === "opencode" || value === "claude-code" || value === "gemini" || value === "other";
}
