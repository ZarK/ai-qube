import type { JsonObject } from "./json_value.js";

export type { JsonObject, JsonValue } from "./json_value.js";
export type {
  EvidenceSource,
  EvidenceTrust,
  GateDefinition,
  GateEvidence,
  GateEvidenceReasonCode,
  GateResult,
  GateStage,
} from "./gate_evidence.js";
export { isVerifiedGateEvidence, normalizeGateEvidence } from "./gate_evidence.js";
export type {
  FeedbackTrust,
  Mergeability,
  ResolveReviewThreadInput,
  ResolveReviewThreadResult,
  ReviewConversation,
  ReviewDecision,
  ReviewFeedback,
  ReviewFeedbackSource,
  ReviewItem,
  ReviewItemKey,
  ReviewMergeBlock,
  ReviewMergeBlockReason,
  ReviewState,
} from "./review_item.js";
export { normalizeReviewFeedback, normalizeReviewItem, normalizeReviewItemKey } from "./review_item.js";
export type {
  ReviewAgentAdapter,
  ReviewAgentCommentBody,
  ReviewForgeAdapterKind,
  ReviewForgeCapabilities,
  ReviewForgePlanOptions,
  ReviewForgePolicy,
  ReviewForgeProvider,
  ReviewForgeSnapshot,
  ReviewRequestTrigger,
} from "./review_forge.js";

export type QubeProductId = "bootstrap" | "executor" | "quality" | "umpire";

export type QubeIntegrationSurface = "cli" | "github" | "gitlab" | "linear" | "jira" | "jenkins" | "codex" | "opencode" | "claude-code" | "grok-build";
export type QubeCommandClassification =
  | "qube-facing workflow command"
  | "standalone package command"
  | "internal adapter command"
  | "compatibility command";
export type QubePathClassification =
  | "shared QUBE namespace"
  | "standalone product config"
  | "standalone product state"
  | "generated host integration"
  | "implementation-time workflow policy"
  | "test fixture or sample";

export interface QubeProductContract {
  readonly id: QubeProductId;
  readonly packageName: string;
  readonly commandName: string;
  readonly role: string;
  readonly standalone: true;
  readonly surfaces: readonly QubeIntegrationSurface[];
}

export interface QubeAdapterContract {
  readonly id: "github" | "gitlab" | "linear" | "jira" | "jenkins" | "codex" | "opencode" | "claude-code" | "grok-build";
  readonly packageName: string;
  readonly surface: QubeIntegrationSurface;
  readonly owns: readonly string[];
  readonly boundary: string;
  readonly capabilities?: readonly QubeAdapterCapability[];
  readonly contractOnly: boolean;
}

export interface QubeAdapterCapability {
  readonly id: string;
  readonly support: "supported" | "standalone" | "unsupported";
  readonly owner: string;
  readonly summary: string;
}

function adapterCapability(
  id: string,
  support: QubeAdapterCapability["support"],
  owner: string,
  summary: string,
): QubeAdapterCapability {
  return Object.freeze({ id, support, owner, summary });
}

export const githubAdapterContract = defineQubeAdapter({
  id: "github",
  packageName: "@tjalve/qube-adapter-github",
  surface: "github",
  owns: [
    "issue-work-items",
    "work-queues",
    "pull-requests",
    "ci-status",
    "review-forge-implementation",
    "review-agent-templates",
    "review-gates",
    "review-threads",
    "unsupported-capability-reporting",
  ],
  boundary: "GitHub-specific state stays at the adapter edge; product packages consume explicit capability records and keep package-owned side effects.",
  capabilities: Object.freeze([
    adapterCapability("map-work-item", "supported", "@tjalve/qube-adapter-github", "Map GitHub issues into provider-neutral Executor work-item keys, labels, blockers, checklist state, and metadata."),
    adapterCapability("work-item-queue", "supported", "@tjalve/qube-adapter-github", "Read GitHub issue queues through Executor work-provider rules."),
    adapterCapability("sync-issue-status", "supported", "@tjalve/qube-adapter-github", "Synchronize GitHub status labels with Executor work lifecycle state."),
    adapterCapability("render-work-items", "supported", "@tjalve/aib", "Render provider-neutral work-item drafts into GitHub issue text without mutating GitHub."),
    adapterCapability("load-pull-request", "supported", "@tjalve/qube-adapter-github", "Read pull request review, mergeability, linked issue, and check state through the GitHub review-forge adapter."),
    adapterCapability("request-review-gate", "supported", "@tjalve/qube-adapter-github", "Request configured GitHub review agents and record trusted review-gate markers for the current PR head."),
    adapterCapability("read-merge-blockers", "supported", "@tjalve/qube-adapter-github", "Read GitHub mergeability, merge-state status, provider merge UI reasons, branch protection blockers, unresolved conversation blockers, and check blockers."),
    adapterCapability("read-ci-status", "supported", "@tjalve/qube-adapter-github", "Normalize GitHub status checks and check runs into trusted provider gate evidence."),
    adapterCapability("diagnose-ci-status", "supported", "@tjalve/qube-adapter-github", "Report whether PR checks map to the current head, stale workflow runs, failed runs, skipped runs, or pending runs."),
    adapterCapability("read-review-threads", "supported", "@tjalve/qube-adapter-github", "Read unresolved GitHub pull request review threads, anchors, ids, and resolve capability as untrusted feedback inputs."),
    adapterCapability("resolve-review-threads", "supported", "@tjalve/qube-adapter-github", "Resolve addressed GitHub pull request review threads through the provider GraphQL mutation."),
    adapterCapability("run-aiq-github-action", "standalone", "@tjalve/aiq GitHub Action package", "AIQ exposes GitHub behavior through its standalone action package, not through the QUBE GitHub provider adapter."),
    adapterCapability("trigger-workflow-run", "unsupported", "@tjalve/aie", "The GitHub adapter reports CI diagnostics but does not trigger workflow runs yet."),
    adapterCapability("approve-pull-request", "unsupported", "GitHub review provider", "Adapter support never fabricates pull request approval."),
    adapterCapability("mutate-repository-files", "unsupported", "@tjalve/aie repository provider", "GitHub provider support does not edit local repository files."),
    adapterCapability("publish-release", "unsupported", "repository release workflow", "GitHub release publishing is outside the current QUBE GitHub adapter contract."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const gitLabAdapterContract = defineQubeAdapter({
  id: "gitlab",
  packageName: "@tjalve/qube-adapter-gitlab",
  surface: "gitlab",
  owns: [
    "gitlab-rest-client",
    "gitlab-work-item-mapping",
    "gitlab-draft-rendering",
    "self-managed-url-handling",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "GitLab API access, issue mapping, draft rendering, capability flags, credential diagnostics, self-managed URL handling, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: Object.freeze([
    adapterCapability("map-work-item", "supported", "@tjalve/qube-adapter-gitlab", "Map GitLab issues, labels, milestones, assignees, task completion, issue links, blockers, and source metadata into QUBE work items."),
    adapterCapability("work-item-queue", "supported", "@tjalve/qube-adapter-gitlab", "Read paginated GitLab project issues through GitLab.com or self-managed GitLab REST APIs and normalize reverse blocker links for queue ordering."),
    adapterCapability("render-work-items", "supported", "@tjalve/qube-adapter-gitlab", "Render provider-neutral AIB work item drafts into GitLab issue previews without mutating GitLab."),
    adapterCapability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-gitlab", "GitLab lifecycle, merge request, approval, and CI pipeline mutations require explicit mutation adapters and are reported as unsupported."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const linearAdapterContract = defineQubeAdapter({
  id: "linear",
  packageName: "@tjalve/qube-adapter-linear",
  surface: "linear",
  owns: [
    "linear-graphql-client",
    "linear-work-item-mapping",
    "linear-draft-rendering",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "Linear API access, issue mapping, draft rendering, capability flags, credential diagnostics, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: Object.freeze([
    adapterCapability("map-work-item", "supported", "@tjalve/qube-adapter-linear", "Map Linear issues, workflow state, relations, labels, project metadata, assignee, checklist state, and source metadata into QUBE work items."),
    adapterCapability("work-item-queue", "supported", "@tjalve/qube-adapter-linear", "Read Linear team issues through the Linear GraphQL API and normalize reverse blocker links for queue ordering."),
    adapterCapability("render-work-items", "supported", "@tjalve/qube-adapter-linear", "Render provider-neutral AIB work item drafts into Linear issue previews without mutating Linear."),
    adapterCapability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-linear", "Linear lifecycle mutations require explicit team workflow-state configuration and are reported as unsupported."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const jiraAdapterContract = defineQubeAdapter({
  id: "jira",
  packageName: "@tjalve/qube-adapter-jira",
  surface: "jira",
  owns: [
    "jira-rest-client",
    "jira-work-item-mapping",
    "jira-workflow-schema-mapping",
    "jira-draft-rendering",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "Jira API access, issue mapping, workflow schema mapping, draft rendering, capability flags, credential diagnostics, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: Object.freeze([
    adapterCapability("map-work-item", "supported", "@tjalve/qube-adapter-jira", "Map Jira issues, issue types, projects, statuses, priorities, labels/components, assignees, sprints, epics, comments, issue links, and source metadata into QUBE work items."),
    adapterCapability("work-item-queue", "supported", "@tjalve/qube-adapter-jira", "Read Jira issues through Jira REST using configured JQL and normalize reverse blocker links for queue ordering."),
    adapterCapability("workflow-schema", "supported", "@tjalve/qube-adapter-jira", "Keep status, priority, completion, sprint, epic, and dependency mapping schema-driven for custom Jira workflows and fields."),
    adapterCapability("render-work-items", "supported", "@tjalve/qube-adapter-jira", "Render provider-neutral AIB work item drafts into Jira issue previews without mutating Jira."),
    adapterCapability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-jira", "Jira lifecycle mutations require explicit workflow transition IDs and are reported as unsupported."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const jenkinsAdapterContract = defineQubeAdapter({
  id: "jenkins",
  packageName: "@tjalve/qube-adapter-jenkins",
  surface: "jenkins",
  owns: [
    "jenkins-rest-client",
    "jenkins-build-evidence",
    "jenkins-folder-job-paths",
    "jenkins-artifact-and-log-pointers",
    "unsupported-ci-mutation-reporting",
    "credential-diagnostics",
  ],
  boundary: "Jenkins API access, job/build state mapping, artifact and log pointers, credential diagnostics, and unsupported CI mutation reporting live in this optional adapter package.",
  capabilities: Object.freeze([
    adapterCapability("read-ci-status", "supported", "@tjalve/qube-adapter-jenkins", "Read Jenkins classic job and folder job build state and normalize it into QUBE gate evidence."),
    adapterCapability("diagnose-ci-status", "supported", "@tjalve/qube-adapter-jenkins", "Report missing Jenkins configuration, missing credentials, inaccessible jobs, queued builds, unstable builds, and unknown build state explicitly."),
    adapterCapability("read-ci-artifacts", "supported", "@tjalve/qube-adapter-jenkins", "Attach Jenkins build URL, console log URL, build id, timestamp, and artifact URLs to provider gate evidence metadata when Jenkins exposes them."),
    adapterCapability("trigger-ci-run", "unsupported", "@tjalve/qube-adapter-jenkins", "Jenkins build trigger and rerun mutations are not supported until a separate mutation capability is designed and tested."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const codexAdapterContract = defineQubeAdapter({
  id: "codex",
  packageName: "@tjalve/qube-adapter-codex",
  surface: "codex",
  owns: ["host-detection", "instruction-targets", "review-subagents", "local-review-probes", "unsupported-capability-reporting"],
  boundary: "Codex host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: Object.freeze([
    adapterCapability("detect-host", "supported", "@tjalve/qube-adapter-codex", "Detect Codex repository affordances from AGENTS.md and .codex/agents."),
    adapterCapability("probe-local-review-runner", "supported", "@tjalve/aie", "Probe whether Codex can run independent fresh-context local review lanes."),
    adapterCapability("spawn-review-subagent", "supported", "Codex host", "Codex can spawn independent qube-review-focus subagents from rendered lane spawnPrompt."),
    adapterCapability("install-review-focus-agent", "unsupported", "@tjalve/aie", "Codex review-focus agent installation is owned by Executor init, not the adapter runtime."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const opencodeAdapterContract = defineQubeAdapter({
  id: "opencode",
  packageName: "@tjalve/qube-adapter-opencode",
  surface: "opencode",
  owns: ["host-detection", "instruction-targets", "project-commands", "todo-tools", "session-prompts", "stop-hooks", "unsupported-capability-reporting"],
  boundary: "OpenCode host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: Object.freeze([
    adapterCapability("detect-host", "supported", "@tjalve/qube-adapter-opencode", "Detect OpenCode repository affordances from AGENTS.md and .opencode/commands."),
    adapterCapability("read-instructions", "supported", "@tjalve/aib and @tjalve/aie", "OpenCode reads AGENTS.md as the repository instruction target for QUBE workflows."),
    adapterCapability("install-project-command", "supported", "@tjalve/aib and @tjalve/aie", "AIB and AIE install concrete OpenCode project commands under .opencode/commands."),
    adapterCapability("use-todos", "supported", "OpenCode host", "OpenCode todo state is available through host todo tools, not through a hidden adapter store."),
    adapterCapability("deliver-session-prompt", "supported", "@tjalve/aiu", "AIU can route continuation prompts from trusted state through an explicit OpenCode prompt deliverer."),
    adapterCapability("handle-stop-hook", "supported", "@tjalve/aiu", "AIU owns OpenCode stop-hook and idle-session continuation decisions."),
    adapterCapability("run-aiq-plugin", "standalone", "@tjalve/aiq OpenCode plugin package", "AIQ exposes OpenCode quality tools as a standalone adapter package, not as a QUBE-facing host command."),
    adapterCapability("request-external-review", "unsupported", "OpenCode host", "OpenCode does not provide a QUBE API for requesting external reviewers."),
    adapterCapability("create-git-branch", "unsupported", "@tjalve/aie", "OpenCode host support does not create repository branches."),
    adapterCapability("open-pull-request", "unsupported", "@tjalve/aie GitHub provider", "OpenCode host support does not open or approve pull requests."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export interface QubeCommandSurfaceContract {
  readonly productId: QubeProductId;
  readonly packageName: string;
  readonly commandPattern: string;
  readonly classification: QubeCommandClassification;
  readonly qubeFacing: boolean;
  readonly schemaRequired: boolean;
  readonly notes: string;
}

export type ProviderResourceKind = "work-item" | "review-item" | "repository" | "gate-evidence" | "policy" | "action-plan";

export interface ProviderSource {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId: string | null;
  readonly url: string | null;
  readonly metadata: JsonObject;
}

export type WorkItemState = "open" | "closed";
export type WorkStatus = "in-progress" | "ready" | "blocked" | "unknown";
export type WorkPriority = "critical" | "high" | "medium" | "low" | "none";

export interface WorkItemKey {
  readonly providerId: string;
  readonly id: string;
}

export interface WorkProject {
  readonly id: string;
  readonly title: string;
  readonly state: "open" | "closed" | "unknown";
  readonly dueOn: string | null;
}

export interface WorkChecklist {
  readonly total: number;
  readonly completed: number;
}

export interface WorkItem {
  readonly key: WorkItemKey;
  readonly displayId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly state: WorkItemState;
  readonly status: WorkStatus;
  readonly priority: WorkPriority;
  readonly tags: readonly string[];
  readonly assignees: readonly string[];
  readonly project: WorkProject | null;
  readonly blockers: readonly WorkItemKey[];
  readonly blockedBy: readonly WorkItemKey[];
  readonly sequence: string | null;
  readonly checklist: WorkChecklist;
  readonly trustedMetadata: JsonObject;
  readonly source: ProviderSource;
}

export type ActionMutation = "work-provider" | "review-provider" | "repository-provider" | "local-only" | "none";
export type ActionStatus = "planned" | "completed" | "failed" | "skipped";
export type ActionKind =
  | "assign-work"
  | "close-work"
  | "comment-work"
  | "create-branch"
  | "merge-review"
  | "pause-work"
  | "replace-status-labels"
  | "request-review"
  | "resume-work"
  | "sync-work-status"
  | "run-gate"
  | "start-work"
  | "update-policy"
  | "update-review"
  | "verify-repository";
export type ActionTargetKind = "work-item" | "review-item" | "repository" | "gate" | "policy";

export interface ActionTarget {
  readonly kind: ActionTargetKind;
  readonly id: string;
}

export interface ActionFailure {
  readonly operation: string;
  readonly cause: string;
  readonly nextAction: string;
}

export interface Action {
  readonly id: string;
  readonly kind: ActionKind;
  readonly target: ActionTarget;
  readonly mutation: ActionMutation;
  readonly description: string;
  readonly preconditions: readonly string[];
  readonly expectedResult: string;
  readonly status: ActionStatus;
  readonly details: JsonObject;
  readonly failure: ActionFailure | null;
}

export interface ActionResult {
  readonly actionId: string;
  readonly status: Exclude<ActionStatus, "planned">;
  readonly failure: ActionFailure | null;
  readonly details: JsonObject;
}

export interface ActionSummary {
  readonly plannedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

export interface ActionPlan {
  readonly id: string;
  readonly purpose: string;
  readonly dryRun: boolean;
  readonly actions: readonly Action[];
  readonly summary: ActionSummary;
}

export interface ExecutorPolicy {
  readonly branchPattern: string;
  readonly baseBranch: string;
  readonly requireCleanWorktree: boolean;
  readonly requireBaseCurrent: boolean;
  readonly maxActiveIssues: number;
  readonly blockOnOpenPullRequests: boolean;
  readonly linkedWorktreeExecution: boolean;
  readonly statusLabels: {
    readonly ready: string;
    readonly inProgress: string;
    readonly blocked: string;
    readonly completed: string;
  };
}

export interface WorkProviderCapabilities {
  readonly listOpenWork: boolean;
  readonly loadWork: boolean;
  readonly planStatusSync: boolean;
  readonly planLifecycleMutations: boolean;
  readonly applyLifecycleMutations: boolean;
  readonly commentMutations: boolean;
  readonly reviewIntegration: boolean;
  readonly ciMergeStatus: boolean;
}

export type WorkProviderId = "github" | "gitlab" | "linear" | "jira";

export interface WorkProvider {
  readonly id: WorkProviderId;
  capabilities(): WorkProviderCapabilities;
  listOpenWorkItems(): Promise<readonly WorkItem[]>;
  getWorkItem(key: WorkItemKey): Promise<WorkItem>;
  planStatusSync(items: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planStart(item: WorkItem, policy: ExecutorPolicy): ActionPlan;
  planPause(item: WorkItem, openItems: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planComplete(item: WorkItem, dependents: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
}

export interface QubePathContract {
  readonly owner: "qube" | QubeProductId | "repository";
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly committed: boolean;
  readonly migrationPolicy: string;
}

export interface QubeRepoArtifactContract {
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly productInstalledSurface: boolean;
  readonly notes: string;
}

export const qubeProductContracts = [
  {
    id: "bootstrap",
    packageName: "@tjalve/aib",
    commandName: "aib",
    role: "Plan and bootstrap work from idea to issue queue.",
    standalone: true,
    surfaces: ["cli", "github", "gitlab", "linear", "jira", "codex", "opencode", "claude-code", "grok-build"],
  },
  {
    id: "executor",
    packageName: "@tjalve/aie",
    commandName: "aie",
    role: "Execute issue-driven work through repository and review gates.",
    standalone: true,
    surfaces: ["cli", "github", "gitlab", "linear", "jira", "jenkins", "codex", "opencode", "claude-code", "grok-build"],
  },
  {
    id: "quality",
    packageName: "@tjalve/aiq",
    commandName: "aiq",
    role: "Evaluate code quality and package readiness across languages.",
    standalone: true,
    surfaces: ["cli"],
  },
  {
    id: "umpire",
    packageName: "@tjalve/aiu",
    commandName: "aiu",
    role: "Coordinate safe agent continuation and host stop hooks.",
    standalone: true,
    surfaces: ["cli", "opencode", "claude-code", "grok-build"],
  },
] as const satisfies readonly QubeProductContract[];

export const qubeCommandSurfaceContracts = [
  {
    productId: "bootstrap",
    packageName: "@tjalve/aib",
    commandPattern: "aib init|status|next|answer|spec *|milestones *|work-items *",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Bootstrap planning commands are safe to discover through QUBE and keep provider mutation behind dry-run or local-file guards.",
  },
  {
    productId: "executor",
    packageName: "@tjalve/aie",
    commandPattern: "aie queue|start|switch|branch *|pr *|complete|review|doctor|schema|init|migrate",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Executor owns GitHub issue, PR, and review workflow behavior plus host instruction init/migration.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq run|check|plan|doctor|setup|status|config|evidence|schema",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Quality workflow commands are discoverable by QUBE; mutating or tool-running commands expose dry-run and supply-chain metadata.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq bench|watch|serve|hook install|ci setup|ignore write",
    classification: "standalone package command",
    qubeFacing: false,
    schemaRequired: true,
    notes: "AIQ benchmark, daemon, and adapter-guidance commands remain standalone package surfaces and are documented as such.",
  },
  {
    productId: "umpire",
    packageName: "@tjalve/aiu",
    commandPattern: "aiu config|doctor|status|paths|init|migrate|hook-stop|whip",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Umpire exposes continuation policy, trusted-state, OpenCode host integration, and local whip state commands.",
  },
] as const satisfies readonly QubeCommandSurfaceContract[];

export const qubePathContracts = [
  {
    owner: "qube",
    pathPattern: ".qube/",
    classification: "shared QUBE namespace",
    committed: false,
    migrationPolicy: "Shared namespace for package config, state, logs, locks, cache, and generated artifacts; product migrations preserve legacy paths unless explicitly applied.",
  },
  {
    owner: "bootstrap",
    pathPattern: ".qube/aib/session.json",
    classification: "standalone product state",
    committed: false,
    migrationPolicy: "AIB defaults write QUBE-prefixed state; explicit legacy .bootstrap/session.json paths remain readable and migration must preserve existing state.",
  },
  {
    owner: "quality",
    pathPattern: ".qube/aiq/config.json, .qube/aiq/progress.json, and .qube/aiq/out/",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIQ setup creates missing QUBE-prefixed files only; legacy .aiq/ and aiq.config.json discovery remain migration/backward-compatible inputs.",
  },
  {
    owner: "umpire",
    pathPattern: ".qube/aiu/config.json",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIU init and migrate prefer QUBE-prefixed config, fall back to legacy aiu.config.json, and preserve existing config unless explicit replacement is confirmed.",
  },
  {
    owner: "umpire",
    pathPattern: ".qube/aiu/state, .qube/aiu/locks, .qube/aiu/logs, and .qube/aiu/whip.json",
    classification: "standalone product state",
    committed: false,
    migrationPolicy: "AIU defaults write QUBE-prefixed state; migration detects and preserves legacy .umpire state unless cleanup is explicitly confirmed.",
  },
  {
    owner: "executor",
    pathPattern: ".qube/aie/config.json, .qube/aie/gates/, .qube/aie/reviews/, and .qube/aie/runs/",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIE init writes QUBE-prefixed product config and runtime evidence; legacy aie.config.json remains a repo-policy fallback and copied workflow files remain separate.",
  },
  {
    owner: "repository",
    pathPattern: "products/*/AGENTS.md and products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    committed: true,
    migrationPolicy: "Repository-local implementation artifacts are not package-installed product surfaces unless a product command documents and writes them.",
  },
] as const satisfies readonly QubePathContract[];

export const qubeRepoArtifactContracts = [
  {
    pathPattern: "AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Root agent policy guides monorepo implementation and is not installed by QUBE packages.",
  },
  {
    pathPattern: "products/*/AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Package-directory agent policies guide repo work on that package; they do not imply installed package behavior.",
  },
  {
    pathPattern: "products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Copied Executor config under package directories is local workflow policy, not evidence that those products own review-agent config.",
  },
  {
    pathPattern: "products/*/test-projects/**",
    classification: "test fixture or sample",
    productInstalledSurface: false,
    notes: "Fixture projects are used by tests and are not product config defaults.",
  },
] as const satisfies readonly QubeRepoArtifactContract[];

export function findQubeProduct(value: string): QubeProductContract | undefined {
  return qubeProductContracts.find((product) =>
    product.id === value || product.packageName === value || product.commandName === value
  );
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function nonEmptyProviderSource(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} was empty or whitespace-only.`);
  return normalized;
}

export function normalizeProviderSource(input: {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId?: string | null;
  readonly url?: string | null;
  readonly metadata?: JsonObject;
}): ProviderSource {
  return {
    providerId: nonEmptyProviderSource(input.providerId, "providerId"),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId === undefined || input.resourceId === null ? null : nonEmptyProviderSource(input.resourceId, "resourceId"),
    url: input.url === undefined ? null : input.url,
    metadata: input.metadata ?? {},
  };
}

export function normalizeWorkItemKey(providerId: string, id: string): WorkItemKey {
  return { providerId: nonEmpty(providerId, "providerId"), id: nonEmpty(id, "id") };
}

export function sameWorkItemKey(left: WorkItemKey, right: WorkItemKey): boolean {
  return left.providerId === right.providerId && left.id === right.id;
}

const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

export function workItemKeyNumber(key: WorkItemKey, context = `work item ${key.providerId}:${key.id}`): number {
  if (!CANONICAL_POSITIVE_INTEGER.test(key.id)) {
    throw new Error(`Failed to render issue number: ${context} key.id must be a canonical positive base-10 integer; use a provider-specific adapter before rendering issue-number commands.`);
  }
  const number = Number.parseInt(key.id, 10);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Failed to render issue number: ${context} key.id exceeds JavaScript's safe integer range; use a provider-specific adapter before rendering issue-number commands.`);
  }
  return number;
}

export function maybeWorkItemKeyNumber(key: WorkItemKey): number | null {
  if (!CANONICAL_POSITIVE_INTEGER.test(key.id)) return null;
  const number = Number.parseInt(key.id, 10);
  return Number.isSafeInteger(number) ? number : null;
}

export function workItemNumber(item: WorkItem): number {
  return workItemKeyNumber(item.key, item.displayId);
}

export function sourceKey(source: ProviderSource): string {
  return JSON.stringify([source.providerId, source.resourceKind, source.resourceId]);
}

export function uniqueWorkItemKeys(keys: readonly WorkItemKey[]): readonly WorkItemKey[] {
  const seen = new Set<string>();
  const unique: WorkItemKey[] = [];
  for (const key of keys) {
    const normalizedKey = normalizeWorkItemKey(key.providerId, key.id);
    const stableKey = JSON.stringify([normalizedKey.providerId, normalizedKey.id]);
    if (!seen.has(stableKey)) {
      seen.add(stableKey);
      unique.push(normalizedKey);
    }
  }
  return unique;
}

export function normalizeWorkItem(input: Omit<WorkItem, "blockers" | "blockedBy" | "tags" | "assignees" | "checklist" | "trustedMetadata"> & {
  readonly blockers?: readonly WorkItemKey[];
  readonly blockedBy?: readonly WorkItemKey[];
  readonly tags?: readonly string[];
  readonly assignees?: readonly string[];
  readonly checklist?: WorkChecklist;
  readonly trustedMetadata?: JsonObject;
}): WorkItem {
  const checklist = input.checklist ?? { total: 0, completed: 0 };
  if (!Number.isFinite(checklist.total) || !Number.isInteger(checklist.total)) {
    throw new Error("checklist.total must be a finite integer.");
  }
  if (!Number.isFinite(checklist.completed) || !Number.isInteger(checklist.completed)) {
    throw new Error("checklist.completed must be a finite integer.");
  }
  if (checklist.total < 0) throw new Error("checklist.total must not be negative.");
  if (checklist.completed < 0) throw new Error("checklist.completed must not be negative.");
  if (checklist.completed > checklist.total) throw new Error("checklist.completed must not exceed checklist.total.");
  return {
    ...input,
    key: normalizeWorkItemKey(input.key.providerId, input.key.id),
    source: normalizeProviderSource(input.source),
    displayId: nonEmpty(input.displayId, "displayId"),
    title: nonEmpty(input.title, "title"),
    tags: [...new Set(input.tags ?? [])],
    assignees: [...new Set(input.assignees ?? [])],
    blockers: uniqueWorkItemKeys(input.blockers ?? []),
    blockedBy: uniqueWorkItemKeys(input.blockedBy ?? []),
    checklist,
    trustedMetadata: input.trustedMetadata ?? {},
  };
}

export function createAction(input: Omit<Action, "preconditions" | "status" | "details" | "failure"> & {
  readonly preconditions?: readonly string[];
  readonly status?: ActionStatus;
  readonly details?: JsonObject;
  readonly failure?: ActionFailure | null;
}): Action {
  nonEmpty(input.kind, "kind");
  return {
    ...input,
    id: nonEmpty(input.id, "id"),
    kind: input.kind,
    target: { ...input.target, id: nonEmpty(input.target.id, "target.id") },
    description: nonEmpty(input.description, "description"),
    expectedResult: nonEmpty(input.expectedResult, "expectedResult"),
    preconditions: input.preconditions ?? [],
    status: input.status ?? "planned",
    details: input.details ?? {},
    failure: input.failure ?? null,
  };
}

export function summarizeActions(actions: readonly Action[]): ActionSummary {
  return {
    plannedCount: actions.filter((action) => action.status === "planned").length,
    completedCount: actions.filter((action) => action.status === "completed").length,
    failedCount: actions.filter((action) => action.status === "failed").length,
    skippedCount: actions.filter((action) => action.status === "skipped").length,
  };
}

export function createActionPlan(input: Omit<ActionPlan, "summary">): ActionPlan {
  return {
    ...input,
    id: nonEmpty(input.id, "id"),
    purpose: nonEmpty(input.purpose, "purpose"),
    summary: summarizeActions(input.actions),
  };
}

export function defineQubeAdapter<T extends QubeAdapterContract>(adapter: T): Readonly<T> {
  return Object.freeze({ ...adapter });
}

export * from "./review.js";
// Provider-neutral work queue helpers moved from AIE.

export interface MilestoneOrderingPolicy {
  readonly enabled: boolean;
  readonly order: readonly string[];
  readonly missingAssignment: 'warn' | 'block' | 'ignore';
}

export type EffectiveWorkStatus = 'InProgress' | 'Ready' | 'Blocked';

export interface WorkQueuePolicy {
  priorityLabels: string[];
  statusLabels: string[];
  milestoneOrdering: MilestoneOrderingPolicy;
}

export interface WorkDependencyNode {
  workItem: WorkItem;
  openBlockerKeys: WorkItemKey[];
  openDependentKeys: WorkItemKey[];
  blocksOpenWork: boolean;
}

export interface WorkDependencyCycle {
  keys: WorkItemKey[];
}

export interface WorkDependencyGraph {
  nodes: WorkDependencyNode[];
  cycles: WorkDependencyCycle[];
}

export interface WorkQueueItem {
  workItem: WorkItem;
  effectiveStatus: EffectiveWorkStatus;
  openBlockerKeys: WorkItemKey[];
  openDependentKeys: WorkItemKey[];
  blocksOpenWork: boolean;
  drifted: boolean;
}

export interface WorkMilestoneProgress {
  totalItems: number;
  inProgressCount: number;
  readyCount: number;
  blockedCount: number;
  checklistTotal: number;
  checklistCompleted: number;
}

export interface WorkMilestoneGroup {
  projectId: string | null;
  title: string;
  state: 'open' | 'closed' | 'unknown';
  dueOn: string | null;
  itemKeys: WorkItemKey[];
  progress: WorkMilestoneProgress;
}

export interface WorkQueueState {
  items: WorkQueueItem[];
  inProgressCount: number;
  readyCount: number;
  blockedCount: number;
  driftCount: number;
  multipleInProgress: boolean;
  cycles: WorkDependencyCycle[];
  milestoneGroups: WorkMilestoneGroup[];
}

export interface WorkStatusSyncPlan {
  key: WorkItemKey;
  displayId: string;
  effectiveStatus: EffectiveWorkStatus;
  openBlockerKeys: WorkItemKey[];
  blocksOpenWork: boolean;
  addLabels: string[];
  removeLabels: string[];
  skipped: boolean;
  reason?: string;
}

export interface NextWorkSelection {
  workItem: WorkItem | null;
  reason: string;
  multipleInProgress: boolean;
  driftCount: number;
}

const DEFAULT_PRIORITY_ORDER: WorkPriority[] = ['critical', 'high', 'medium', 'low', 'none'];
const DEFAULT_STATUS_LABELS = ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'];

function stableKey(key: WorkItemKey): string {
  return JSON.stringify([key.providerId, key.id]);
}

function uniqueKeys(keys: WorkItemKey[]): WorkItemKey[] {
  const seen = new Set<string>();
  const unique: WorkItemKey[] = [];
  for (const key of keys) {
    const id = stableKey(key);
    if (!seen.has(id)) {
      seen.add(id);
      unique.push({ providerId: key.providerId, id: key.id });
    }
  }
  return unique;
}

export function resolveWorkStatusLabels(policy: WorkQueuePolicy): { ready: string; inProgress: string; blocked: string; blocking: string; all: string[] } {
  const labels = policy.statusLabels.length > 0 ? policy.statusLabels : DEFAULT_STATUS_LABELS;
  return {
    ready: labels.find(label => label === 'S-Ready') ?? labels[0] ?? 'S-Ready',
    inProgress: labels.find(label => label === 'S-InProgress') ?? labels[1] ?? 'S-InProgress',
    blocked: labels.find(label => label === 'S-Blocked') ?? labels[2] ?? 'S-Blocked',
    blocking: labels.find(label => label === 'S-Blocking') ?? labels[3] ?? 'S-Blocking',
    all: labels,
  };
}

function itemHasStatusLabel(item: WorkItem, label: string): boolean {
  return item.tags.includes(label);
}

export function workItemStableKey(item: WorkItem): string {
  return stableKey(item.key);
}

export function workItemIsInProgress(item: WorkItem, policy: WorkQueuePolicy): boolean {
  return item.status === 'in-progress' || itemHasStatusLabel(item, resolveWorkStatusLabels(policy).inProgress);
}

export function getOpenWorkItemKeys(items: WorkItem[]): Set<string> {
  return new Set(items.filter(item => item.state === 'open').map(workItemStableKey));
}

export function getOpenBlockerKeys(item: WorkItem, openKeys: Set<string>): WorkItemKey[] {
  return uniqueKeys(item.blockers.filter(blocker => openKeys.has(stableKey(blocker))));
}

function keysFromStableSet(keys: Set<string>, keyByStableKey: Map<string, WorkItemKey>): WorkItemKey[] {
  return [...keys].map(key => keyByStableKey.get(key)).filter((key): key is WorkItemKey => key !== undefined);
}

function detectCycles(openItems: WorkItem[], blockersByItemKey: Map<string, Set<string>>, keyByStableKey: Map<string, WorkItemKey>): WorkDependencyCycle[] {
  const cycles: WorkDependencyCycle[] = [];
  const seenCycles = new Set<string>();

  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();

  function addCycle(stableKeys: string[]): void {
    const cycleKeys = keysFromStableSet(new Set(stableKeys), keyByStableKey);
    const stableCycle = cycleKeys.map(stableKey).sort().join('|');
    if (!stableCycle || seenCycles.has(stableCycle)) return;
    seenCycles.add(stableCycle);
    cycles.push({ keys: cycleKeys });
  }

  function visit(itemKey: string): void {
    indexes.set(itemKey, nextIndex);
    lowlinks.set(itemKey, nextIndex);
    nextIndex += 1;
    stack.push(itemKey);
    stacked.add(itemKey);

    for (const blockerKey of blockersByItemKey.get(itemKey) ?? []) {
      if (!keyByStableKey.has(blockerKey)) continue;
      if (!indexes.has(blockerKey)) {
        visit(blockerKey);
        lowlinks.set(itemKey, Math.min(lowlinks.get(itemKey) ?? 0, lowlinks.get(blockerKey) ?? 0));
      } else if (stacked.has(blockerKey)) {
        lowlinks.set(itemKey, Math.min(lowlinks.get(itemKey) ?? 0, indexes.get(blockerKey) ?? 0));
      }
    }

    if (lowlinks.get(itemKey) !== indexes.get(itemKey)) return;

    const component: string[] = [];
    let currentKey: string | undefined;
    do {
      currentKey = stack.pop();
      if (!currentKey) break;
      stacked.delete(currentKey);
      component.push(currentKey);
    } while (currentKey !== itemKey);

    if (component.length > 1 || (component.length === 1 && (blockersByItemKey.get(component[0]) ?? new Set<string>()).has(component[0]))) {
      addCycle(component);
    }
  }

  for (const item of openItems) {
    const itemKey = workItemStableKey(item);
    if (!indexes.has(itemKey)) visit(itemKey);
  }

  return cycles;
}

export function buildWorkDependencyGraph(items: WorkItem[]): WorkDependencyGraph {
  const openItems = items.filter(item => item.state === 'open');
  const openKeySet = getOpenWorkItemKeys(openItems);
  const keyByStableKey = new Map(openItems.map(item => [workItemStableKey(item), item.key]));
  const blockersByItemKey = new Map<string, Set<string>>();
  const dependentsByItemKey = new Map<string, Set<string>>();

  for (const item of openItems) {
    const itemKey = workItemStableKey(item);
    blockersByItemKey.set(itemKey, blockersByItemKey.get(itemKey) ?? new Set<string>());
    dependentsByItemKey.set(itemKey, dependentsByItemKey.get(itemKey) ?? new Set<string>());
  }

  function addEdge(dependent: WorkItemKey, blocker: WorkItemKey): void {
    const dependentKey = stableKey(dependent);
    const blockerKey = stableKey(blocker);
    if (!openKeySet.has(dependentKey) || !openKeySet.has(blockerKey)) return;
    blockersByItemKey.get(dependentKey)?.add(blockerKey);
    if (dependentKey === blockerKey) return;
    dependentsByItemKey.get(blockerKey)?.add(dependentKey);
  }

  for (const item of openItems) {
    for (const blocker of item.blockers) addEdge(item.key, blocker);
    for (const dependent of item.blockedBy) addEdge(dependent, item.key);
  }

  const nodes = openItems.map(workItem => {
    const itemKey = workItemStableKey(workItem);
    const openDependentKeys = keysFromStableSet(dependentsByItemKey.get(itemKey) ?? new Set<string>(), keyByStableKey);
    return {
      workItem,
      openBlockerKeys: keysFromStableSet(blockersByItemKey.get(itemKey) ?? new Set<string>(), keyByStableKey),
      openDependentKeys,
      blocksOpenWork: openDependentKeys.length > 0,
    };
  });
  return { nodes, cycles: detectCycles(openItems, blockersByItemKey, keyByStableKey) };
}

function effectiveStatus(item: WorkItem, node: WorkDependencyNode, policy: WorkQueuePolicy): EffectiveWorkStatus {
  if (workItemIsInProgress(item, policy)) return 'InProgress';
  return node.openBlockerKeys.length > 0 ? 'Blocked' : 'Ready';
}

function itemStatusMatchesEffective(item: WorkItem, expected: WorkStatus, label: string): boolean {
  return item.status === expected || item.tags.includes(label);
}

function isDrifted(item: WorkItem, status: EffectiveWorkStatus, policy: WorkQueuePolicy): boolean {
  const labels = resolveWorkStatusLabels(policy);
  if (status === 'InProgress') return false;
  if (status === 'Ready') {
    return !itemStatusMatchesEffective(item, 'ready', labels.ready) || item.status === 'blocked' || item.tags.includes(labels.blocked);
  }
  return !itemStatusMatchesEffective(item, 'blocked', labels.blocked) || item.status === 'ready' || item.status === 'in-progress' || item.tags.includes(labels.ready) || item.tags.includes(labels.inProgress);
}

function extractTaskNumber(title: string): string | null {
  const match = title.match(/^(?:[A-Z]+)?(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

function priorityRank(item: WorkItem, policy: WorkQueuePolicy): number {
  const configured = policy.priorityLabels.find(label => item.tags.includes(label));
  if (configured) return policy.priorityLabels.indexOf(configured);
  const fallback = DEFAULT_PRIORITY_ORDER.indexOf(item.priority);
  return fallback >= 0 ? fallback : DEFAULT_PRIORITY_ORDER.length;
}

function milestoneRank(item: WorkItem, policy: WorkQueuePolicy): number {
  if (!policy.milestoneOrdering.enabled) return 0;
  if (!item.project) return policy.milestoneOrdering.order.length + 1;
  const index = policy.milestoneOrdering.order.indexOf(item.project.title);
  return index >= 0 ? index : policy.milestoneOrdering.order.length;
}

function numericFallback(item: WorkItem): number | null {
  return maybeWorkItemKeyNumber(item.key);
}

function compareWorkItems(left: WorkQueueItem, right: WorkQueueItem, policy: WorkQueuePolicy): number {
  const statusRank = (status: EffectiveWorkStatus): number => status === 'InProgress' ? 0 : status === 'Ready' ? 1 : 2;
  let comparison = statusRank(left.effectiveStatus) - statusRank(right.effectiveStatus);
  if (comparison !== 0) return comparison;

  comparison = priorityRank(left.workItem, policy) - priorityRank(right.workItem, policy);
  if (comparison !== 0) return comparison;

  comparison = (left.workItem.sequence ?? '').localeCompare(right.workItem.sequence ?? '', undefined, { numeric: true });
  if (comparison !== 0) return comparison;

  comparison = milestoneRank(left.workItem, policy) - milestoneRank(right.workItem, policy);
  if (comparison !== 0) return comparison;

  comparison = (extractTaskNumber(left.workItem.title) ?? '').localeCompare(extractTaskNumber(right.workItem.title) ?? '', undefined, { numeric: true });
  if (comparison !== 0) return comparison;

  const leftNumber = numericFallback(left.workItem);
  const rightNumber = numericFallback(right.workItem);
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  return left.workItem.displayId.localeCompare(right.workItem.displayId, undefined, { numeric: true });
}

function milestoneGroupKey(item: WorkItem): string {
  return item.project ? `project:${item.project.id}:${item.project.title}` : 'project:none';
}

function buildMilestoneGroups(items: WorkQueueItem[]): WorkMilestoneGroup[] {
  const groups = new Map<string, WorkMilestoneGroup>();
  for (const item of items) {
    const key = milestoneGroupKey(item.workItem);
    const existing = groups.get(key) ?? {
      projectId: item.workItem.project?.id ?? null,
      title: item.workItem.project?.title ?? 'No milestone',
      state: item.workItem.project?.state ?? 'unknown',
      dueOn: item.workItem.project?.dueOn ?? null,
      itemKeys: [],
      progress: { totalItems: 0, inProgressCount: 0, readyCount: 0, blockedCount: 0, checklistTotal: 0, checklistCompleted: 0 },
    };
    existing.itemKeys.push(item.workItem.key);
    existing.progress.totalItems += 1;
    existing.progress.checklistTotal += item.workItem.checklist.total;
    existing.progress.checklistCompleted += item.workItem.checklist.completed;
    if (item.effectiveStatus === 'InProgress') existing.progress.inProgressCount += 1;
    if (item.effectiveStatus === 'Ready') existing.progress.readyCount += 1;
    if (item.effectiveStatus === 'Blocked') existing.progress.blockedCount += 1;
    groups.set(key, existing);
  }
  return [...groups.values()];
}

export function computeWorkQueue(items: WorkItem[], policy: WorkQueuePolicy): WorkQueueState {
  const graph = buildWorkDependencyGraph(items);
  const queueItems: WorkQueueItem[] = graph.nodes.map(node => {
    const status = effectiveStatus(node.workItem, node, policy);
    return {
      workItem: node.workItem,
      effectiveStatus: status,
      openBlockerKeys: node.openBlockerKeys,
      openDependentKeys: node.openDependentKeys,
      blocksOpenWork: node.blocksOpenWork,
      drifted: isDrifted(node.workItem, status, policy),
    };
  }).sort((left, right) => compareWorkItems(left, right, policy));

  const inProgressCount = queueItems.filter(item => item.effectiveStatus === 'InProgress').length;
  const readyCount = queueItems.filter(item => item.effectiveStatus === 'Ready').length;
  const blockedCount = queueItems.filter(item => item.effectiveStatus === 'Blocked').length;
  const driftCount = queueItems.filter(item => item.drifted).length;

  return {
    items: queueItems,
    inProgressCount,
    readyCount,
    blockedCount,
    driftCount,
    multipleInProgress: inProgressCount > 1,
    cycles: graph.cycles,
    milestoneGroups: buildMilestoneGroups(queueItems),
  };
}

export function selectNextWork(queue: WorkQueueState): NextWorkSelection {
  const inProgress = queue.items.filter(item => item.effectiveStatus === 'InProgress');
  if (inProgress.length === 1) {
    return {
      workItem: inProgress[0].workItem,
      reason: `Resuming the single active work item ${inProgress[0].workItem.displayId}`,
      multipleInProgress: false,
      driftCount: queue.driftCount,
    };
  }
  if (inProgress.length > 1) {
    return {
      workItem: null,
      reason: `Multiple active work items detected (${inProgress.length}). Fix status labels before any new or resumed work. Selection fails.`,
      multipleInProgress: true,
      driftCount: queue.driftCount,
    };
  }
  const ready = queue.items.find(item => item.effectiveStatus === 'Ready');
  if (ready) {
    return {
      workItem: ready.workItem,
      reason: `Next ready work item ${ready.workItem.displayId} (no open blockers, highest priority)`,
      multipleInProgress: false,
      driftCount: queue.driftCount,
    };
  }
  return {
    workItem: null,
    reason: 'No ready work items (queue empty or all blocked). Run the status sync command if drift exists.',
    multipleInProgress: false,
    driftCount: queue.driftCount,
  };
}

export function planStatusSyncFromWorkItems(items: WorkItem[], policy: WorkQueuePolicy): WorkStatusSyncPlan[] {
  const labels = resolveWorkStatusLabels(policy);
  const queue = computeWorkQueue(items, policy);
  const queueItemsByKey = new Map(queue.items.map(item => [workItemStableKey(item.workItem), item]));
  return items.filter(item => item.state === 'open').map(workItem => {
    const item = queueItemsByKey.get(workItemStableKey(workItem));
    if (!item) {
      throw new Error(`plan status sync failed: open work item ${workItem.displayId} was missing from the computed queue. Rebuild the queue and retry.`);
    }
    if (item.effectiveStatus === 'InProgress') {
      return {
        key: item.workItem.key,
        displayId: item.workItem.displayId,
        effectiveStatus: item.effectiveStatus,
        openBlockerKeys: item.openBlockerKeys,
        blocksOpenWork: item.blocksOpenWork,
        addLabels: [],
        removeLabels: [],
        skipped: true,
        reason: 'S-InProgress issues are never changed by deps fix',
      };
    }

    const addLabels: string[] = [];
    const removeLabels: string[] = [];
    const hasReady = item.workItem.tags.includes(labels.ready);
    const hasBlocked = item.workItem.tags.includes(labels.blocked);
    const hasBlocking = item.workItem.tags.includes(labels.blocking);

    if (item.effectiveStatus === 'Ready') {
      if (!hasReady) addLabels.push(labels.ready);
      if (hasBlocked) removeLabels.push(labels.blocked);
    } else {
      if (!hasBlocked) addLabels.push(labels.blocked);
      if (hasReady) removeLabels.push(labels.ready);
    }

    if (item.blocksOpenWork && !hasBlocking) addLabels.push(labels.blocking);
    if (!item.blocksOpenWork && hasBlocking) removeLabels.push(labels.blocking);

    for (const label of labels.all) {
      if (label !== labels.ready && label !== labels.blocked && label !== labels.blocking && item.workItem.tags.includes(label)) {
        removeLabels.push(label);
      }
    }

    return {
      key: item.workItem.key,
      displayId: item.workItem.displayId,
      effectiveStatus: item.effectiveStatus,
      openBlockerKeys: item.openBlockerKeys,
      blocksOpenWork: item.blocksOpenWork,
      addLabels: [...new Set(addLabels)],
      removeLabels: [...new Set(removeLabels)],
      skipped: false,
    };
  });
}

export function createWorkStatusSyncActionPlan(items: WorkItem[], policy: WorkQueuePolicy): ActionPlan {
  const actions: Action[] = [];
  for (const plan of planStatusSyncFromWorkItems(items, policy)) {
    if (plan.skipped || (plan.addLabels.length === 0 && plan.removeLabels.length === 0)) continue;
    actions.push(createAction({
      id: `replace-status-labels:${plan.key.providerId}:${plan.key.id}`,
      kind: 'replace-status-labels',
      target: { kind: 'work-item', id: plan.key.id },
      mutation: 'work-provider',
      description: `Synchronize dependency status labels for ${plan.displayId}`,
      expectedResult: `${plan.displayId} has provider labels synchronized with Executor work state.`,
      details: {
        providerId: plan.key.providerId,
        workItemId: plan.key.id,
        displayId: plan.displayId,
        effectiveStatus: plan.effectiveStatus,
        addLabels: plan.addLabels,
        removeLabels: plan.removeLabels,
      },
    }));
  }
  return createActionPlan({
    id: 'work:status-sync',
    purpose: 'Synchronize work status labels from provider-neutral work state.',
    dryRun: true,
    actions,
  });
}
