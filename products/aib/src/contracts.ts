export type ArtifactStatus = "missing" | "draft" | "ready" | "accepted" | "blocked" | "unknown";
export type CapabilityStatus = "supported" | "unsupported" | "unknown" | "policy-blocked";
export type ProviderRole = "work" | "forge" | "review" | "ci" | "layout";
export type AgentHostKind = "codex" | "opencode" | "claude-code" | "gemini" | "other";
export type WorkItemPriority = "critical" | "high" | "normal" | "low";
export type WorkItemStatus = "draft" | "ready" | "blocked" | "rendered";
export type AgentActionKind = "ask_human" | "inspect_context" | "draft_spec" | "request_acceptance" | "generate_artifacts" | "stop";

export interface Capability {
  readonly status: CapabilityStatus;
  readonly reason?: string;
}

export interface CapabilityReport<Operations extends string = string> {
  readonly id: string;
  readonly kind: string;
  readonly operations: Readonly<Record<Operations, Capability>>;
}

export interface ProviderCapabilityReport extends CapabilityReport {
  readonly role: ProviderRole;
}

export interface AgentHostCapabilityReport extends CapabilityReport {
  readonly host: AgentHostKind;
}

export interface SourceAnchor {
  readonly artifact: string;
  readonly section?: string;
}

export interface ContextInspectionTarget {
  readonly id: string;
  readonly kind: "current_repo" | "docs" | "sibling_repo" | "reference";
  readonly path: string;
  readonly reason: string;
  readonly privacy: "local-only" | "shareable-summary";
}

export interface ContextInspectionPlan {
  readonly targets: readonly ContextInspectionTarget[];
  readonly instructions: readonly string[];
  readonly evidencePolicy: string;
}

export interface WorkItemBodySection {
  readonly heading: string;
  readonly body: string;
}

export interface WorkItemDraft {
  readonly draftId: string;
  readonly title: string;
  readonly bodySections: readonly WorkItemBodySection[];
  readonly priority: WorkItemPriority;
  readonly status: WorkItemStatus;
  readonly components: readonly string[];
  readonly blockedBy?: readonly string[];
  readonly sequence?: number;
  readonly sourceAnchors?: readonly SourceAnchor[];
  readonly providerMetadata?: Readonly<Record<string, unknown>>;
}

export interface MilestoneDraft {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly summary: string;
  readonly boundaries: readonly string[];
  readonly dependencies: readonly string[];
  readonly proofOfCompletion: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly likelyWorkItemThemes: readonly string[];
  readonly technicalDecisions: readonly string[];
  readonly specAnchors: readonly string[];
}

export interface PlanningArtifact {
  readonly path: string;
  readonly status: ArtifactStatus;
}

export interface AgentNextAction {
  readonly kind: AgentActionKind;
  readonly actor: "agent";
  readonly summary: string;
  readonly questionBudget?: number;
  readonly stateFields?: readonly string[];
  readonly contextInspection?: ContextInspectionPlan;
}

export interface PlanningState {
  readonly version: 1;
  readonly project: {
    readonly intent?: string;
    readonly name?: string;
    readonly type?: string;
  };
  readonly artifacts: {
    readonly spec: PlanningArtifact;
    readonly milestones: readonly PlanningArtifact[];
    readonly workItems: readonly PlanningArtifact[];
  };
  readonly milestoneDrafts: readonly MilestoneDraft[];
  readonly workItemDrafts: readonly WorkItemDraft[];
  readonly providers: readonly ProviderCapabilityReport[];
  readonly agentHosts: readonly AgentHostCapabilityReport[];
  readonly nextAction: AgentNextAction;
}

export function capability(status: CapabilityStatus, reason?: string): Capability {
  return reason ? { status, reason } : { status };
}

export function createInitialPlanningState(input: {
  readonly intent?: string;
  readonly specPath?: string;
} = {}): PlanningState {
  return {
    version: 1,
    project: {
      ...(input.intent ? { intent: input.intent } : {})
    },
    artifacts: {
      spec: {
        path: input.specPath ?? "docs/spec.md",
        status: "missing"
      },
      milestones: [],
      workItems: []
    },
    milestoneDrafts: [],
    workItemDrafts: [],
    providers: [],
    agentHosts: [],
    nextAction: {
      kind: "ask_human",
      actor: "agent",
      summary: "Ask the human for product intent and project shape before provider or host details.",
      questionBudget: 3,
      stateFields: ["project.intent", "project.type"]
    }
  };
}
