import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { probeExecutable, type ResolveExecutableOptions } from '@tjalve/qube-core';
import { suggestBranchName, validateBranchPattern } from '../branch.js';
import type { Config, GateKind, GateStage } from '../config/index.js';
import type { BaseRefStatus, InstructionStatus } from '../repo/index.js';
import type { GitHubIssue } from '../providers/github_adapter_exports.js';
import { MANAGED_START, readManagedToolVersion } from '../managed_file.js';
import { readAiePackageVersion, reviewModeOf } from '../review_mode.js';
import { buildGatePlan, buildGateStatus, configuredGates } from '../gates/index.js';
import { redact } from '../redact.js';
import { hasCanonicalSupplyChainGuardInstruction } from '../supply_chain_guard.js';
import { requiredLocalReviewLanes } from '../local_review_evidence.js';
import { buildDescriptorSummary } from '../agent_descriptors.js';
import { probeCodexReviewCapabilitySync, probeOpenCodeReviewCapabilitySync } from '../app/local_review_runner.js';
import { reviewModelHostStatuses } from '../app/model_catalog.js';
import { buildReviewPreflightDiagnostics } from './review_preflight.js';
export type { DoctorDiagnostics, DoctorOkInputs, DoctorReadinessStatus, DoctorToolAvailability, DoctorToolLookupState, GateReadinessDiagnostics, InstallCheck, InstructionPolicyDiagnostics, LifecycleDiagnostics, ProviderHealthDiagnostics, RepositoryPolicyDiagnostics } from './types.js';
import type { DoctorOkInputs, DoctorReadinessStatus, DoctorToolAvailability, DoctorToolLookupState, GateReadinessDiagnostics, InstallCheck, InstructionPolicyDiagnostics, LifecycleDiagnostics, ProviderHealthDiagnostics, RepositoryPolicyDiagnostics } from './types.js';
export { buildReviewPreflightDiagnostics } from './review_preflight.js';
export { buildWorkflowReadiness, buildReviewReadiness, selectedAgentHosts } from './workflow_readiness.js';
export type { WorkflowReadinessDiagnostics, WorkflowReadinessInput, WorkflowReviewReadiness, WorkflowReviewSourceReadiness, WorkflowReviewState, WorkflowStage, WorkflowStageId, WorkflowStageStatus, WorkflowEvidenceState, WorkflowDirtyState, WorkflowShippingReadiness } from './workflow_readiness.js';

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
    (input.staleReviewLockCount ?? 0) === 0 &&
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
  return ['AGENTS.md', 'CLAUDE.md']
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

function isSupportedWorkProvider(kind: string): boolean {
  return kind === 'github' || kind === 'gitlab' || kind === 'linear' || kind === 'jira';
}

function isSupportedReviewProvider(kind: string): boolean {
  return kind === 'github' || kind === 'gitlab';
}

function isSupportedCiProvider(kind: string): boolean {
  return kind === 'github' || kind === 'gitlab' || kind === 'jenkins';
}

export function buildProviderHealthDiagnostics(config: Config): ProviderHealthDiagnostics {
  const warnings: string[] = [];
  const providers = {
    work: { kind: config.providers.work.kind, supported: isSupportedWorkProvider(config.providers.work.kind), required: config.providers.capabilities.work },
    review: { kind: config.providers.review.kind, supported: isSupportedReviewProvider(config.providers.review.kind), required: config.providers.capabilities.review },
    repository: { kind: config.providers.repository.kind, supported: config.providers.repository.kind === 'local-git', required: config.providers.capabilities.repository },
    ci: { kind: config.providers.ci.kind, supported: isSupportedCiProvider(config.providers.ci.kind), required: config.providers.capabilities.ci },
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

function toolAvailability(command: string, required: boolean, lookup: ResolveExecutableOptions = {}): DoctorToolAvailability {
  const probed = probeExecutable(command, { ...lookup, timeoutMs: 4_000 });
  const state: DoctorToolLookupState = probed.probeStatus === 'ok'
    ? 'available'
    : probed.status === 'found'
      ? 'present-but-failing'
      : probed.status === 'unresolvable'
        ? 'unresolvable'
        : 'missing';
  const available = state === 'available';
  const reasonCode = state === 'present-but-failing' ? 'present-but-failing' : probed.reasonCode;
  const nextAction = available || !required
    ? null
    : state === 'present-but-failing'
      ? `${command} was found but its capability probe failed. Repair the install or update repository config before relying on this integration.`
      : state === 'unresolvable'
        ? `Command ${command} is not a valid executable name.`
        : `Install ${command} or update repository config before relying on this integration.`;
  return {
    command,
    available,
    required,
    state,
    resolvedPath: probed.resolvedPath,
    reasonCode,
    nextAction,
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

export function buildGateReadinessDiagnostics(config: Config, options: { ghAuthenticated: boolean; evidenceRoot?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; pathDelimiter?: string } = { ghAuthenticated: false }): GateReadinessDiagnostics {
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
  const descriptorSummary = buildDescriptorSummary();
  const defaultOracle = configuredReviewers.length === 0 && config.reviewAdapter !== 'local';
  const localReviewEnabled = config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed';
  const localReviewShadow = config.reviewAdapter === 'shadow' || config.reviewProfile === 'local-shadow';
  const effectiveReviewProfile = localReviewShadow ? 'local-shadow' : (localReviewEnabled && config.reviewProfile === 'remote-compatible') ? 'local-standard' : config.reviewProfile;
  const localEvidenceRoot = '.qube/aie/reviews';
  const reviewPreflight = buildReviewPreflightDiagnostics(config, { repoRoot: options.evidenceRoot ?? process.cwd() });
  const lookup = { env: options.env, platform: options.platform, pathDelimiter: options.pathDelimiter };
  const agentBrowser = toolAvailability('agent-browser', config.manualUiAudit, lookup);
  const fallbackBrowserAutomation = toolAvailability('playwright', false, lookup);
  const aiqTool = toolAvailability('aiq', config.qualityControl, lookup);
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
  const localCommandLanes = config.reviewLanes.filter(lane => lane.runner === 'local-command' && lane.command?.trim());
  const localHostLanes = config.reviewLanes.filter(lane => lane.runner === 'local-host');
  const localHostCommand = localHostLanes.find(lane => lane.command?.trim())?.command?.trim() ?? null;
  const codexReviewCapability = probeCodexReviewCapabilitySync(localHostCommand, config.localReviewAgents.includes('codex'));
  const opencodeReviewCapability = probeOpenCodeReviewCapabilitySync();
  const localHostNeedsAgent = localHostLanes.length > 0 && !localHostCommand;
  const opencodeLocalReviewConfigured = config.localReviewAgents.includes('opencode');
  const commandlessCodexHostReady = localHostNeedsAgent && codexReviewCapability.independentReviewer;
  const localRunnerConfigured = localCommandLanes.length > 0 || localHostLanes.length > 0;
  const localRunnerReadiness: DoctorReadinessStatus = !(localReviewEnabled || localReviewShadow)
    ? 'disabled'
    : localCommandLanes.length > 0 || localHostCommand
      ? 'ready'
      : commandlessCodexHostReady
        ? 'needs-action'
        : 'missing';
  const localRunner = {
    configured: localRunnerConfigured,
    readiness: localRunnerReadiness,
    command: localCommandLanes[0]?.command ?? localHostCommand,
    capabilities: {
      canRun: localCommandLanes.length > 0 || Boolean(localHostCommand) || commandlessCodexHostReady,
      canComment: false,
      canInline: false,
      canUseTools: false,
      canRunShell: localCommandLanes.length > 0 || Boolean(localHostCommand),
      canUseBrowser: false,
      canReadMcp: false,
      canAccessNetwork: false,
      canWriteEvidence: true,
      supportsJson: true,
      supportsPromptStack: true,
      supportsIncrementalReview: localCommandLanes.length > 0 || Boolean(localHostCommand) || commandlessCodexHostReady,
    },
    missingTools: localRunnerReadiness === 'missing'
      ? localHostNeedsAgent
        ? [opencodeLocalReviewConfigured ? 'opencode local review runner' : 'codex local review agent']
        : ['local-command review lane command']
      : [],
    codex: {
      independentReviewer: codexReviewCapability.independentReviewer,
      freshContext: codexReviewCapability.freshContext,
      promptOnly: codexReviewCapability.promptOnly,
      hooks: codexReviewCapability.hooks,
      evidenceWriting: codexReviewCapability.evidenceWriting,
      missingCapabilities: [...codexReviewCapability.missingCapabilities],
    },
    opencode: {
      independentReviewer: opencodeReviewCapability.independentReviewer,
      freshContext: opencodeReviewCapability.freshContext,
      promptOnly: opencodeReviewCapability.promptOnly,
      hooks: opencodeReviewCapability.hooks,
      evidenceWriting: opencodeReviewCapability.evidenceWriting,
      missingCapabilities: [...opencodeReviewCapability.missingCapabilities],
    },
    nextAction: localRunnerReadiness === 'ready'
      ? 'Local review lanes are configured; run `aie pr gate <pr> --dry-run --json` to inspect planned lane execution.'
      : localRunnerReadiness === 'needs-action'
        ? codexReviewCapability.nextAction
        : localRunnerReadiness === 'missing'
          ? opencodeLocalReviewConfigured && localHostNeedsAgent
            ? opencodeReviewCapability.nextAction
            : 'No local-command review lane command is configured. Configure reviews.lanes entries with runner local-command and command before relying on runner automation.'
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
      readiness: (!defaultOracle && configuredReviewers.length > 0) || localRunnerReadiness === 'ready' ? 'ready' : 'needs-action',
      descriptorSupport: {
        available: true,
        runnerAvailable: localRunner.readiness === 'ready',
        categories: descriptorSummary.categories.map(category => category.id),
        agents: descriptorSummary.agents.map(agent => agent.id),
        promptFragments: descriptorSummary.promptFragments,
      },
      adapter: config.reviewAdapter,
      mode: reviewModeOf(config),
      modeSource: config.reviewMode ? 'configured' : 'inferred',
      models: Object.values(config.reviewModels.review).map(binding => binding.model).filter(model => model.trim() !== ''),
      hostModels: reviewModelHostStatuses(config.reviewModels).map(item => ({
        host: item.host,
        configured: item.configured,
        live: item.listing.models,
        listing: item.listing.status,
        served: item.served,
        absent: item.absent,
      })),
      publisherLogin: config.providers.review.publisher?.githubApp?.login
        ?? config.providers.review.publisher?.token?.login
        ?? null,
      instructionToolVersion: [join(options.evidenceRoot ?? process.cwd(), 'AGENTS.md'), join(options.evidenceRoot ?? process.cwd(), 'CLAUDE.md')]
        .filter(path => existsSync(path))
        .map(path => readManagedToolVersion(readFileSync(path, 'utf8')))
        .find(version => version !== null) ?? null,
      runningToolVersion: readAiePackageVersion(),
      instructionStale: (() => {
        const running = readAiePackageVersion();
        const versions = [join(options.evidenceRoot ?? process.cwd(), 'AGENTS.md'), join(options.evidenceRoot ?? process.cwd(), 'CLAUDE.md')]
          .filter(path => existsSync(path))
          .map(path => readManagedToolVersion(readFileSync(path, 'utf8')));
        return versions.length === 0 || versions.some(version => version !== running);
      })(),
      instructionRefreshCommand: 'aie init . --force',
      profile: effectiveReviewProfile,
      severityThreshold: config.reviewSeverityThreshold,
      reviewers: defaultOracle ? ['oracle'] : configuredReviewers,
      localReviewers: configuredLocalReviewers,
      configuredProfiles: ['remote-compatible', 'local-standard', 'local-focused', 'local-comprehensive', 'local-shadow'],
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
    reviewPreflight,
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

export function buildInstructionRecommendations(input: {
  repoRoot: string | null;
  instructions: InstructionStatus;
  instructionPolicy: InstructionPolicyDiagnostics;
  supplyChainSafetyConfigured: boolean;
}): string[] {
  const recommendations: string[] = [];
  const unmanagedTargets = input.repoRoot ? input.instructions.targets.filter(target => target.present && !target.managed) : [];
  const unhealthyTargets = input.repoRoot ? input.instructions.targets.filter(target => target.managed && !target.healthy) : [];
  const missingInstructionChecks = missingConfiguredInstructionChecks(input.instructionPolicy);
  if (input.repoRoot && !input.instructions.agentsManaged && !input.instructions.claudeManaged) recommendations.push('Managed always-loaded instructions are not installed. Run `aie init . --dry-run` to review installation.');
  const opencodeSelected = input.instructions.opencodeMakeItSo || input.instructions.opencodeMakeitsoAlias;
  if (input.repoRoot && opencodeSelected && !input.instructions.opencodeMakeItSoManaged) recommendations.push('OpenCode project command is not installed. Run `aie init . --tool opencode --dry-run` to review installation.');
  if (unmanagedTargets.length > 0) recommendations.push(`Instruction targets without Executor managed sections: ${unmanagedTargets.map(target => target.path).join(', ')}. Run \`aie init . --dry-run\` to review safe updates.`);
  if (input.repoRoot && missingInstructionChecks.length > 0) recommendations.push(`Configured instruction policy is not installed for: ${missingInstructionChecks.join(', ')}. Run \`aie init . --dry-run\` to refresh managed instructions.`);
  if (unhealthyTargets.length > 0) recommendations.push(`Managed instruction targets need refresh: ${unhealthyTargets.map(target => target.path).join(', ')}. Run \`aie init . --dry-run\` to review safe updates.`);
  if (input.repoRoot && input.supplyChainSafetyConfigured && !input.instructionPolicy.supplyChainSafety.installed) recommendations.push('Supply-chain safety instructions are configured but not installed. Run `aie init . --dry-run` to refresh managed instructions before dependency work.');
  if (input.repoRoot && input.supplyChainSafetyConfigured && !input.instructionPolicy.canonicalSupplyChainGuard.installed) recommendations.push('Canonical supply-chain guard instructions are configured but not installed. Run `aie init . --dry-run` to refresh managed instructions before dependency work.');
  return recommendations;
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
