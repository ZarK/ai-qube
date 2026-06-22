import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { suggestBranchName, validateBranchPattern } from '../branch.js';
import type { Config, GateKind, GateStage } from '../config/index.js';
import type { BaseRefStatus } from '../repo/index.js';
import type { GitHubIssue } from '../github.js';
import { MANAGED_START } from '../managed_file.js';
import { buildGatePlan, buildGateStatus, configuredGates } from '../gates/index.js';
import { redact } from '../gh.js';
import { getInstructionTargetPaths } from '../agent_hosts.js';
import { hasCanonicalSupplyChainGuardInstruction } from '../supply_chain_guard.js';
import { requiredLocalReviewLanes } from '../local_review_evidence.js';
export type { DoctorDiagnostics, DoctorOkInputs, DoctorReadinessStatus, DoctorToolAvailability, GateReadinessDiagnostics, InstallCheck, InstructionPolicyDiagnostics, LifecycleDiagnostics, ProviderHealthDiagnostics, RepositoryPolicyDiagnostics } from './types.js';
import type { DoctorOkInputs, DoctorReadinessStatus, DoctorToolAvailability, GateReadinessDiagnostics, InstallCheck, InstructionPolicyDiagnostics, LifecycleDiagnostics, ProviderHealthDiagnostics, RepositoryPolicyDiagnostics } from './types.js';

export function computeDoctorOk(input: DoctorOkInputs): boolean {
  const baseBranchReady = !(input.requireBaseBranchFreshness ?? true) || (input.baseRef.resolved && input.baseRef.upToDate);
  const pullRequestReady = !(input.blockOnOpenPRs ?? true) || (input.blockingPullRequestCount === 0 && !input.pullRequestError);
  return input.isRepo &&
    input.configValid &&
    input.gitAvailable &&
    input.ghAvailable &&
    input.nodeSatisfies &&
    !((input.noWorktreePolicy ?? true) && input.isWorktree) &&
    input.labelsOk &&
    input.queueDriftCount === 0 &&
    !input.queueMultipleInProgress &&
    !input.queueError &&
    baseBranchReady &&
    pullRequestReady &&
    (input.instructionInstallOk ?? true);
}

export function buildLifecycleDiagnostics(input: {
  config: Config;
  currentBranch: string;
  isWorktree: boolean;
  openIssues: GitHubIssue[];
  queueDriftCount: number;
  queueMultipleInProgress: boolean;
  queueError?: string;
  baseRef: BaseRefStatus;
  blockingPullRequestCount: number;
  pullRequestError?: string;
}): LifecycleDiagnostics {
  const activeIssues = input.openIssues.filter(issue => issue.labels.includes('S-InProgress'));
  const activeIssue = activeIssues.length === 1 ? activeIssues[0] : null;
  const branchNamingValid = validateBranchPattern(input.config.branchNaming) === null;
  const activeIssueBranch = activeIssue ? suggestBranchName(activeIssue, input.config) : null;
  const currentBranchMatchesActiveIssue = activeIssue && activeIssueBranch ? input.currentBranch === activeIssueBranch : null;
  const linkedWorktreeBlocked = input.config.noWorktree && input.isWorktree;
  const baseBranchReady = !input.config.requireBaseBranchFreshness || (input.baseRef.resolved && input.baseRef.upToDate);
  const pullRequestReady = !input.config.blockOnOpenPRs || (input.blockingPullRequestCount === 0 && !input.pullRequestError);
  const lifecycleCommandsReady = branchNamingValid &&
    !linkedWorktreeBlocked &&
    !input.queueMultipleInProgress &&
    !input.queueError &&
    input.queueDriftCount === 0 &&
    baseBranchReady &&
    pullRequestReady;
  return {
    branchNamingValid,
    inProgressIssueCount: activeIssues.length,
    activeIssueNumber: activeIssue ? activeIssue.number : null,
    activeIssueBranch,
    currentBranchMatchesActiveIssue,
    linkedWorktreeBlocked,
    openPullRequestCheckEnabled: input.config.blockOnOpenPRs,
    baseBranchFresh: input.baseRef.resolved && input.baseRef.upToDate,
    queueError: input.queueError,
    lifecycleCommandsReady,
  };
}

function managedInstructionText(repoRoot: string | null): string {
  if (!repoRoot) return '';
  return getInstructionTargetPaths()
    .map(path => {
      const fullPath = join(repoRoot, path);
      if (!existsSync(fullPath)) return '';
      try {
        const content = readFileSync(fullPath, 'utf8');
        return content.includes(MANAGED_START) ? content : '';
      } catch {
        return '';
      }
    })
    .join('\n');
}

function installCheck(configured: boolean, text: string, pattern: RegExp): InstallCheck {
  return { configured, installed: configured ? pattern.test(text) : false };
}

function predicateInstallCheck(configured: boolean, text: string, predicate: (value: string) => boolean): InstallCheck {
  return { configured, installed: configured ? predicate(text) : false };
}

export function buildInstructionPolicyDiagnostics(config: Config, repoRoot: string | null): InstructionPolicyDiagnostics {
  const text = managedInstructionText(repoRoot);
  return {
    namingRules: installCheck(config.instructions.namingRules, text, /Naming rules:/),
    promptInjectionWarning: installCheck(config.instructions.promptInjectionWarning, text, /untrusted task input/),
    noCreditWarning: installCheck(config.instructions.noCreditWarning, text, /agent, model, service, or vendor credit/),
    implementationGuardrails: installCheck(config.instructions.implementationGuardrails, text, /placeholder command classes|repository meta documentation/),
    supplyChainSafety: installCheck(config.instructions.supplyChainSafety, text, /package-age gates before adding or upgrading dependencies|supply-chain safety/i),
    canonicalSupplyChainGuard: predicateInstallCheck(config.instructions.supplyChainSafety, text, hasCanonicalSupplyChainGuardInstruction),
  };
}

export function buildProviderHealthDiagnostics(config: Config): ProviderHealthDiagnostics {
  const warnings: string[] = [];
  const providers = {
    work: { kind: config.providers.work.kind, supported: config.providers.work.kind === 'github' || config.providers.work.kind === 'gitlab' || config.providers.work.kind === 'linear', required: config.providers.capabilities.work },
    review: { kind: config.providers.review.kind, supported: config.providers.review.kind === 'github', required: config.providers.capabilities.review },
    repository: { kind: config.providers.repository.kind, supported: config.providers.repository.kind === 'local-git', required: config.providers.capabilities.repository },
    ci: { kind: config.providers.ci.kind, supported: config.providers.ci.kind === 'github', required: config.providers.capabilities.ci },
    layout: { kind: config.providers.layout.kind, supported: config.providers.layout.kind === 'local', required: config.providers.capabilities.layout },
  };
  for (const [name, provider] of Object.entries(providers)) {
    if (provider.required && !provider.supported) {
      warnings.push(`Failed to validate ${name} provider: kind ${provider.kind} is not supported by Executor v1. Likely cause: unsupported providers.${name}.kind in the selected Executor config. Next action: set providers.${name}.kind to a supported v1 kind and rerun \`aie doctor --json\`.`);
    }
  }
  return {
    providers,
    normalizedPolicy: {
      priorityLabels: config.normalizedPolicy.labels.priorities.length,
      statusLabels: config.normalizedPolicy.labels.statuses.length,
      componentLabels: config.normalizedPolicy.labels.components.length,
      baseRef: `${config.normalizedPolicy.branch.baseRemote}/${config.normalizedPolicy.branch.baseBranch}`,
      configuredGates: config.normalizedPolicy.gates.definitions.length,
      reviewAgents: config.normalizedPolicy.reviews.reviewers.length + config.normalizedPolicy.reviews.localReviewers.length,
    },
    warnings,
  };
}

export function buildRepositoryPolicyDiagnostics(config: Config): RepositoryPolicyDiagnostics {
  return {
    noWorktree: config.noWorktree,
    blockOnOpenPRs: config.blockOnOpenPRs,
    requireBaseBranchFreshness: config.requireBaseBranchFreshness,
    baseBranch: config.baseBranch,
    baseRemote: config.baseRemote,
    milestoneOrdering: config.milestoneOrdering.enabled,
    missingMilestonePolicy: config.milestoneOrdering.missingAssignment,
    supplyChain: { ...config.supplyChain },
  };
}

function toolAvailability(command: string, required: boolean): DoctorToolAvailability {
  let available = false;
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    available = true;
  } catch {
    available = false;
  }
  return {
    command,
    available,
    required,
    nextAction: available || !required ? null : `Install ${command} or update repository config before relying on this integration.`,
  };
}

function emptyKindCounts(): Record<GateKind, number> {
  return { build: 0, lint: 0, typecheck: 0, unit: 0, integration: 0, e2e: 0, custom: 0, aiq: 0 };
}

function emptyStageCounts(): Record<GateStage, number> {
  return { all: 0, 'pre-pr': 0, 'pre-merge': 0 };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim() !== ''))].sort();
}

function reviewerExternalService(name: string): string | null {
  const normalized = name.trim().toLowerCase().replace(/^@/, '');
  if (normalized === '') return null;
  if (normalized === 'oracle' || normalized === 'opencode-oracle' || normalized === 'fallback-oracle') return null;
  if (normalized === 'copilot') return 'github-copilot';
  if (normalized === 'cubic' || normalized === 'cubic-dev-ai') return 'cubic';
  if (normalized === 'coderabbit' || normalized === 'coderabbitai') return 'coderabbitai';
  const id = normalized.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom';
  return `custom-pr-reviewer:${redact(id)}`;
}

export function buildGateReadinessDiagnostics(config: Config, options: { ghAuthenticated: boolean; evidenceRoot?: string } = { ghAuthenticated: false }): GateReadinessDiagnostics {
  const gates = configuredGates(config);
  const gatePlan = buildGatePlan(config);
  const gateStatus = buildGateStatus(config, { evidenceRoot: options.evidenceRoot });
  const byStage = emptyStageCounts();
  const byKind = emptyKindCounts();
  for (const gate of gates) {
    byStage[gate.stage] += 1;
    byKind[gate.kind] += 1;
  }
  const invalidCommands = gates
    .filter(gate => gate.command.trim() === '')
    .map(gate => redact(gate.name));
  const supplyChainSensitiveGates = gatePlan.gates.filter(gate => gate.supplyChainSensitive).map(gate => gate.name);
  const externalServiceGates = gatePlan.gates.filter(gate => gate.externalService).map(gate => gate.name);
  const configuredReviewers = config.reviewAgents.map(name => redact(name.trim())).filter(name => name !== '');
  const configuredLocalReviewers = config.localReviewAgents.map(name => redact(name.trim())).filter(name => name !== '');
  const reviewerServices = unique(config.reviewAgents.map(reviewerExternalService).filter((service): service is string => service !== null));
  const defaultOracle = configuredReviewers.length === 0 && config.reviewAdapter !== 'local';
  const localReviewEnabled = config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed';
  const localReviewShadow = config.reviewAdapter === 'shadow' || config.reviewProfile === 'local-shadow';
  const effectiveReviewProfile = localReviewShadow ? 'local-shadow' : (localReviewEnabled && config.reviewProfile === 'remote-compatible') ? 'local-standard' : config.reviewProfile;
  const localEvidenceRoot = '.qube/aie/pr-reviews';
  const agentBrowser = toolAvailability('agent-browser', config.manualUiAudit);
  const fallbackBrowserAutomation = toolAvailability('playwright', false);
  const aiqTool = toolAvailability('aiq', config.qualityControl);
  const aiqCommands = gatePlan.gates.filter(gate => gate.kind === 'aiq').map(gate => gate.command);
  const aiqConfigured = aiqCommands.length > 0;
  const aiqReadiness: DoctorReadinessStatus = !config.qualityControl
    ? 'disabled'
    : aiqConfigured && aiqTool.available
      ? 'ready'
      : 'missing';
  const auditReadiness: DoctorReadinessStatus = !config.manualUiAudit
    ? 'disabled'
    : agentBrowser.available
      ? 'ready'
      : 'needs-action';
  const prReviewReadiness: DoctorReadinessStatus = options.ghAuthenticated ? 'ready' : 'missing';
  const localRunner = {
    configured: false,
    readiness: localReviewEnabled || localReviewShadow ? 'unavailable' as const : 'disabled' as const,
    command: null,
    capabilities: {
      canRun: false,
      canComment: false,
      canInline: false,
      canUseTools: false,
      canRunShell: false,
      canUseBrowser: false,
      canReadMcp: false,
      canAccessNetwork: false,
      canWriteEvidence: true,
      supportsJson: true,
      supportsPromptStack: true,
      supportsIncrementalReview: false,
    },
    missingTools: localReviewEnabled || localReviewShadow ? ['local-review-runner'] : [],
    nextAction: localReviewEnabled || localReviewShadow
      ? 'No local review runner is configured. Record local review evidence manually in the repository-scoped evidence path, or configure a real runner before relying on runner automation.'
      : 'Local review evidence is disabled by the selected review adapter.',
  };
  const policy = config.supplyChain;
  const supplyChainReady = policy.packageAgeDays <= policy.highRiskPackageAgeDays && policy.disableLifecycleScripts && policy.intentionalLockfileChanges;
  const externalServices = unique([
    ...gatePlan.gates.filter(gate => gate.externalService).map(gate => `gate:${gate.name}`),
    ...reviewerServices,
    config.manualUiAudit ? 'agent-browser' : '',
    config.qualityControl ? 'aiq' : '',
  ]);
  return {
    gates: {
      configured: gatePlan.gates.length,
      required: gatePlan.summary.required,
      advisory: gatePlan.summary.advisory,
      byStage,
      byKind,
      invalidCommands,
      supplyChainSensitive: gatePlan.summary.supplyChainSensitive,
      supplyChainSensitiveGates,
      externalServiceGates,
      externalServices: externalServiceGates.map(name => `gate:${name}`),
      evidence: gateStatus.summary,
      gateEvidence: gateStatus.gates.map(gate => ({ name: gate.name, status: gate.status, source: gate.source, trust: gate.trust, reasonCode: gate.reasonCode, verified: gate.verified })),
    },
    audit: {
      manualUiAudit: config.manualUiAudit,
      readiness: auditReadiness,
      agentBrowser,
      fallbackBrowserAutomation,
      appLaunchConfigured: config.uiAuditAppLaunch.trim() !== '',
      auditTargetConfigured: config.uiAuditTarget.trim() !== '',
      screenshotUpload: 'disabled',
    },
    reviewAgent: {
      required: true,
      readiness: 'ready',
      adapter: config.reviewAdapter,
      profile: effectiveReviewProfile,
      severityThreshold: config.reviewSeverityThreshold,
      reviewers: defaultOracle ? ['oracle'] : configuredReviewers,
      localReviewers: configuredLocalReviewers,
      configuredProfiles: ['remote-compatible', 'local-standard', 'local-comprehensive', 'local-shadow'],
      requiredLanes: [...requiredLocalReviewLanes(effectiveReviewProfile)],
      configuredLanes: config.reviewLanes.map(lane => lane.id),
      promptFragments: {
        repository: [...config.reviewPromptFragments.repository],
        safety: [...config.reviewPromptFragments.safety],
        style: [...config.reviewPromptFragments.style],
        adapter: [...config.reviewPromptFragments.adapter],
        reviewer: [...config.reviewPromptFragments.reviewer],
        commandAddendum: [...config.reviewPromptFragments.commandAddendum],
      },
      contextSources: {
        instructions: [...config.reviewContextSources.instructions],
        requirements: [...config.reviewContextSources.requirements],
        issues: config.reviewContextSources.issues,
        issueComments: config.reviewContextSources.issueComments,
        linkedIssues: config.reviewContextSources.linkedIssues,
        milestones: config.reviewContextSources.milestones,
        pullRequests: config.reviewContextSources.pullRequests,
        prComments: config.reviewContextSources.prComments,
        reviewThreads: config.reviewContextSources.reviewThreads,
      },
      defaultOracle,
      fallbackPromptAvailable: true,
      localEvidenceRoot,
      localRunner,
      externalServices: reviewerServices,
      reviewWaitMinutes: config.reviewWaitMinutes,
    },
    prReview: {
      readiness: prReviewReadiness,
      ghAuthenticated: options.ghAuthenticated,
      adapter: config.reviewAdapter,
      profile: effectiveReviewProfile,
      reviewers: configuredReviewers,
      localReviewers: configuredLocalReviewers,
      localEvidenceRoot,
      localRunnerReadiness: localRunner.readiness,
      externalServices: reviewerServices,
      reviewWaitMinutes: config.reviewWaitMinutes,
    },
    aiq: {
      enabled: config.qualityControl,
      configured: aiqConfigured,
      readiness: aiqReadiness,
      tool: aiqTool,
      configuredCommands: aiqCommands,
    },
    supplyChain: {
      policyConfigured: true,
      exactVersions: policy.exactVersions,
      intentionalLockfileChanges: policy.intentionalLockfileChanges,
      disableLifecycleScripts: policy.disableLifecycleScripts,
      pinCiActions: policy.pinCiActions,
      packageAgeDays: policy.packageAgeDays,
      highRiskPackageAgeDays: policy.highRiskPackageAgeDays,
      requireApprovalForUnverifiedRisk: policy.requireApprovalForUnverifiedRisk,
      writePackageManagerDefaults: policy.writePackageManagerDefaults,
      supplyChainSensitiveGates,
      readiness: supplyChainReady ? 'ready' : 'needs-action',
    },
    externalServices,
  };
}

export function missingConfiguredInstructionChecks(policy: InstructionPolicyDiagnostics): string[] {
  return Object.entries(policy)
    .filter(([, check]) => check.configured && !check.installed)
    .map(([name]) => name);
}

export function chooseNextCommand(overallOk: boolean, recommendations: string[]): string {
  for (const recommendation of recommendations) {
    const match = /`(aie [^`]+)`/.exec(recommendation);
    if (match) return match[1];
  }
  if (overallOk) return 'aie queue --json';
  return 'aie doctor --json';
}
