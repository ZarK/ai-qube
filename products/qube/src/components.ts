import { listClaudeCodeHostCapabilities } from "./claude_code_host.js";
import { listGrokBuildHostCapabilities } from "./grok_build_host.js";

export type QubeIntegrationSurface = "cli" | "github" | "gitlab" | "linear" | "jira" | "jenkins" | "codex" | "opencode" | "claude-code" | "grok-build";
export type QubeOptionSupport = "installed" | "optional" | "unsupported";

export interface QubeAdapterCapability {
  readonly id: string;
  readonly support: "supported" | "standalone" | "unsupported";
  readonly owner: string;
  readonly summary: string;
}

interface QubeAdapterContract {
  readonly id: "github" | "gitlab" | "linear" | "jira" | "jenkins" | "codex" | "opencode" | "claude-code" | "grok-build";
  readonly packageName: string;
  readonly surface: QubeIntegrationSurface;
  readonly capabilities?: readonly QubeAdapterCapability[];
}

export interface QubeDiscoveryOption {
  readonly id: string;
  readonly support: QubeOptionSupport;
  readonly packageName: string | null;
  readonly surface: QubeIntegrationSurface | "local";
  readonly source: "adapter-contract" | "host-contract" | "local-option";
  readonly default: boolean;
  readonly summary: string;
  readonly capabilities: readonly QubeAdapterCapability[];
}

function capability(id: string, support: QubeAdapterCapability["support"], owner: string, summary: string): QubeAdapterCapability {
  return Object.freeze({ id, support, owner, summary });
}

const githubAdapter: QubeAdapterContract = Object.freeze({
  id: "github",
  packageName: "@tjalve/qube-adapter-github",
  surface: "github",
  capabilities: Object.freeze([
    capability("map-work-item", "supported", "@tjalve/aie", "Map GitHub issues into provider-neutral Executor work-item keys, labels, blockers, checklist state, and metadata."),
    capability("work-item-queue", "supported", "@tjalve/aie", "Read GitHub issue queues through Executor work-provider rules."),
    capability("sync-issue-status", "supported", "@tjalve/aie", "Synchronize GitHub status labels with Executor work lifecycle state."),
    capability("render-work-items", "supported", "@tjalve/aib", "Render provider-neutral work-item drafts into GitHub issue text without mutating GitHub."),
    capability("load-pull-request", "supported", "@tjalve/qube-adapter-github", "Read pull request review, mergeability, linked issue, and check state through the GitHub review-forge adapter."),
    capability("request-review-gate", "supported", "@tjalve/qube-adapter-github", "Request configured GitHub review agents and record trusted review-gate markers for the current PR head."),
    capability("read-merge-blockers", "supported", "@tjalve/qube-adapter-github", "Read GitHub mergeability, merge-state status, provider merge UI reasons, branch protection blockers, unresolved conversation blockers, and check blockers."),
    capability("read-ci-status", "supported", "@tjalve/qube-adapter-github", "Normalize GitHub status checks and check runs into trusted provider gate evidence."),
    capability("diagnose-ci-status", "supported", "@tjalve/qube-adapter-github", "Report whether PR checks map to the current head, stale workflow runs, failed runs, skipped runs, or pending runs."),
    capability("read-review-threads", "supported", "@tjalve/qube-adapter-github", "Read unresolved GitHub pull request review threads, anchors, ids, and resolve capability as untrusted feedback inputs."),
    capability("resolve-review-threads", "supported", "@tjalve/qube-adapter-github", "Resolve addressed GitHub pull request review threads through the provider GraphQL mutation."),
    capability("run-aiq-github-action", "standalone", "@tjalve/aiq GitHub Action package", "AIQ exposes GitHub behavior through its standalone action package, not through the QUBE GitHub provider adapter."),
    capability("trigger-workflow-run", "unsupported", "@tjalve/aie", "The GitHub adapter reports CI diagnostics but does not trigger workflow runs yet."),
    capability("approve-pull-request", "unsupported", "GitHub review provider", "Adapter support never fabricates pull request approval."),
    capability("mutate-repository-files", "unsupported", "@tjalve/aie repository provider", "GitHub provider support does not edit local repository files."),
    capability("publish-release", "unsupported", "repository release workflow", "GitHub release publishing is outside the current QUBE GitHub adapter contract."),
  ]),
});

const gitLabAdapter: QubeAdapterContract = Object.freeze({
  id: "gitlab",
  packageName: "@tjalve/qube-adapter-gitlab",
  surface: "gitlab",
  capabilities: Object.freeze([
    capability("map-work-item", "supported", "@tjalve/qube-adapter-gitlab", "Map GitLab issues, labels, milestones, assignees, task completion, issue links, blockers, and source metadata into QUBE work items."),
    capability("work-item-queue", "supported", "@tjalve/qube-adapter-gitlab", "Read paginated GitLab project issues through GitLab.com or self-managed GitLab REST APIs and normalize reverse blocker links for queue ordering."),
    capability("render-work-items", "supported", "@tjalve/qube-adapter-gitlab", "Render provider-neutral AIB work item drafts into GitLab issue previews without mutating GitLab."),
    capability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-gitlab", "GitLab lifecycle, merge request, approval, and CI pipeline mutations require explicit mutation adapters and are reported as unsupported."),
  ]),
});

const linearAdapter: QubeAdapterContract = Object.freeze({
  id: "linear",
  packageName: "@tjalve/qube-adapter-linear",
  surface: "linear",
  capabilities: Object.freeze([
    capability("map-work-item", "supported", "@tjalve/qube-adapter-linear", "Map Linear issues, workflow state, relations, labels, project metadata, assignee, checklist state, and source metadata into QUBE work items."),
    capability("work-item-queue", "supported", "@tjalve/qube-adapter-linear", "Read Linear team issues through the Linear GraphQL API and normalize reverse blocker links for queue ordering."),
    capability("render-work-items", "supported", "@tjalve/qube-adapter-linear", "Render provider-neutral AIB work item drafts into Linear issue previews without mutating Linear."),
    capability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-linear", "Linear lifecycle mutations require explicit team workflow-state configuration and are reported as unsupported."),
  ]),
});

const jiraAdapter: QubeAdapterContract = Object.freeze({
  id: "jira",
  packageName: "@tjalve/qube-adapter-jira",
  surface: "jira",
  capabilities: Object.freeze([
    capability("map-work-item", "supported", "@tjalve/qube-adapter-jira", "Map Jira issues, issue types, projects, statuses, priorities, labels/components, assignees, sprints, epics, comments, issue links, and source metadata into QUBE work items."),
    capability("work-item-queue", "supported", "@tjalve/qube-adapter-jira", "Read Jira issues through Jira REST using configured JQL and normalize reverse blocker links for queue ordering."),
    capability("workflow-schema", "supported", "@tjalve/qube-adapter-jira", "Keep status, priority, completion, sprint, epic, and dependency mapping schema-driven for custom Jira workflows and fields."),
    capability("render-work-items", "supported", "@tjalve/qube-adapter-jira", "Render provider-neutral AIB work item drafts into Jira issue previews without mutating Jira."),
    capability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-jira", "Jira lifecycle mutations require explicit workflow transition IDs and are reported as unsupported."),
  ]),
});

const jenkinsAdapter: QubeAdapterContract = Object.freeze({
  id: "jenkins",
  packageName: "@tjalve/qube-adapter-jenkins",
  surface: "jenkins",
  capabilities: Object.freeze([
    capability("read-ci-status", "supported", "@tjalve/qube-adapter-jenkins", "Read Jenkins classic job and folder job build state and normalize it into QUBE gate evidence."),
    capability("diagnose-ci-status", "supported", "@tjalve/qube-adapter-jenkins", "Report missing Jenkins configuration, missing credentials, inaccessible jobs, queued builds, unstable builds, and unknown build state explicitly."),
    capability("read-ci-artifacts", "supported", "@tjalve/qube-adapter-jenkins", "Attach Jenkins build URL, console log URL, build id, timestamp, and artifact URLs to provider gate evidence metadata when Jenkins exposes them."),
    capability("trigger-ci-run", "unsupported", "@tjalve/qube-adapter-jenkins", "Jenkins build trigger and rerun mutations are not supported until a separate mutation capability is designed and tested."),
  ]),
});

const codexAdapter: QubeAdapterContract = Object.freeze({
  id: "codex",
  packageName: "@tjalve/qube-adapter-codex",
  surface: "codex",
  capabilities: Object.freeze([
    capability("detect-host", "supported", "@tjalve/qube-adapter-codex", "Detect Codex repository affordances from AGENTS.md and .codex/agents."),
    capability("probe-local-review-runner", "supported", "@tjalve/aie", "Probe whether Codex can run independent fresh-context local review lanes."),
    capability("spawn-review-subagent", "supported", "Codex host", "Codex can spawn independent qube-review-focus subagents from rendered lane spawnPrompt."),
    capability("install-review-focus-agent", "unsupported", "@tjalve/aie", "Codex review-focus agent installation is owned by Executor init, not the adapter runtime."),
  ]),
});

const opencodeAdapter: QubeAdapterContract = Object.freeze({
  id: "opencode",
  packageName: "@tjalve/qube-adapter-opencode",
  surface: "opencode",
  capabilities: Object.freeze([
    capability("detect-host", "supported", "@tjalve/qube-adapter-opencode", "Detect OpenCode repository affordances from AGENTS.md and .opencode/commands."),
    capability("read-instructions", "supported", "@tjalve/aib and @tjalve/aie", "OpenCode reads AGENTS.md as the repository instruction target for QUBE workflows."),
    capability("install-project-command", "supported", "@tjalve/aib and @tjalve/aie", "AIB and AIE install concrete OpenCode project commands under .opencode/commands."),
    capability("use-todos", "supported", "OpenCode host", "OpenCode todo state is available through host todo tools, not through a hidden adapter store."),
    capability("deliver-session-prompt", "supported", "@tjalve/aiu", "AIU can route continuation prompts from trusted state through an explicit OpenCode prompt deliverer."),
    capability("handle-stop-hook", "supported", "@tjalve/aiu", "AIU owns OpenCode stop-hook and idle-session continuation decisions."),
    capability("run-aiq-plugin", "standalone", "@tjalve/aiq OpenCode plugin package", "AIQ exposes OpenCode quality tools as a standalone adapter package, not as a QUBE-facing host command."),
    capability("request-external-review", "unsupported", "OpenCode host", "OpenCode does not provide a QUBE API for requesting external reviewers."),
    capability("create-git-branch", "unsupported", "@tjalve/aie", "OpenCode host support does not create repository branches."),
    capability("open-pull-request", "unsupported", "@tjalve/aie GitHub provider", "OpenCode host support does not open or approve pull requests."),
  ]),
});

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
  readonly capabilities: readonly { readonly id: string; readonly support: string; readonly owner: string; readonly summary: string }[];
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
      support: capability.support === "unsupported" ? "unsupported" : "supported",
      owner: capability.owner,
      summary: capability.summary,
    }))),
  });
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
  adapterOption(codexAdapter, "installed", "Codex host capability reporting uses the Codex adapter contract and AGENTS.md host profile."),
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
  adapterOption(opencodeAdapter, "optional", "OpenCode host capability reporting uses the OpenCode adapter contract and remains explicit about unsupported PR and branch mutations."),
]);

export const executorWorkProviders: readonly QubeDiscoveryOption[] = Object.freeze([
  adapterOption(githubAdapter, "installed", "GitHub issues, pull requests, checks, merge blockers, and review threads use the GitHub adapter contract.", true),
  adapterOption(gitLabAdapter, "optional", "GitLab issue queues and issue draft rendering use the GitLab adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(linearAdapter, "optional", "Linear issue queues and issue draft rendering use the Linear adapter contract while lifecycle mutations remain unsupported."),
  adapterOption(jiraAdapter, "optional", "Jira issue queues, workflow schema mapping, and issue draft rendering use the Jira adapter contract while lifecycle mutations remain unsupported."),
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
  adapterOption(githubAdapter, "installed", "GitHub status checks, check runs, merge blockers, and review conversations use the GitHub adapter contract.", true),
  adapterOption(jenkinsAdapter, "optional", "Jenkins classic and folder job build state uses the Jenkins adapter contract without triggering or rerunning jobs."),
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
