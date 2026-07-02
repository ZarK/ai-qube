import {
  codexAdapterContract,
  gitLabAdapterContract,
  githubAdapterContract,
  jenkinsAdapterContract,
  jiraAdapterContract,
  linearAdapterContract,
  opencodeAdapterContract,
  type QubeAdapterCapability,
  type QubeAdapterContract,
  type QubeIntegrationSurface,
} from "@tjalve/qube-core";

import { listClaudeCodeHostCapabilities } from "./claude_code_host.js";
import { listGrokBuildHostCapabilities } from "./grok_build_host.js";

export type QubeOptionSupport = "installed" | "optional" | "unsupported";
export type QubeDiscoveryCapabilitySupport = QubeAdapterCapability["support"] | "host-provided";

export interface QubeDiscoveryOption {
  readonly id: string;
  readonly support: QubeOptionSupport;
  readonly packageName: string | null;
  readonly surface: QubeIntegrationSurface | "local";
  readonly source: "adapter-contract" | "host-contract" | "local-option";
  readonly default: boolean;
  readonly summary: string;
  readonly capabilities: readonly QubeDiscoveryCapability[];
}

export interface QubeDiscoveryCapability {
  readonly id: string;
  readonly support: QubeDiscoveryCapabilitySupport;
  readonly owner: string;
  readonly summary: string;
}

export interface QubeComponent {
  readonly id: string;
  readonly command: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly summary: string;
  readonly capabilities?: {
    readonly localReview?: {
      readonly freshContextReviewerSupport: "host-provided" | "configured-command" | "prompt-only" | "unsupported";
      readonly promptOnlyFallback: boolean;
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
  });
}

function hostOption(input: {
  readonly id: string;
  readonly support: QubeOptionSupport;
  readonly surface: QubeIntegrationSurface | "local";
  readonly packageName: string | null;
  readonly summary: string;
  readonly default?: boolean;
  readonly capabilities: readonly { readonly id: string; readonly support: QubeDiscoveryCapabilitySupport | string; readonly owner: string; readonly summary: string }[];
}): QubeDiscoveryOption {
  return Object.freeze({
    id: input.id,
    support: input.support,
    packageName: input.packageName,
    surface: input.surface,
    source: input.surface === "local" ? "local-option" : "host-contract",
    default: input.default ?? false,
    summary: input.summary,
    capabilities: Object.freeze(input.capabilities.map(capability => Object.freeze({
      id: capability.id,
      support: normalizeCapabilitySupport(capability.support),
      owner: capability.owner,
      summary: capability.summary,
    }))),
  });
}

function normalizeCapabilitySupport(support: string): QubeDiscoveryCapabilitySupport {
  if (support === "unsupported" || support === "standalone" || support === "host-provided") return support;
  return "supported";
}

export const executorHostSurfaces: readonly QubeDiscoveryOption[] = Object.freeze([
  hostOption({
    id: "generic",
    support: "installed",
    surface: "local",
    packageName: null,
    default: true,
    summary: "Generic terminal setup makes no host-specific automation or file-layout assumptions.",
    capabilities: [],
  }),
  adapterOption(codexAdapterContract, "installed", "Codex host capability reporting uses the Codex adapter contract and AGENTS.md host profile."),
  hostOption({
    id: "claude-code",
    support: "installed",
    surface: "claude-code",
    packageName: "@tjalve/qube",
    summary: "Claude Code host capability reporting uses the QUBE Claude Code host contract.",
    capabilities: listClaudeCodeHostCapabilities(),
  }),
  hostOption({
    id: "grok-build",
    support: "installed",
    surface: "grok-build",
    packageName: "@tjalve/qube",
    summary: "Grok Build terminal CLI/TUI capability reporting uses the QUBE Grok Build host contract without installing or invoking Grok Build.",
    capabilities: listGrokBuildHostCapabilities(),
  }),
  adapterOption(opencodeAdapterContract, "optional", "OpenCode host capability reporting uses the OpenCode adapter contract and remains explicit about unsupported PR and branch mutations."),
]);

export const executorWorkProviders: readonly QubeDiscoveryOption[] = Object.freeze([
  adapterOption(githubAdapterContract, "installed", "GitHub issues, pull requests, checks, merge blockers, and review threads use the GitHub adapter contract.", true),
  adapterOption(gitLabAdapterContract, "optional", "GitLab issue queues and issue draft rendering use the GitLab adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(linearAdapterContract, "optional", "Linear issue queues and issue draft rendering use the Linear adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(jiraAdapterContract, "optional", "Jira issue queues, workflow schema mapping, and issue draft rendering use the Jira adapter contract while lifecycle mutations remain unsupported."),
  hostOption({
    id: "local",
    support: "unsupported",
    surface: "local",
    packageName: null,
    summary: "Local-only setup does not provide forge-backed work queues, pull request review, or provider mutations.",
    capabilities: [
      {
        id: "work-item-queue",
        support: "unsupported",
        owner: "@tjalve/qube",
        summary: "No provider-backed work queue is configured for local-only setup.",
      },
    ],
  }),
]);

export const executorCiProviders: readonly QubeDiscoveryOption[] = Object.freeze([
  adapterOption(githubAdapterContract, "installed", "GitHub status checks, check runs, merge blockers, and review conversations use the GitHub adapter contract.", true),
  adapterOption(jenkinsAdapterContract, "optional", "Jenkins classic and folder job build state uses the Jenkins adapter contract without triggering or rerunning jobs."),
  hostOption({
    id: "local",
    support: "unsupported",
    surface: "local",
    packageName: null,
    summary: "Local-only setup does not configure provider-backed CI evidence.",
    capabilities: [
      {
        id: "read-ci-status",
        support: "unsupported",
        owner: "@tjalve/qube",
        summary: "No provider-backed CI status reader is configured for local-only setup.",
      },
    ],
  }),
]);

export const qubeComponents: readonly QubeComponent[] = Object.freeze([
  {
    id: "bootstrap",
    command: "aib",
    packageName: "@tjalve/aib",
    packageVersion: "0.1.1",
    summary: "Plan projects, specs, milestones, and work-item drafts."
  },
  {
    id: "executor",
    command: "aie",
    packageName: "@tjalve/aie",
    packageVersion: "0.1.4",
    summary: "Execute GitHub issue work through queue, branch, PR, and completion gates.",
    capabilities: {
      localReview: {
        freshContextReviewerSupport: "host-provided",
        promptOnlyFallback: true,
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
        nextAction: "Use qube aie pr gate <pr> --dry-run --json --local-review-prompts to render explicit lane bundles. The active Codex host must spawn independent subagents and record matching local-host provenance before required gates can pass."
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
    packageVersion: "0.2.2",
    summary: "Run staged quality gates and produce agent-readable evidence."
  },
  {
    id: "umpire",
    command: "aiu",
    packageName: "@tjalve/aiu",
    packageVersion: "0.0.4",
    summary: "Guard agent continuation, host policy, and safe idle-work decisions."
  }
]);

export function findQubeComponent(value: string): QubeComponent | undefined {
  const normalized = value.trim().toLowerCase();
  return qubeComponents.find(component => component.id === normalized || component.command === normalized || component.packageName === normalized);
}
