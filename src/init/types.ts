import type { GateConfig, InstructionConfig, MigrationConfig, MilestoneOrderingConfig, SupplyChainConfig } from '../config';
import type { InitTool } from '../init_content';
import type { LegacyCategory } from '../legacy';

export type InitActionStatus = 'planned' | 'completed' | 'skipped' | 'blocked' | 'failed';
export type InitActionOperation = 'create' | 'append' | 'replace-managed' | 'replace-file' | 'update-config' | 'unchanged' | 'blocked';
export type { LegacyCategory } from '../legacy';
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
}

export interface InitOptions {
  target: string;
  tool: string;
  dryRun: boolean;
  force: boolean;
  policy?: InitPolicyOptions;
  cwd?: string;
}
