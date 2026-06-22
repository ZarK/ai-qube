import type { GateKind, GateStage, ValidationError } from '../config/index.js';
import type { LegacyState } from '../init/index.js';
import type { BaseRefStatus, InstructionStatus, IssueMilestoneWarning, MilestoneSummary, PlanningStatus, PullRequestSummary } from '../repo/index.js';
import type { GateStatusResult } from '../gates/index.js';
import type { MigrationReadinessDiagnostics } from '../migration_diagnostics.js';

export interface DoctorDiagnostics {
  ok: boolean;
  command: string;
  cwd: string;
  isRepo: boolean;
  nodeVersion: string;
  nodeSatisfies: boolean;
  git: boolean;
  gh: boolean;
  ghAuthenticated: boolean;
  currentBranch: string;
  isWorktree: boolean;
  configPresent: boolean;
  configValid: boolean;
  configErrors?: ValidationError[];
  baseBranch?: string;
  baseRemote?: string;
  labelsOk: boolean;
  labelsMissing: string[];
  labelsDrifted: string[];
  labelsDuplicates: string[];
  labelsError?: string;
  queueDriftCount: number;
  queueMultipleInProgress: boolean;
  queueError?: string;
  lifecycle: LifecycleDiagnostics;
  instructions: InstructionStatus;
  planning: PlanningStatus;
  legacy: LegacyState[];
  providerHealth: ProviderHealthDiagnostics;
  instructionPolicy: InstructionPolicyDiagnostics;
  repositoryPolicy: RepositoryPolicyDiagnostics;
  gateReadiness: GateReadinessDiagnostics;
  migrationReadiness: MigrationReadinessDiagnostics;
  baseRef: BaseRefStatus;
  openPullRequests: PullRequestSummary[];
  blockingPullRequests: PullRequestSummary[];
  pullRequestError?: string;
  milestones: MilestoneSummary[];
  milestoneWarnings: IssueMilestoneWarning[];
  milestoneError?: string;
  timestamp: string;
  recommendations: string[];
  nextCommand: string;
}

export interface InstallCheck {
  configured: boolean;
  installed: boolean;
}

export interface InstructionPolicyDiagnostics {
  namingRules: InstallCheck;
  promptInjectionWarning: InstallCheck;
  noCreditWarning: InstallCheck;
  implementationGuardrails: InstallCheck;
  supplyChainSafety: InstallCheck;
  canonicalSupplyChainGuard: InstallCheck;
}

export interface ProviderHealthDiagnostics {
  providers: {
    work: { kind: string; supported: boolean; required: boolean };
    review: { kind: string; supported: boolean; required: boolean };
    repository: { kind: string; supported: boolean; required: boolean };
    ci: { kind: string; supported: boolean; required: boolean };
    layout: { kind: string; supported: boolean; required: boolean };
  };
  normalizedPolicy: {
    priorityLabels: number;
    statusLabels: number;
    componentLabels: number;
    baseRef: string;
    configuredGates: number;
    reviewAgents: number;
  };
  warnings: string[];
}

export interface RepositoryPolicyDiagnostics {
  noWorktree: boolean;
  blockOnOpenPRs: boolean;
  requireBaseBranchFreshness: boolean;
  baseBranch: string;
  baseRemote: string;
  milestoneOrdering: boolean;
  missingMilestonePolicy: string;
  supplyChain: {
    exactVersions: boolean;
    intentionalLockfileChanges: boolean;
    disableLifecycleScripts: boolean;
    pinCiActions: boolean;
    packageAgeDays: number;
    highRiskPackageAgeDays: number;
    requireApprovalForUnverifiedRisk: boolean;
    writePackageManagerDefaults: boolean;
  };
}

export interface LifecycleDiagnostics {
  branchNamingValid: boolean;
  inProgressIssueCount: number;
  activeIssueNumber: number | null;
  activeIssueBranch: string | null;
  currentBranchMatchesActiveIssue: boolean | null;
  linkedWorktreeBlocked: boolean;
  openPullRequestCheckEnabled: boolean;
  baseBranchFresh: boolean;
  queueError?: string;
  lifecycleCommandsReady: boolean;
}

export type DoctorReadinessStatus = 'ready' | 'disabled' | 'missing' | 'needs-action' | 'unavailable';

export interface DoctorToolAvailability {
  command: string;
  available: boolean;
  required: boolean;
  nextAction: string | null;
}

export interface GateReadinessDiagnostics {
  gates: {
    configured: number;
    required: number;
    advisory: number;
    byStage: Record<GateStage, number>;
    byKind: Record<GateKind, number>;
    invalidCommands: string[];
    supplyChainSensitive: number;
    supplyChainSensitiveGates: string[];
    externalServiceGates: string[];
    externalServices: string[];
    evidence: GateStatusResult['summary'];
    gateEvidence: Array<{
      name: string;
      status: string;
      source: string;
      trust: string;
      reasonCode: string;
      verified: boolean;
    }>;
  };
  audit: {
    manualUiAudit: boolean;
    readiness: DoctorReadinessStatus;
    agentBrowser: DoctorToolAvailability;
    fallbackBrowserAutomation: DoctorToolAvailability;
    appLaunchConfigured: boolean;
    auditTargetConfigured: boolean;
    screenshotUpload: 'disabled';
  };
  reviewAgent: {
    required: boolean;
    readiness: DoctorReadinessStatus;
    adapter: string;
    profile: string;
    severityThreshold: string;
    reviewers: string[];
    localReviewers: string[];
    configuredProfiles: string[];
    requiredLanes: string[];
    configuredLanes: string[];
    promptFragments: {
      repository: string[];
      safety: string[];
      style: string[];
      adapter: string[];
      reviewer: string[];
      commandAddendum: string[];
    };
    contextSources: {
      instructions: string[];
      requirements: string[];
      issues: string;
      issueComments: string;
      linkedIssues: string;
      milestones: string;
      pullRequests: string;
      prComments: string;
      reviewThreads: string;
    };
    defaultOracle: boolean;
    fallbackPromptAvailable: boolean;
    localEvidenceRoot: string;
    localRunner: {
      configured: boolean;
      readiness: DoctorReadinessStatus;
      command: string | null;
      capabilities: {
        canRun: boolean;
        canComment: boolean;
        canInline: boolean;
        canUseTools: boolean;
        canRunShell: boolean;
        canUseBrowser: boolean;
        canReadMcp: boolean;
        canAccessNetwork: boolean;
        canWriteEvidence: boolean;
        supportsJson: boolean;
        supportsPromptStack: boolean;
        supportsIncrementalReview: boolean;
      };
      missingTools: string[];
      nextAction: string;
    };
    externalServices: string[];
    reviewWaitMinutes: number;
  };
  prReview: {
    readiness: DoctorReadinessStatus;
    ghAuthenticated: boolean;
    adapter: string;
    profile: string;
    reviewers: string[];
    localReviewers: string[];
    localEvidenceRoot: string;
    localRunnerReadiness: DoctorReadinessStatus;
    externalServices: string[];
    reviewWaitMinutes: number;
  };
  aiq: {
    enabled: boolean;
    configured: boolean;
    readiness: DoctorReadinessStatus;
    tool: DoctorToolAvailability;
    configuredCommands: string[];
  };
  supplyChain: {
    policyConfigured: boolean;
    exactVersions: boolean;
    intentionalLockfileChanges: boolean;
    disableLifecycleScripts: boolean;
    pinCiActions: boolean;
    packageAgeDays: number;
    highRiskPackageAgeDays: number;
    requireApprovalForUnverifiedRisk: boolean;
    writePackageManagerDefaults: boolean;
    supplyChainSensitiveGates: string[];
    readiness: DoctorReadinessStatus;
  };
  externalServices: string[];
}

export interface DoctorOkInputs {
  isRepo: boolean;
  configValid: boolean;
  gitAvailable: boolean;
  ghAvailable: boolean;
  nodeSatisfies: boolean;
  isWorktree: boolean;
  noWorktreePolicy?: boolean;
  requireBaseBranchFreshness?: boolean;
  blockOnOpenPRs?: boolean;
  labelsOk: boolean;
  queueDriftCount: number;
  queueMultipleInProgress: boolean;
  queueError?: string;
  baseRef: BaseRefStatus;
  blockingPullRequestCount: number;
  pullRequestError?: string;
  instructionInstallOk?: boolean;
}
