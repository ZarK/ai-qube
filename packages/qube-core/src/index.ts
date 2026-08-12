export type {
  AutoresearchAcceptancePolicy,
  AutoresearchArena,
  AutoresearchArenaPlan,
  AutoresearchBlockingQuestion,
  AutoresearchEvaluator,
  AutoresearchEvaluatorKind,
  AutoresearchInvariant,
  AutoresearchMutableSurface,
  AutoresearchObjective,
  AutoresearchObjectiveDirection,
  AutoresearchObjectiveShape,
  AutoresearchPlanClassification,
  AutoresearchTarget,
  AutoresearchTargetKind,
} from "./autoresearch.js";
export {
  AUTORESEARCH_EVALUATOR_KINDS,
  AUTORESEARCH_OBJECTIVE_SHAPES,
  AUTORESEARCH_TARGET_KINDS,
  autoresearchReadinessChecklist,
} from "./autoresearch.js";
export type { JsonObject, JsonValue } from "./json_value.js";
export type {
  ConnectionAuthMethod,
  ConnectionBasicAuth,
  ConnectionCommandProbe,
  ConnectionCommandResult,
  ConnectionConfigField,
  ConnectionContract,
  ConnectionEnvVar,
  ConnectionHeader,
  ConnectionHttpProbe,
  ConnectionHttpRequest,
  ConnectionHttpResponse,
  ConnectionProbeContract,
  ConnectionProbeFixture,
  ConnectionProbeMode,
  ConnectionProbeOptions,
  ConnectionProbeResult,
  ConnectionProbeStatus,
  ConnectionValueSource,
} from "./connection.js";
export { readConnectionJsonResponse, runConnectionProbe } from "./connection.js";
import type { ConnectionContract } from "./connection.js";
export type {
  ProviderResourceKind,
  ProviderSource,
} from "./provider_source.js";
export { normalizeProviderSource, sourceKey } from "./provider_source.js";
export type { WorkItemKey } from "./work_item_key.js";
export { normalizeWorkItemKey, sameWorkItemKey, uniqueWorkItemKeys } from "./work_item_key.js";
export type {
  WorkChecklist,
  WorkChecklistItem,
  WorkItem,
  WorkItemState,
  WorkPriority,
  WorkProject,
  WorkStatus,
} from "./work_item.js";
export {
  maybeWorkItemKeyNumber,
  normalizeWorkItem,
  parseWorkChecklist,
  parseWorkChecklistItems,
  workItemKeyNumber,
  workItemNumber,
} from "./work_item.js";
export type {
  Action,
  ActionFailure,
  ActionKind,
  ActionMutation,
  ActionPlan,
  ActionResult,
  ActionStatus,
  ActionSummary,
  ActionTarget,
  ActionTargetKind,
} from "./action_plan.js";
export { createAction, createActionPlan, summarizeActions } from "./action_plan.js";
export type {
  ExecutorPolicy,
  WorkProvider,
  WorkProviderCapabilities,
  WorkProviderId,
} from "./work_provider.js";
export type {
  AgentHostId,
  AgentHostProfile,
  CodexReviewCapability,
  CommandRenderer,
  CommandTarget,
  DialogueCapability,
  HookCapability,
  HostReviewRunnerAdapter,
  HostReviewRunnerCapabilities,
  HostReviewRunnerId,
  InstructionTarget,
  SubagentCapability,
  TodoCapability,
} from "./agent_host.js";
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
  RepoAffectedProject,
  RepoAffectedResult,
  RepoCiHint,
  RepoLayoutInspection,
  RepoLayoutKind,
  RepoPackageManager,
  RepoPathSignal,
  RepoProject,
  RepoProjectKind,
  RepoRootMarker,
} from "./repo_layout.js";
export { REPO_LAYOUT_KINDS } from "./repo_layout.js";
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
  PartitionedReviewFindings,
  ReviewAdapterKind,
  ReviewAgentAdapter,
  ReviewAgentCommentBody,
  ReviewDiffIndex,
  ReviewFinding,
  ReviewFindingLocation,
  ReviewFindingSeverity,
  ReviewFindingSide,
  ReviewForgeAdapterKind,
  ReviewForgeCapabilities,
  ReviewForgePlanOptions,
  ReviewForgePolicy,
  ReviewForgeProvider,
  ReviewForgePullRequest,
  ReviewForgeRecentPullRequestOptions,
  ReviewForgeLaneReviewHistory,
  ReviewForgeSnapshot,
  ReviewForgeStatsCapability,
  ReviewForgeStatsProvider,
  ReviewLaneReviewPublishInput,
  ReviewLaneReviewPublishResult,
  ReviewRequestTrigger,
  ReviewRoundSummaryFinding,
  ReviewRoundSummaryPublishInput,
  ReviewRoundSummaryPublishResult,
} from "./review_forge.js";
export { normalizeReviewFinding, partitionReviewFindings, supportsReviewStats } from "./review_forge.js";
export type {
  ReviewParticipant,
  ReviewParticipantAgentAdapter,
  ReviewParticipantKind,
  ReviewParticipantObservation,
  ReviewParticipantRecommendation,
  ReviewParticipantRollup,
  ReviewParticipantTransport,
} from "./review_participant.js";
export {
  QUBE_REVIEW_SERVICE_NAME,
  observeReviewParticipants,
  participantReviewerId,
  participantsBlockGateCompletion,
  participantsNeedRerun,
  participantsOnlyAwaitingHostWork,
  resolveReviewParticipants,
  rollupReviewParticipants,
} from "./review_participant.js";

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
  readonly connection?: ConnectionContract;
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

const CONNECTION_PROBE_TIMEOUT_MS = 10_000;

export const githubConnectionContract = Object.freeze({
  adapterId: "github",
  configPath: "providers.connections.github",
  authMethod: "cli-delegated",
  envVars: Object.freeze([]),
  configFields: Object.freeze([]),
  credentialUrl: "https://cli.github.com/manual/gh_auth_login",
  scopes: Object.freeze(["repo read access", "read:org when organization membership is required"]),
  probe: Object.freeze({
    id: "github-auth-status",
    name: "GitHub gh authentication",
    summary: "Ask the official GitHub CLI to verify its delegated authentication state.",
    readOnly: true,
    timeoutMs: CONNECTION_PROBE_TIMEOUT_MS,
    verifyCommand: "gh auth status",
    transport: Object.freeze({ kind: "command", command: "gh", args: Object.freeze(["auth", "status"]) }),
  }),
} as const satisfies ConnectionContract);

export const gitLabConnectionContract = Object.freeze({
  adapterId: "gitlab",
  configPath: "providers.connections.gitlab",
  authMethod: "token-env",
  envVars: Object.freeze([
    Object.freeze({ name: "GITLAB_TOKEN", sensitive: true, purpose: "Authenticate QUBE GitLab API requests." }),
  ]),
  configFields: Object.freeze([
    Object.freeze({ name: "projectId", valueType: "string", required: true, purpose: "Select the GitLab project path or numeric id.", envFallback: "GITLAB_PROJECT_ID" }),
    Object.freeze({ name: "baseUrl", valueType: "string", required: false, purpose: "Select GitLab.com or a self-managed GitLab origin.", envFallback: "GITLAB_BASE_URL", defaultValue: "https://gitlab.com" }),
  ]),
  credentialUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  scopes: Object.freeze(["api"]),
  probe: Object.freeze({
    id: "gitlab-user",
    name: "GitLab /user",
    summary: "Read the authenticated GitLab user through the REST API.",
    readOnly: true,
    timeoutMs: CONNECTION_PROBE_TIMEOUT_MS,
    verifyCommand: "qube doctor --json",
    transport: Object.freeze({
      kind: "http",
      method: "GET",
      baseUrl: Object.freeze({ configField: "baseUrl", envVar: "GITLAB_BASE_URL", defaultValue: "https://gitlab.com" }),
      path: "api/v4/user",
      headers: Object.freeze([
        Object.freeze({ name: "PRIVATE-TOKEN", value: Object.freeze({ envVar: "GITLAB_TOKEN" }) }),
      ]),
      successJsonPath: Object.freeze(["id"]),
      successValueKind: "positive-number",
    }),
  }),
} as const satisfies ConnectionContract);

export const linearConnectionContract = Object.freeze({
  adapterId: "linear",
  configPath: "providers.connections.linear",
  authMethod: "token-env",
  envVars: Object.freeze([
    Object.freeze({ name: "LINEAR_API_KEY", sensitive: true, purpose: "Authenticate QUBE Linear GraphQL requests." }),
  ]),
  configFields: Object.freeze([
    Object.freeze({ name: "teamId", valueType: "string", required: true, purpose: "Select the Linear team whose issues form the work queue.", envFallback: "LINEAR_TEAM_ID" }),
    Object.freeze({ name: "endpoint", valueType: "string", required: false, purpose: "Override the Linear GraphQL endpoint.", defaultValue: "https://api.linear.app/graphql" }),
  ]),
  credentialUrl: "https://linear.app/settings/api",
  scopes: Object.freeze(["workspace read access"]),
  probe: Object.freeze({
    id: "linear-viewer",
    name: "Linear viewer",
    summary: "Read the authenticated Linear viewer through GraphQL.",
    readOnly: true,
    timeoutMs: CONNECTION_PROBE_TIMEOUT_MS,
    verifyCommand: "qube doctor --json",
    transport: Object.freeze({
      kind: "http",
      method: "POST",
      baseUrl: Object.freeze({ configField: "endpoint", defaultValue: "https://api.linear.app/graphql" }),
      path: "",
      headers: Object.freeze([
        Object.freeze({ name: "Authorization", value: Object.freeze({ envVar: "LINEAR_API_KEY" }) }),
      ]),
      body: JSON.stringify({ query: "query QubeConnectionProbe { viewer { id name } }" }),
      successJsonPath: Object.freeze(["data", "viewer", "id"]),
      successValueKind: "non-empty-string",
    }),
  }),
} as const satisfies ConnectionContract);

export const jiraConnectionContract = Object.freeze({
  adapterId: "jira",
  configPath: "providers.connections.jira",
  authMethod: "basic-env",
  envVars: Object.freeze([
    Object.freeze({ name: "JIRA_EMAIL", sensitive: false, purpose: "Identify the Atlassian account used for API token authentication." }),
    Object.freeze({ name: "JIRA_API_TOKEN", sensitive: true, purpose: "Authenticate QUBE Jira REST requests." }),
  ]),
  configFields: Object.freeze([
    Object.freeze({ name: "baseUrl", valueType: "string", required: true, purpose: "Select the Jira Cloud site origin.", envFallback: "JIRA_BASE_URL" }),
    Object.freeze({ name: "projectKey", valueType: "string", required: false, purpose: "Select a Jira project when custom JQL is not configured.", envFallback: "JIRA_PROJECT_KEY" }),
    Object.freeze({ name: "jql", valueType: "string", required: false, purpose: "Select Jira work with a custom read query." }),
  ]),
  credentialUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
  scopes: Object.freeze(["read Jira user identity", "browse selected Jira projects"]),
  probe: Object.freeze({
    id: "jira-myself",
    name: "Jira /myself",
    summary: "Read the authenticated Jira account through the REST API.",
    readOnly: true,
    timeoutMs: CONNECTION_PROBE_TIMEOUT_MS,
    verifyCommand: "qube doctor --json",
    transport: Object.freeze({
      kind: "http",
      method: "GET",
      baseUrl: Object.freeze({ configField: "baseUrl", envVar: "JIRA_BASE_URL" }),
      path: "rest/api/3/myself",
      basicAuth: Object.freeze({
        username: Object.freeze({ envVar: "JIRA_EMAIL" }),
        password: Object.freeze({ envVar: "JIRA_API_TOKEN" }),
      }),
      successJsonPath: Object.freeze(["accountId"]),
      successValueKind: "non-empty-string",
    }),
  }),
} as const satisfies ConnectionContract);

export const jenkinsConnectionContract = Object.freeze({
  adapterId: "jenkins",
  configPath: "providers.connections.jenkins",
  authMethod: "token-env",
  envVars: Object.freeze([
    Object.freeze({ name: "JENKINS_API_TOKEN", sensitive: true, purpose: "Authenticate QUBE Jenkins API requests." }),
  ]),
  configFields: Object.freeze([
    Object.freeze({ name: "baseUrl", valueType: "string", required: true, purpose: "Select the Jenkins controller origin.", envFallback: "JENKINS_BASE_URL" }),
    Object.freeze({ name: "user", valueType: "string", required: true, purpose: "Identify the Jenkins user paired with the API token.", envFallback: "JENKINS_USER" }),
    Object.freeze({ name: "jobPath", valueType: "string", required: false, purpose: "Select the Jenkins job or folder path used for CI evidence." }),
  ]),
  credentialUrl: "<JENKINS_BASE_URL>/me/configure",
  scopes: Object.freeze(["Overall/Read", "Job/Read for configured jobs"]),
  probe: Object.freeze({
    id: "jenkins-who-am-i",
    name: "Jenkins whoAmI",
    summary: "Read the authenticated Jenkins identity through the REST API.",
    readOnly: true,
    timeoutMs: CONNECTION_PROBE_TIMEOUT_MS,
    verifyCommand: "qube doctor --json",
    transport: Object.freeze({
      kind: "http",
      method: "GET",
      baseUrl: Object.freeze({ configField: "baseUrl", envVar: "JENKINS_BASE_URL" }),
      path: "whoAmI/api/json",
      basicAuth: Object.freeze({
        username: Object.freeze({ configField: "user", envVar: "JENKINS_USER" }),
        password: Object.freeze({ envVar: "JENKINS_API_TOKEN" }),
      }),
      successBooleanPath: Object.freeze(["authenticated"]),
    }),
  }),
} as const satisfies ConnectionContract);

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
    adapterCapability("review-stats", "supported", "@tjalve/qube-adapter-github", "List a bounded recent pull request window and read trusted QUBE lane review history for convergence statistics."),
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
  connection: githubConnectionContract,
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
    "gitlab-merge-request-review-forge",
    "gitlab-pipeline-status",
    "gitlab-review-notes",
    "gitlab-discussion-resolution",
    "self-managed-url-handling",
    "unsupported-lifecycle-reporting",
    "credential-diagnostics",
  ],
  boundary: "GitLab API access, issue mapping, draft rendering, merge request review state, discussion resolution, pipeline diagnostics, provider-visible review-note publishing, capability flags, credential diagnostics, self-managed URL handling, and unsupported lifecycle reporting live in this optional adapter package.",
  capabilities: Object.freeze([
    adapterCapability("map-work-item", "supported", "@tjalve/qube-adapter-gitlab", "Map GitLab issues, labels, milestones, assignees, task completion, issue links, blockers, and source metadata into QUBE work items."),
    adapterCapability("work-item-queue", "supported", "@tjalve/qube-adapter-gitlab", "Read paginated GitLab project issues through GitLab.com or self-managed GitLab REST APIs and normalize reverse blocker links for queue ordering."),
    adapterCapability("render-work-items", "supported", "@tjalve/qube-adapter-gitlab", "Render provider-neutral AIB work item drafts into GitLab issue previews without mutating GitLab."),
    adapterCapability("load-merge-request", "supported", "@tjalve/qube-adapter-gitlab", "Read GitLab merge request state, mergeability, reviewers, discussions, provider-visible review notes, and closing issue references."),
    adapterCapability("request-review-gate", "supported", "@tjalve/qube-adapter-gitlab", "Request configured review participants by posting provider-visible GitLab merge request notes with stable trusted metadata."),
    adapterCapability("read-ci-status", "supported", "@tjalve/qube-adapter-gitlab", "Normalize GitLab merge request head pipeline status into trusted provider gate evidence."),
    adapterCapability("diagnose-ci-status", "supported", "@tjalve/qube-adapter-gitlab", "Report whether GitLab merge request pipeline evidence maps to the current head, failed, skipped, pending, or unknown status."),
    adapterCapability("publish-lane-review", "supported", "@tjalve/qube-adapter-gitlab", "Publish local review lane feedback as provider-visible GitLab merge request notes with stable trusted metadata."),
    adapterCapability("resolve-review-threads", "supported", "@tjalve/qube-adapter-gitlab", "Resolve GitLab merge request discussions selected from provider-visible review-thread state."),
    adapterCapability("sync-issue-status", "unsupported", "@tjalve/qube-adapter-gitlab", "GitLab issue lifecycle, merge request approval, merge, and pipeline mutation behavior require explicit mutation adapters and are reported as unsupported."),
  ]),
  connection: gitLabConnectionContract,
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
  connection: linearConnectionContract,
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
  connection: jiraConnectionContract,
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
  connection: jenkinsConnectionContract,
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

export const claudeCodeAdapterContract = defineQubeAdapter({
  id: "claude-code",
  packageName: "@tjalve/qube-adapter-claude-code",
  surface: "claude-code",
  owns: ["host-detection", "instruction-targets", "todo-tools", "hooks", "slash-command-boundaries", "unsupported-capability-reporting"],
  boundary: "Claude Code host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: Object.freeze([
    adapterCapability("detect-host", "supported", "@tjalve/qube-adapter-claude-code", "Detect Claude Code-oriented repository instructions from CLAUDE.md and .claude assets without assuming Codex or OpenCode assets."),
    adapterCapability("read-instructions", "supported", "@tjalve/aib and @tjalve/aie", "Claude Code project instructions use CLAUDE.md with repository policy precedence."),
    adapterCapability("inspect-repository-state", "supported", "@tjalve/aie", "Executor checks branch policy, worktree state, base-branch freshness, and blocking pull requests before issue work."),
    adapterCapability("use-task-state", "standalone", "Claude Code host", "Claude Code todo state is host session state; durable QUBE state stays in GitHub issues, pull requests, and .qube artifacts."),
    adapterCapability("run-commands", "standalone", "Claude Code host", "Claude Code command execution follows the active permission mode, settings, hooks, and repository policy."),
    adapterCapability("use-hooks", "standalone", "Claude Code host", "Claude Code hooks are configured through host settings and can observe lifecycle events such as tool use and Stop."),
    adapterCapability("use-slash-commands", "standalone", "Claude Code host", "Claude Code slash commands and skills are host customization assets, separate from Codex AGENTS.md and OpenCode project commands."),
    adapterCapability("use-subagents", "standalone", "Claude Code host", "Claude Code can delegate bounded work to subagents, but protected QUBE issue workflow state stays in the main session."),
    adapterCapability("continue-session", "standalone", "Claude Code host", "Claude Code can continue or resume host conversations, while QUBE continuation remains anchored in provider and .qube state."),
    adapterCapability("install-slash-command", "unsupported", "@tjalve/qube-adapter-claude-code", "QUBE composer install notes do not create Claude Code slash command or skill assets."),
    adapterCapability("request-external-review", "unsupported", "@tjalve/aie", "Claude Code host support does not directly invoke configured external PR reviewers."),
    adapterCapability("create-git-branch", "unsupported", "@tjalve/aie repository provider", "Claude Code host support does not bypass QUBE branch policy."),
    adapterCapability("open-pull-request", "unsupported", "@tjalve/aie GitHub provider", "Claude Code host support does not open pull requests without the configured repository workflow."),
  ]),
  contractOnly: false,
} satisfies QubeAdapterContract);

export const opencodeAdapterContract = defineQubeAdapter({
  id: "opencode",
  packageName: "@tjalve/qube-adapter-opencode",
  surface: "opencode",
  owns: ["host-detection", "instruction-targets", "project-commands", "todo-tools", "session-prompts", "stop-hooks", "local-review-probes", "unsupported-capability-reporting"],
  boundary: "OpenCode host behavior stays at the adapter edge; product packages consume explicit capability records and own product-specific side effects.",
  capabilities: Object.freeze([
    adapterCapability("detect-host", "supported", "@tjalve/qube-adapter-opencode", "Detect OpenCode repository affordances from AGENTS.md and .opencode/commands."),
    adapterCapability("read-instructions", "supported", "@tjalve/aib and @tjalve/aie", "OpenCode reads AGENTS.md as the repository instruction target for QUBE workflows."),
    adapterCapability("install-project-command", "supported", "@tjalve/aib and @tjalve/aie", "AIB and AIE install concrete OpenCode project commands under .opencode/commands."),
    adapterCapability("use-todos", "supported", "OpenCode host", "OpenCode todo state is available through host todo tools, not through a hidden adapter store."),
    adapterCapability("probe-local-review-runner", "unsupported", "@tjalve/qube-adapter-opencode", "OpenCode local-host review lanes require a tested independent fresh-context host task API; the adapter reports the unsupported boundary explicitly."),
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

export function defineQubeAdapter<T extends QubeAdapterContract>(adapter: T): Readonly<T> {
  return Object.freeze({ ...adapter });
}

export * from "./work_queue.js";
