import {
  AGENT_HOST_IDS,
  AGENT_HOST_CAPABILITY_PROFILES,
  AGENT_HOST_REGISTRATIONS,
  observeAgentHostReadiness,
  gitLabAdapterContract,
  githubAdapterContract,
  jenkinsAdapterContract,
  jiraAdapterContract,
  linearAdapterContract,
  type AgentHostCapability,
  type AgentHostCapabilityProfile,
  type AgentHostProfile,
  type AgentHostReadinessReport,
  type QubeAdapterCapability,
  type QubeAdapterContract,
  type QubeIntegrationSurface,
  type ConnectionContract,
} from "@tjalve/qube-core";
import { getAgentHostProfileSync } from "@tjalve/aie";

import { dependencyVersion } from "./package.js";


export type QubeOptionSupport = "installed" | "optional" | "unsupported";
export type QubeDiscoveryCapabilitySupport = QubeAdapterCapability["support"] | AgentHostCapability["support"] | "host-provided";

export interface QubeDiscoveryOption {
  readonly id: string;
  readonly support: QubeOptionSupport;
  readonly packageName: string | null;
  readonly surface: QubeIntegrationSurface;
  readonly source: "adapter-contract" | "agent-host-profile";
  readonly default: boolean;
  readonly summary: string;
  readonly capabilities: readonly QubeDiscoveryCapability[];
  readonly connection: ConnectionContract | null;
  readonly declaredProfile?: AgentHostCapabilityProfile;
  readonly readiness?: AgentHostReadinessReport;
}

export interface QubeDiscoveryCapability {
  readonly id: string;
  readonly support: QubeDiscoveryCapabilitySupport;
  readonly owner: string;
  readonly summary: string;
}

export interface QubeInitCapability {
  readonly participatesByDefault: boolean;
  readonly scopes: readonly ("global" | "repository")[];
  readonly command: readonly string[];
  readonly supportsToolSelection: boolean;
  readonly alreadyInitializedHint: string;
}

export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
  readonly initCapability?: QubeInitCapability;
  readonly capabilities?: {
    readonly localReview?: {
      readonly freshContextReviewerSupport: "host-provided" | "configured-command" | "prompt-only" | "unsupported";
      readonly manualEvidenceSatisfiesRequiredGate: boolean;
      readonly provenanceRequired: readonly string[];
      readonly provenanceAlternatives: readonly {
        readonly anyOf: readonly string[];
        readonly description: string;
      }[];
      readonly evidencePathPattern: string;
      readonly hostProvenancePathPattern: string;
      readonly nextAction: string;
    };
    readonly hostSurfaces?: readonly QubeDiscoveryOption[];
    readonly workProviders?: readonly QubeDiscoveryOption[];
    readonly ciProviders?: readonly QubeDiscoveryOption[];
  };
}

function adapterOption(
  adapter: QubeAdapterContract,
  support: QubeOptionSupport,
  summary: string,
  isDefault = false,
): QubeDiscoveryOption {
  return Object.freeze({
    id: adapter.id,
    support,
    packageName: adapter.packageName,
    surface: adapter.surface,
    source: "adapter-contract",
    default: isDefault,
    summary,
    capabilities: Object.freeze([...(adapter.capabilities ?? [])]),
    connection: adapter.connection ?? null,
  });
}

function normalizeCapabilitySupport(support: string): QubeDiscoveryCapabilitySupport {
  if (support === "unsupported" || support === "experimental" || support === "standalone" || support === "host-provided") return support;
  return "supported";
}

function profileCapability(id: string, capability: AgentHostCapability, owner: string): QubeDiscoveryCapability {
  return Object.freeze({
    id,
    support: capability.support,
    owner,
    summary: `${capability.description}${capability.nextAction ? ` Next: ${capability.nextAction}` : ""}`,
  });
}

function agentHostOption(profile: AgentHostProfile): QubeDiscoveryOption {
  const registration = AGENT_HOST_REGISTRATIONS[profile.id];
  const declaredProfile = AGENT_HOST_CAPABILITY_PROFILES[profile.id];
  const trustActions = profile.trust.actions.map(action => action.description).join(" ");
  return Object.freeze({
    id: profile.id,
    support: "installed",
    packageName: registration.packageName,
    surface: profile.id,
    source: "agent-host-profile",
    default: profile.id === "codex",
    summary: `${profile.displayName} reads ${profile.instructionTarget.path} and starts QUBE through ${profile.makeItSo.invocation}.`,
    capabilities: Object.freeze([
      Object.freeze({ id: "instructions", support: "supported", owner: registration.packageName, summary: profile.instructionTarget.description }),
      Object.freeze({ id: "make-it-so", support: "supported", owner: registration.packageName, summary: `${profile.makeItSo.description} Invoke ${profile.makeItSo.invocation}.` }),
      profileCapability("task-list", profile.taskList, registration.packageName),
      profileCapability("subagents", profile.subagents, registration.packageName),
      profileCapability("local-review", profile.review.local, registration.packageName),
      profileCapability("isolated-review", profile.review.isolated, registration.packageName),
      profileCapability("umpire-continuation", profile.umpire.continuation, registration.packageName),
      profileCapability("live-models", profile.modelDiscovery, registration.packageName),
      Object.freeze({
        id: "trust-actions",
        support: "supported",
        owner: registration.packageName,
        summary: profile.trust.required ? `${profile.trust.description} ${trustActions}`.trim() : profile.trust.description,
      }),
    ]),
    connection: null,
    declaredProfile,
  });
}

export function componentsWithHostReadiness(observedAt = new Date().toISOString()): readonly QubeComponent[] {
  return Object.freeze(qubeComponents.map((component) => component.id !== "executor"
    ? component
    : Object.freeze({
      ...component,
      capabilities: Object.freeze({
        ...component.capabilities,
        hostSurfaces: Object.freeze(executorHostSurfaces.map((surface) => Object.freeze({
          ...surface,
          readiness: observeAgentHostReadiness(surface.declaredProfile!, observedAt),
        }))),
      }),
    })));
}

export const executorHostSurfaces: readonly QubeDiscoveryOption[] = Object.freeze(
  AGENT_HOST_IDS.map(id => agentHostOption(getAgentHostProfileSync(id))),
);

export const executorWorkProviders: readonly QubeDiscoveryOption[] = Object.freeze([
  adapterOption(githubAdapterContract, "installed", "GitHub issues, pull requests, checks, merge blockers, and review threads use the GitHub adapter contract.", true),
  adapterOption(gitLabAdapterContract, "optional", "GitLab issue queues and issue draft rendering use the GitLab adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(linearAdapterContract, "optional", "Linear issue queues and issue draft rendering use the Linear adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(jiraAdapterContract, "optional", "Jira issue queues, workflow schema mapping, and issue draft rendering use the Jira adapter contract while lifecycle mutations remain unsupported."),
]);

export const executorCiProviders: readonly QubeDiscoveryOption[] = Object.freeze([
  adapterOption(githubAdapterContract, "installed", "GitHub status checks, check runs, merge blockers, and review conversations use the GitHub adapter contract.", true),
  adapterOption(gitLabAdapterContract, "optional", "GitLab merge request pipelines use the GitLab adapter contract without triggering or rerunning pipelines."),
  adapterOption(jenkinsAdapterContract, "optional", "Jenkins classic and folder job build state uses the Jenkins adapter contract without triggering or rerunning jobs."),
]);

export const qubeComponents: readonly QubeComponent[] = Object.freeze([
  {
    id: "bootstrap",
    command: "aib",
    packageName: "@tjalve/aib",
    packageVersion: dependencyVersion("@tjalve/aib"),
    summary: "Plan projects, specs, milestones, and work-item drafts.",
    initCapability: {
      participatesByDefault: true,
      scopes: ["repository"],
      command: ["init"],
      supportsToolSelection: false,
      alreadyInitializedHint: "aib init reports its own file actions (create/update/skip) for the planning state directory."
    }
  },
  {
    id: "executor",
    command: "aie",
    packageName: "@tjalve/aie",
    packageVersion: dependencyVersion("@tjalve/aie"),
    summary: "Execute GitHub issue work through queue, branch, PR, and completion gates.",
    initCapability: {
      participatesByDefault: true,
      scopes: ["repository"],
      command: ["init"],
      supportsToolSelection: true,
      alreadyInitializedHint: "aie init reports create/update/skip per managed file and config field."
    },
    capabilities: {
      localReview: {
        freshContextReviewerSupport: "host-provided",
        manualEvidenceSatisfiesRequiredGate: false,
        provenanceRequired: ["runnerKind", "host", "freshContext", "promptOnly", "promptStackHash", "headSha", "providerPublishStatus"],
        provenanceAlternatives: [
          {
            anyOf: ["taskId", "sessionId", "threadId"],
            description: "At least one separate host task, session, or thread identifier is required when the host exposes one."
          }
        ],
        evidencePathPattern: ".qube/aie/reviews/<issue>/<pr>/<head>/<lane>.json",
        hostProvenancePathPattern: ".git/qube/aie/host-provenance/<issue>/<pr>/<head>/<lane>.json",
        nextAction: "Use qube aie pr gate <pr> --dry-run --json --local-review-prompts to render explicit lane bundles. The selected agent harness must spawn an independent review subagent and record matching local-host provenance before a required gate can pass."
      },
      hostSurfaces: executorHostSurfaces,
      workProviders: executorWorkProviders,
      ciProviders: executorCiProviders
    }
  },
  {
    id: "quality",
    command: "aiq",
    packageName: "@tjalve/aiq",
    packageVersion: dependencyVersion("@tjalve/aiq"),
    summary: "Run staged quality gates and produce agent-readable evidence.",
    initCapability: {
      participatesByDefault: true,
      scopes: ["repository"],
      command: ["config"],
      supportsToolSelection: false,
      alreadyInitializedHint: "aiq config reports create, update, skip, or conflict for Quality configuration and progress state."
    }
  },
  {
    id: "umpire",
    command: "aiu",
    packageName: "@tjalve/aiu",
    packageVersion: dependencyVersion("@tjalve/aiu"),
    summary: "Guard agent continuation, host policy, and safe idle-work decisions.",
    initCapability: {
      participatesByDefault: true,
      scopes: ["repository"],
      command: ["init"],
      supportsToolSelection: true,
      alreadyInitializedHint: "aiu init reports create/update/skip per managed host file and continuation config."
    }
  }
]);

export function findQubeComponent(value: string): QubeComponent | undefined {
  const normalized = value.trim().toLowerCase();
  return qubeComponents.find(component => component.id === normalized || component.command === normalized || component.packageName === normalized);
}
