import type { ExecutorPolicy, MigrationPolicy, ReviewAdapterKind, ReviewContextSources, ReviewFailoverPolicy, ReviewLanePolicy, ReviewModelsPolicy, ReviewMode, ReviewProfileKind, ReviewPromptFragments, ReviewRoutePolicy, ReviewSeverityThreshold, ShippingPolicy } from '../core/policy.js';
import type { ModelRoutingPolicy } from '../core/model_routing.js';

export const DEFAULT_CONFIG_VERSION = 1;

export type WorkProviderKind = 'github' | 'gitlab' | 'linear' | 'jira';
export type ReviewProviderKind = 'github' | 'gitlab';
export type RepositoryProviderKind = 'local-git';
export type CiProviderKind = 'github' | 'gitlab' | 'jenkins';
export type LayoutProviderKind = 'local';
export type ConnectionProviderKind = 'github' | 'gitlab' | 'linear' | 'jira' | 'jenkins';

export interface ProviderSelection<K extends string> {
  kind: K;
  /**
   * Optional non-secret connection fields for provider probes (base URL, project id, team id, user).
   * Secrets stay in environment variables; never store tokens here.
   */
  connection?: Record<string, string>;
}

export type GitHubReviewPublisherMode = 'user' | 'github-app' | 'token';

export interface GitHubAppPublisherConfig {
  appId: string;
  installationId: string;
  /** Local filesystem path to the GitHub App private key. Never store key material here. */
  privateKeyPath?: string;
  /** Environment variable name that holds the private key PEM. Never store key material here. */
  privateKeyEnv?: string;
  /** Optional public bot login for load-path trust matching only (not a secret). */
  login?: string;
}

export interface GitHubTokenPublisherConfig {
  /** Environment variable name that holds a fine-grained personal access token. */
  env: string;
  /** Optional public login for load-path trust matching only (not a secret). */
  login?: string;
}

export interface GitHubReviewPublisherConfig {
  mode: GitHubReviewPublisherMode;
  githubApp?: GitHubAppPublisherConfig;
  token?: GitHubTokenPublisherConfig;
}

export interface ReviewProviderSelection extends ProviderSelection<ReviewProviderKind> {
  /** GitHub-only reviewer identity used for provider-visible publish, not for host review compute. */
  publisher?: GitHubReviewPublisherConfig;
}

export type JiraWorkStatus = 'in-progress' | 'ready' | 'blocked' | 'unknown';
export type JiraWorkPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';
export type JiraLinkRelation = 'blocker' | 'blockedBy' | 'ignore';

export interface JiraIssueLinkRuleConfig {
  typeName: string;
  inward: JiraLinkRelation;
  outward: JiraLinkRelation;
}

export interface JiraWorkflowSchemaConfig {
  statusMap?: Record<string, JiraWorkStatus>;
  openStatusNames?: string[];
  closedStatusNames?: string[];
  priorityMap?: Record<string, JiraWorkPriority>;
  linkRules?: JiraIssueLinkRuleConfig[];
  sprintField?: string;
  epicField?: string;
}

export interface JiraWorkProviderConfig {
  projectKey?: string;
  jql?: string;
  requestTimeoutMs?: number;
  workflowSchema?: JiraWorkflowSchemaConfig;
}

export interface WorkProviderSelection extends ProviderSelection<WorkProviderKind> {
  jira?: JiraWorkProviderConfig;
}

export interface ProviderCapabilityPolicy {
  work: boolean;
  review: boolean;
  repository: boolean;
  ci: boolean;
  layout: boolean;
}

export interface ProviderSelections {
  work: WorkProviderSelection;
  review: ReviewProviderSelection;
  repository: ProviderSelection<RepositoryProviderKind>;
  ci: ProviderSelection<CiProviderKind>;
  layout: ProviderSelection<LayoutProviderKind>;
  /** Probe-only connections, including adapters that are not selectable for runtime roles yet. */
  connections: Partial<Record<ConnectionProviderKind, Record<string, string>>>;
  capabilities: ProviderCapabilityPolicy;
}

export type MissingMilestonePolicy = 'ignore' | 'warn' | 'block';
export type GateKind = 'build' | 'lint' | 'typecheck' | 'unit' | 'integration' | 'e2e' | 'custom' | 'aiq';
export type GateStage = 'all' | 'pre-pr' | 'pre-merge';

export interface GateConfig {
  name: string;
  kind: GateKind;
  command: string;
  stage: GateStage;
  required: boolean;
  timeoutSeconds: number;
  workingDirectory: string;
  env: Record<string, string>;
  externalService: boolean;
}

export interface MilestoneOrderingConfig {
  enabled: boolean;
  order: string[];
  missingAssignment: MissingMilestonePolicy;
}

export interface LabelConfig {
  priorities: string[];
  statuses: string[];
  components: string[];
}

export interface BranchConfig {
  naming: string;
  baseBranch: string;
  baseRemote: string;
  noWorktree: boolean;
  blockOnOpenPRs: boolean;
  requireBaseBranchFreshness: boolean;
  ignoredAutomationAuthors: string[];
}

export interface LifecycleConfig {
  assignOnStart: boolean;
  commentOnStart: boolean;
}

/** A lane source expects trusted per-lane host review markers; a reviewer source expects provider reviewer state, either a trusted marker comment or a plain provider review. */
export type ReviewSourceIdentity = 'lane' | 'reviewer';
export type ReviewSourceMarkers = 'trusted' | 'provider';

export interface ReviewSourceConfig {
  id: string;
  identity: ReviewSourceIdentity;
  expected: string[];
  blocking: boolean;
  markers: ReviewSourceMarkers;
  enabled: boolean;
}

export interface ReviewConfig {
  adapter: ReviewAdapterKind;
  mode: ReviewMode | null;
  profile: ReviewProfileKind;
  severityThreshold: ReviewSeverityThreshold;
  promptFragments: ReviewPromptFragments;
  contextSources: ReviewContextSources;
  lanes: ReviewLanePolicy[];
  sources: ReviewSourceConfig[];
  agents: string[];
  localAgents: string[];
  waitMinutes: number;
  concurrency: number;
  requestText: string;
  carryForwardPublish: 'note' | 'none';
  nitCap: number;
  deltaFullEvery: number;
  models: ReviewModelsPolicy;
  route: ReviewRoutePolicy | null;
  failover: ReviewFailoverPolicy | null;
}

export interface FocusedGateSelector {
  glob: string;
  commands: string[];
}

export interface GatePolicyConfig {
  definitions: GateConfig[];
  qualityGates: string[];
  qualityControl: boolean;
  focusedSelectors: FocusedGateSelector[];
}

export interface AuditConfig {
  manualUiAudit: boolean;
  appLaunch: string;
  target: string;
  evidenceRoot: string;
}

export interface InstructionConfig {
  opencodeCommandAlias: boolean;
  namingRules: boolean;
  promptInjectionWarning: boolean;
  noCreditWarning: boolean;
  implementationGuardrails: boolean;
  supplyChainSafety: boolean;
}

export interface SupplyChainConfig {
  exactVersions: boolean;
  intentionalLockfileChanges: boolean;
  disableLifecycleScripts: boolean;
  pinCiActions: boolean;
  packageAgeDays: number;
  highRiskPackageAgeDays: number;
  requireApprovalForUnverifiedRisk: boolean;
  writePackageManagerDefaults: boolean;
}

export interface MigrationConfig extends MigrationPolicy {}

export interface ConfigFilePolicy {
  labels: LabelConfig;
  milestoneOrdering: MilestoneOrderingConfig;
  branch: BranchConfig;
  lifecycle: LifecycleConfig;
  shipping: ShippingPolicy;
  reviews: ReviewConfig;
  gates: GatePolicyConfig;
  audit: AuditConfig;
  instructions: InstructionConfig;
  migration: MigrationConfig;
  supplyChain: SupplyChainConfig;
  modelRouting: ModelRoutingPolicy;
}

export interface ConfigFileShape {
  version: number;
  providers: ProviderSelections;
  policy: ConfigFilePolicy;
}

export interface Config extends ConfigFileShape {
  normalizedPolicy: ExecutorPolicy;
  priorityLabels: string[];
  statusLabels: string[];
  componentLabels: string[];
  milestoneOrdering: MilestoneOrderingConfig;
  branchNaming: string;
  baseBranch: string;
  baseRemote: string;
  noWorktree: boolean;
  blockOnOpenPRs: boolean;
  requireBaseBranchFreshness: boolean;
  autonomousMode: boolean;
  assignOnStart: boolean;
  commentOnStart: boolean;
  ignoredAutomationAuthors: string[];
  reviewAgents: string[];
  reviewAdapter: ReviewAdapterKind;
  reviewMode: ReviewMode | null;
  reviewProfile: ReviewProfileKind;
  reviewSeverityThreshold: ReviewSeverityThreshold;
  reviewPromptFragments: ReviewPromptFragments;
  reviewContextSources: ReviewContextSources;
  reviewLanes: ReviewLanePolicy[];
  reviewSources: ReviewSourceConfig[];
  localReviewAgents: string[];
  reviewWaitMinutes: number;
  reviewConcurrency: number;
  reviewRequestText: string;
  reviewCarryForwardPublish: 'note' | 'none';
  reviewNitCap: number;
  reviewModels: ReviewModelsPolicy;
  modelRouting: ModelRoutingPolicy;
  reviewRoute: ReviewRoutePolicy | null;
  reviewFailover: ReviewFailoverPolicy | null;
  opencodeCommandAlias: boolean;
  manualUiAudit: boolean;
  uiAuditAppLaunch: string;
  uiAuditTarget: string;
  uiAuditEvidenceRoot: string;
  gates: GateConfig[];
  qualityGates: string[];
  qualityControl: boolean;
  focusedSelectors: FocusedGateSelector[];
  instructions: InstructionConfig;
  supplyChain: SupplyChainConfig;
  migration: MigrationConfig;
}

export interface ValidationError {
  kind: 'missing' | 'invalid' | 'unknown' | 'duplicate';
  path: string;
  message: string;
  suggestion?: string;
}

export interface ConfigValidationResult {
  ok: boolean;
  errors: ValidationError[];
  config?: Config;
}

export interface ConfigLoadResult {
  root: string;
  path: string;
  present: boolean;
  ok: boolean;
  errors: ValidationError[];
  config?: Config;
}

export class ConfigLoadError extends Error {
  readonly path: string;
  readonly errors: ValidationError[];

  constructor(path: string, errors: ValidationError[]) {
    const first = errors[0];
    super(
      first
        ? `Failed to load Executor config from ${path}: invalid value at ${first.path}. Likely cause: ${first.message}. Next action: run \`aie init . --dry-run --force\` to compare the file with the current config shape.`
        : `Failed to load Executor config from ${path}: validation failed without details. Next action: run \`aie init . --dry-run --force\` to compare the file with the current config shape.`,
    );
    this.name = 'ConfigLoadError';
    this.path = path;
    this.errors = errors.map(error => ({ ...error }));
  }
}
