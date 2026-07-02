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
    adapterCapability("map-work-item", "supported", "@tjalve/aie", "Map GitHub issues into provider-neutral Executor work-item keys, labels, blockers, checklist state, and metadata."),
    adapterCapability("work-item-queue", "supported", "@tjalve/aie", "Read GitHub issue queues through Executor work-provider rules."),
    adapterCapability("sync-issue-status", "supported", "@tjalve/aie", "Synchronize GitHub status labels with Executor work lifecycle state."),
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
