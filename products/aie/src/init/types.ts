import type { CiProviderKind, GateConfig, GitHubReviewPublisherConfig, InstructionConfig, MilestoneOrderingConfig, ReviewProviderKind, SupplyChainConfig, WorkProviderKind } from '../config/index.js';
import type { ModelRoutingPolicy, ModelRoutingResolution } from '../core/model_routing.js';
import type { ReviewAdapterKind, ReviewFailoverPolicy, ReviewLanePolicy, ReviewMode, ReviewModelsPolicy, ReviewProfileKind, ReviewRoutePolicy } from '../core/policy.js';
import type { InitTool } from '../init_content.js';

export type InitActionStatus = 'planned' | 'completed' | 'skipped' | 'blocked' | 'failed';
export type InitActionOperation = 'create' | 'append' | 'replace-managed' | 'replace-file' | 'update-config' | 'unchanged' | 'blocked';
export interface InitAction {
  id: string;
  path: string;
  kind: 'config' | 'instruction' | 'command' | 'skill' | 'subagent';
  operation: InitActionOperation;
  status: InitActionStatus;
  managedSection: boolean;
  conflict: boolean;
  reason: string;
}

export type InitQuestionId = 'review-mode' | 'reviewers' | 'review-models' | 'publisher' | 'quality-gate' | 'ui-audit' | 'ui-audit-evidence' | 'attribution-hygiene';

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
  qualityControl: boolean;
  manualUiAudit: boolean;
  tools: InitTool[];
}

export interface InitPostAction {
  id: 'github-app-publisher-setup';
  command: string;
  reason: string;
}

export interface InitProviderAction {
  id: 'labels-setup';
  provider: 'github';
  command: 'qube aie labels setup';
  labels: Array<{ name: string; color: string; description: string }>;
  reason: string;
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
  postInitActions: InitPostAction[];
  providerActions: InitProviderAction[];
}

export interface InitPolicySummary {
  namingRules: boolean;
  milestoneOrdering: boolean;
  missingMilestonePolicy: string;
  supplyChainSafety: boolean;
  projectPackageManagerDefaults: boolean;
  autonomousMode: boolean;
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
  reviewProfile?: ReviewProfileKind;
  reviewLanes?: ReviewLanePolicy[];
  reviewModels?: ReviewModelsPolicy;
  reviewRoute?: ReviewRoutePolicy | null;
  reviewFailover?: ReviewFailoverPolicy | null;
  localReviewAgents?: string[];
  /** Normal-setup adapter ids. Init resolves these through the active provider adapter registry. */
  reviewAgentSelections?: string[];
  /** Normal-setup harness ids. Init validates native review support before writing config. */
  localReviewAgentSelections?: string[];
  /** Selected harness for isolated review. Init validates the selected host profile before writing config. */
  isolatedReviewAgent?: string;
  /** Normal-setup host:model values. Init writes only values found in a live host catalog. */
  reviewModelSelections?: string[];
  publisher?: GitHubReviewPublisherConfig;
  /** Publisher choice that can require a separate credential setup command. */
  publisherIntent?: 'user' | 'github-app';
  /** Scope used only for a matching Reviewer App setup follow-up. */
  publisherConfigScope?: 'repo' | 'global';
  manualUiAudit?: boolean;
  uiAuditAppLaunch?: string;
  uiAuditTarget?: string;
  uiAuditEvidenceRoot?: string;
  gates?: GateConfig[];
  qualityControl?: boolean;
  instructions?: Partial<InstructionConfig>;
  supplyChain?: Partial<SupplyChainConfig>;
  /** Selected primary harness for a fresh unpinned model-routing entry. */
  primaryHost?: InitTool;
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
  homeDirectory?: string;
  /** Allow a dry-run plan to treat the selected directory as a prospective repository root before Git metadata exists. */
  prospectiveRoot?: boolean;
}
