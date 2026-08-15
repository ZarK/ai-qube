import type { CiProviderKind, GateConfig, GitHubReviewPublisherConfig, InstructionConfig, MigrationConfig, MilestoneOrderingConfig, ReviewProviderKind, SupplyChainConfig, WorkProviderKind } from '../config/index.js';
import type { ModelRoutingPolicy, ModelRoutingResolution } from '../core/model_routing.js';
import type { ReviewAdapterKind, ReviewFailoverPolicy, ReviewMode, ReviewModelsPolicy, ReviewRoutePolicy } from '../core/policy.js';
import type { InitTool } from '../init_content.js';
import type { LegacyCategory } from '../legacy.js';

export type InitActionStatus = 'planned' | 'completed' | 'skipped' | 'blocked' | 'failed';
export type InitActionOperation = 'create' | 'append' | 'replace-managed' | 'replace-file' | 'update-config' | 'unchanged' | 'blocked';
export type { LegacyCategory } from '../legacy.js';
export type LegacyChoice = 'leave-untouched' | 'install-alongside' | 'install-compatibility-wrappers' | 'cleanup-and-replace' | 'defer-to-migration';

export interface InitAction {
  id: string;
  path: string;
  kind: 'config' | 'instruction' | 'command' | 'legacy';
  operation: InitActionOperation;
  status: InitActionStatus;
  managedSection: boolean;
  conflict: boolean;
  reason: string;
}

export interface LegacyState {
  category: LegacyCategory;
  paths: string[];
  action: LegacyChoice;
  choices: LegacyChoice[];
  reason: string;
  nextCommand: string;
}

export type InitQuestionId = 'review-mode' | 'reviewers' | 'publisher' | 'quality-gate' | 'ui-audit';

export interface InitQuestionOption {
  value: string;
  label: string;
  available?: boolean;
}

export interface InitQuestion {
  id: InitQuestionId;
  prompt: string;
  options: InitQuestionOption[];
  recommendation: string;
  recommendedValue: string | string[] | boolean | null;
  answered: boolean;
  value: string | string[] | boolean | null;
  reason: string;
}

export interface InitSetupSummary {
  reviewMode: ReviewMode;
  reviewers: string[];
  publisher: string;
  qualityGates: string[];
  qualityControl: boolean;
  manualUiAudit: boolean;
  tools: InitTool[];
}

export interface InitFromReport {
  source: string;
  kind: 'path' | 'repo';
  sourceDigest: string;
  adjustments: string[];
}

export interface InitResult {
  ok: boolean;
  command: 'init';
  dryRun: boolean;
  forced: boolean;
  target: string;
  repoRoot: string | null;
  selectedTools: InitTool[];
  policy: InitPolicySummary;
  configPath: string;
  actions: InitAction[];
  legacy: LegacyState[];
  plannedChanges: string[];
  completedChanges: string[];
  skippedActions: string[];
  warnings: string[];
  errors: string[];
  nextCommand: string;
  modelRouting?: ModelRoutingResolution;
  questions: InitQuestion[];
  unansweredQuestionIds: InitQuestionId[];
  setupSummary: InitSetupSummary | null;
  from: InitFromReport | null;
  awaitingAnswers: boolean;
}

export interface InitPolicySummary {
  namingRules: boolean;
  milestoneOrdering: boolean;
  missingMilestonePolicy: string;
  supplyChainSafety: boolean;
  projectPackageManagerDefaults: boolean;
  autonomousMode: boolean;
  opencodeCommandAlias: boolean;
}

export interface InitPolicyOptions {
  workProvider?: WorkProviderKind;
  reviewProvider?: ReviewProviderKind;
  ciProvider?: CiProviderKind;
  priorityLabels?: string[];
  statusLabels?: string[];
  componentLabels?: string[];
  milestoneOrdering?: Partial<MilestoneOrderingConfig>;
  branchNaming?: string;
  baseBranch?: string;
  baseRemote?: string;
  noWorktree?: boolean;
  blockOnOpenPRs?: boolean;
  requireBaseBranchFreshness?: boolean;
  autonomousMode?: boolean;
  assignOnStart?: boolean;
  commentOnStart?: boolean;
  ignoredAutomationAuthors?: string[];
  reviewAgents?: string[];
  reviewWaitMinutes?: number;
  reviewRequestText?: string;
  reviewMode?: ReviewMode;
  reviewAdapter?: ReviewAdapterKind;
  reviewModels?: ReviewModelsPolicy;
  reviewRoute?: ReviewRoutePolicy | null;
  reviewFailover?: ReviewFailoverPolicy | null;
  localReviewAgents?: string[];
  publisher?: GitHubReviewPublisherConfig;
  opencodeCommandAlias?: boolean;
  manualUiAudit?: boolean;
  uiAuditAppLaunch?: string;
  uiAuditTarget?: string;
  gates?: GateConfig[];
  qualityGates?: string[];
  qualityControl?: boolean;
  instructions?: Partial<InstructionConfig>;
  migration?: Partial<MigrationConfig>;
  supplyChain?: Partial<SupplyChainConfig>;
  modelRouting?: ModelRoutingPolicy;
}

export interface InitOptions {
  target: string;
  tool: string;
  dryRun: boolean;
  force: boolean;
  policy?: InitPolicyOptions;
  cwd?: string;
  from?: string;
  yes?: boolean;
  useDefaults?: boolean;
  guide?: boolean;
  fetchRepoConfig?: (slug: string) => Promise<string>;
  installedHosts?: readonly string[];
  agentBrowserAvailable?: boolean;
  aiqAvailable?: boolean;
}
