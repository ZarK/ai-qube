import type { ExecutorPolicy, MigrationPolicy, ShippingPolicy } from '../core/policy';

export const DEFAULT_CONFIG_VERSION = 1;

export type WorkProviderKind = 'github';
export type ReviewProviderKind = 'github';
export type RepositoryProviderKind = 'local-git';
export type CiProviderKind = 'github';
export type LayoutProviderKind = 'local';

export interface ProviderSelection<K extends string> {
  kind: K;
}

export interface ProviderCapabilityPolicy {
  work: boolean;
  review: boolean;
  repository: boolean;
  ci: boolean;
  layout: boolean;
}

export interface ProviderSelections {
  work: ProviderSelection<WorkProviderKind>;
  review: ProviderSelection<ReviewProviderKind>;
  repository: ProviderSelection<RepositoryProviderKind>;
  ci: ProviderSelection<CiProviderKind>;
  layout: ProviderSelection<LayoutProviderKind>;
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

export interface ReviewConfig {
  agents: string[];
  waitMinutes: number;
  requestText: string;
}

export interface GatePolicyConfig {
  definitions: GateConfig[];
  qualityGates: string[];
  qualityControl: boolean;
}

export interface AuditConfig {
  manualUiAudit: boolean;
  appLaunch: string;
  target: string;
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
  reviewWaitMinutes: number;
  reviewRequestText: string;
  opencodeCommandAlias: boolean;
  manualUiAudit: boolean;
  uiAuditAppLaunch: string;
  uiAuditTarget: string;
  gates: GateConfig[];
  qualityGates: string[];
  qualityControl: boolean;
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
