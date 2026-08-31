import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'fs';
import { join, sep } from 'path';
import { readFile } from 'fs/promises';
import { createRequire } from 'node:module';
import { cwd } from 'process';
import { Config, displayConfigPath, getDefaults, loadConfig, loadConfigFile, selectConfigPath, ValidationError } from './config/index.js';
import { getDesiredLabels, computeLabelPlan, parseGhLabelList } from './labels.js';
import { runGh } from './providers/github_adapter_exports.js';
import { computeQueue } from './queue/index.js';
import type { GitHubIssue } from './providers/github_adapter_exports.js';
import {
  findMilestoneWarnings,
  getBaseRefStatus,
  getInstructionStatus,
  getPlanningStatus,
  getRepositoryIdentity,
  listMilestones,
  listOpenPullRequests,
  PullRequestSummary,
} from './repo/index.js';
import { buildGateReadinessDiagnostics, buildInstructionPolicyDiagnostics, buildInstructionRecommendations, buildLifecycleDiagnostics, buildProviderHealthDiagnostics, buildRepositoryPolicyDiagnostics, buildWorkflowReadiness, chooseNextCommand, computeDoctorOk, DoctorDiagnostics, missingConfiguredInstructionChecks } from './doctor_diagnostics/index.js';
import { findReviewSessionLocks } from './app/local_review_runner_support.js';
import type { WorkflowDirtyState } from './doctor_diagnostics/index.js';
import { configToExecutorPolicy } from './config_policy.js';
import { createLocalGitRepositoryProvider } from './providers/local/local_git_provider.js';
import { prerequisiteCheck } from './providers/local/git_prerequisites.js';

export {
  buildGateReadinessDiagnostics,
  buildInstructionPolicyDiagnostics,
  buildInstructionRecommendations,
  buildLifecycleDiagnostics,
  buildProviderHealthDiagnostics,
  buildReviewPreflightDiagnostics,
  buildRepositoryPolicyDiagnostics,
  buildReviewReadiness,
  buildWorkflowReadiness,
  chooseNextCommand,
  computeDoctorOk,
  selectedAgentHosts,
} from './doctor_diagnostics/index.js';

const requirePackage = createRequire(import.meta.url);

class DoctorDiagnosticsBuilder {
  constructor(private readonly options: { offline?: boolean } = {}) {}

  async buildDiagnostics(): Promise<DoctorDiagnostics> {
    const initialRepository = await createLocalGitRepositoryProvider().inspect(configToExecutorPolicy(getDefaults()), { offline: true });
    const initialRoot = initialRepository.root;
    const configStatus = await this.checkConfig(initialRoot);
    const effectiveConfig = (configStatus.valid ? (await loadConfig(initialRoot ?? undefined)) : null) || getDefaults();
    const repository = await createLocalGitRepositoryProvider().inspect(configToExecutorPolicy(effectiveConfig), { offline: this.options.offline });
    const prerequisites = repository.prerequisites;
    const repoRoot = repository.root;
    const isRepo = !!repoRoot;
    const gitCheck = prerequisiteCheck(prerequisites, 'git');
    const gitAvailable = gitCheck?.reasonCode !== 'git-not-found';
    const ghStatus = this.checkGhAuth();
    const nodeStatus = this.checkNodeVersion();
    const branch = repository.activeRef?.name ?? 'unknown';
    const isWorktree = repository.worktree.linked;
    const labelStatus = await this.checkLabels(effectiveConfig);
    const baseRef = {
      remote: effectiveConfig.baseRemote,
      branch: effectiveConfig.baseBranch,
      resolved: repository.baseRef.revision !== null,
      localRevision: repository.baseRef.revision ?? undefined,
      remoteRevision: repository.baseRef.remoteRevision ?? undefined,
      upToDate: repository.baseRef.upToDate ?? null,
      error: repository.baseRef.error ?? undefined,
    };
    const instructions = getInstructionStatus(repoRoot);
    const planning = getPlanningStatus(repoRoot);
    const providerHealth = buildProviderHealthDiagnostics(effectiveConfig);
    const instructionPolicy = buildInstructionPolicyDiagnostics(effectiveConfig, repoRoot);
    const repositoryPolicy = buildRepositoryPolicyDiagnostics(effectiveConfig);
    const gateReadiness = buildGateReadinessDiagnostics(effectiveConfig, { ghAuthenticated: ghStatus.authenticated, evidenceRoot: repoRoot ?? undefined });
    const unmanagedTargets = repoRoot ? instructions.targets.filter(target => target.present && !target.managed) : [];
    const unhealthyTargets = repoRoot ? instructions.targets.filter(target => target.managed && !target.healthy) : [];
    const installedHarnesses = instructions.harnesses.filter(harness => harness.installed);
    const missingInstructionChecks = missingConfiguredInstructionChecks(instructionPolicy);
    const recommendations = this.buildEarlyRecommendations({ nodeStatus, gitAvailable, ghStatus, isRepo, isWorktree, configStatus, effectiveConfig, repoRoot, instructions, providerHealth, instructionPolicy, gateReadiness });
    for (const prerequisite of prerequisites.checks.filter(candidate => candidate.status === 'needs-action' || candidate.status === 'unverified')) {
      if (prerequisite.nextAction && !recommendations.includes(prerequisite.nextAction)) recommendations.push(prerequisite.nextAction);
    }
    this.addLabelRecommendations(labelStatus, recommendations);
    const queueState = await this.readQueue(recommendations);
    const pullRequestState = await this.readPullRequests(effectiveConfig, recommendations);
    this.addBaseRefRecommendation(baseRef, effectiveConfig, recommendations);
    const lifecycle = buildLifecycleDiagnostics({
      config: effectiveConfig,
      currentBranch: branch,
      isWorktree,
      openIssues: queueState.openIssuesForMilestones,
      queueDriftCount: queueState.queueDriftCount,
      queueMultipleInProgress: queueState.queueMultipleInProgress,
      queueError: queueState.queueError,
      baseRef,
      blockingPullRequestCount: pullRequestState.blockingPullRequests.length,
      pullRequestError: pullRequestState.pullRequestError,
    });
    this.addLifecycleRecommendations(lifecycle, queueState.activeIssue, recommendations);
    const dirty: WorkflowDirtyState = { dirty: repository.dirty.dirty, entries: repository.dirty.paths.slice(0, 50), error: repository.dirty.error };
    const workflowReadiness = buildWorkflowReadiness({
      config: effectiveConfig,
      configValid: configStatus.valid,
      labelsOk: labelStatus.ok,
      queueDriftCount: queueState.queueDriftCount,
      queueMultipleInProgress: queueState.queueMultipleInProgress,
      queueError: queueState.queueError,
      lifecycle,
      gateReadiness,
      instructions,
      dirty,
      currentBranch: branch,
      blockingPullRequests: pullRequestState.blockingPullRequests,
      evidence: this.resolveCurrentEvidence(repoRoot, branch, pullRequestState.openPullRequests),
    });
    const reviewSessionLocks = repoRoot ? findReviewSessionLocks(repoRoot) : [];
    for (const lock of reviewSessionLocks.filter(lock => lock.stale)) {
      recommendations.push(`Stale review session lock detected at ${lock.path}: ${lock.reason} ${lock.cleanupCommand}`);
    }
    const milestoneState = await this.readMilestones(effectiveConfig, queueState.openIssuesForMilestones, recommendations);
    this.addMilestoneRecommendations(milestoneState.milestoneWarnings, recommendations);
    const prerequisiteBlockers = prerequisites.checks.filter(candidate => candidate.status === 'needs-action' && !(queueState.activeIssue && (candidate.id === 'dirty-worktree' || candidate.id === 'worktree')));
    const overallOk = computeDoctorOk({
      isRepo,
      configValid: configStatus.valid,
      gitAvailable,
      ghAvailable: ghStatus.available,
      nodeSatisfies: nodeStatus.satisfies,
      isWorktree,
      noWorktreePolicy: effectiveConfig.noWorktree,
      requireBaseBranchFreshness: effectiveConfig.requireBaseBranchFreshness,
      blockOnOpenPRs: effectiveConfig.blockOnOpenPRs,
      labelsOk: labelStatus.ok,
      queueDriftCount: queueState.queueDriftCount,
      queueMultipleInProgress: queueState.queueMultipleInProgress,
      queueError: queueState.queueError,
      baseRef,
      blockingPullRequestCount: effectiveConfig.blockOnOpenPRs ? pullRequestState.blockingPullRequests.length : 0,
      pullRequestError: effectiveConfig.blockOnOpenPRs ? pullRequestState.pullRequestError : undefined,
      instructionInstallOk: !repoRoot || (installedHarnesses.length > 0 && installedHarnesses.every(harness => harness.healthy) && unmanagedTargets.length === 0 && unhealthyTargets.length === 0 && missingInstructionChecks.length === 0),
      staleReviewLockCount: reviewSessionLocks.filter(lock => lock.stale).length,
      repositoryPrerequisitesReady: prerequisiteBlockers.length === 0,
    });
    return {
      ok: overallOk,
      command: 'doctor',
      cwd: cwd(),
      isRepo,
      nodeVersion: nodeStatus.version,
      nodeSatisfies: nodeStatus.satisfies,
      git: gitAvailable,
      prerequisites,
      gh: ghStatus.available,
      ghAuthenticated: ghStatus.authenticated,
      currentBranch: branch,
      isWorktree,
      configPresent: configStatus.present,
      configValid: configStatus.valid,
      configErrors: configStatus.errors,
      configSources: configStatus.fieldSources,
      baseBranch: configStatus.baseBranch,
      baseRemote: configStatus.baseRemote,
      labelsOk: labelStatus.ok,
      labelsMissing: labelStatus.missing,
      labelsDrifted: labelStatus.drifted,
      labelsDuplicates: labelStatus.duplicates,
      labelsError: labelStatus.labelsError,
      queueDriftCount: queueState.queueDriftCount,
      queueMultipleInProgress: queueState.queueMultipleInProgress,
      queueError: queueState.queueError,
      lifecycle,
      instructions,
      planning,
      providerHealth,
      instructionPolicy,
      repositoryPolicy,
      gateReadiness,
      workflowReadiness,
      reviewSessionLocks,
      baseRef,
      openPullRequests: pullRequestState.openPullRequests,
      blockingPullRequests: pullRequestState.blockingPullRequests,
      pullRequestError: pullRequestState.pullRequestError,
      milestones: milestoneState.milestones,
      milestoneWarnings: milestoneState.milestoneWarnings,
      milestoneError: milestoneState.milestoneError,
      timestamp: new Date().toISOString(),
      recommendations,
      nextCommand: chooseNextCommand(overallOk, recommendations),
    };
  }

  private buildEarlyRecommendations(input: {
    nodeStatus: { version: string; satisfies: boolean; required: string };
    gitAvailable: boolean;
    ghStatus: { available: boolean; authenticated: boolean };
    isRepo: boolean;
    isWorktree: boolean;
    configStatus: Awaited<ReturnType<DoctorDiagnosticsBuilder['checkConfig']>>;
    effectiveConfig: Config;
    repoRoot: string | null;
    instructions: ReturnType<typeof getInstructionStatus>;
    providerHealth: ReturnType<typeof buildProviderHealthDiagnostics>;
    instructionPolicy: ReturnType<typeof buildInstructionPolicyDiagnostics>;
    gateReadiness: ReturnType<typeof buildGateReadinessDiagnostics>;
  }): string[] {
    const recommendations: string[] = [];
    if (!input.nodeStatus.satisfies) recommendations.push(`Update to Node.js 24 LTS or newer (package requires ${input.nodeStatus.required}).`);
    if (!input.gitAvailable) recommendations.push('Install git and ensure it is on PATH.');
    if (!input.ghStatus.available) recommendations.push('Install GitHub CLI (gh) and ensure it is on PATH.');
    else if (!input.ghStatus.authenticated) recommendations.push('Run `gh auth login` to authenticate with GitHub.');
    if (input.gitAvailable && !input.isRepo) recommendations.push('Not inside a git repository. Run `aie doctor` from within a git repository.');
    if (input.effectiveConfig.noWorktree && input.isWorktree) recommendations.push('Linked git worktree detected. Executor policy disables worktrees (use primary checkout).');
    this.addConfigRecommendations(input.configStatus, recommendations);
    for (const warning of input.providerHealth.warnings) recommendations.push(`Provider config issue: ${warning}`);
    this.addInstructionRecommendations(input, recommendations);
    this.addGateReadinessRecommendations(input.gateReadiness, recommendations);
    return recommendations;
  }

  private addConfigRecommendations(configStatus: Awaited<ReturnType<DoctorDiagnosticsBuilder['checkConfig']>>, recommendations: string[]): void {
    if (!configStatus.present) {
      recommendations.push(`No ${configStatus.configDisplayPath} found — using built-in defaults (create manually or run aie init once available).`);
      return;
    }
    if (configStatus.errors && configStatus.errors.length > 0) {
      const firstErr = configStatus.errors[0];
      recommendations.push(`Fix ${configStatus.configDisplayPath}: ${firstErr.path} - ${firstErr.message}${firstErr.suggestion ? ' (' + firstErr.suggestion + ')' : ''}`);
      return;
    }
    if (configStatus.note) recommendations.push(configStatus.note);
  }

  private addLabelRecommendations(labelStatus: Awaited<ReturnType<DoctorDiagnosticsBuilder['checkLabels']>>, recommendations: string[]): void {
    if (labelStatus.ok) return;
    if (labelStatus.labelsError) recommendations.push(`Labels health check failed: ${labelStatus.labelsError}. Fix gh auth, repository state, or run \`aie doctor --json\` for full diagnostics.`);
    if (labelStatus.missing.length > 0) recommendations.push(`Missing Executor labels: ${labelStatus.missing.join(', ')}. Run \`aie labels setup --dry-run\` then \`aie labels setup\`.`);
    if (labelStatus.drifted.length > 0) recommendations.push(`Drifted Executor labels (color or description): ${labelStatus.drifted.join(', ')}. Run \`aie labels setup --dry-run\` then \`aie labels setup\`.`);
    if (labelStatus.duplicates.length > 0) recommendations.push(`Duplicate label names across families in the selected Executor config: ${labelStatus.duplicates.join(', ')}. Fix config.`);
  }

  private addInstructionRecommendations(input: Parameters<DoctorDiagnosticsBuilder['buildEarlyRecommendations']>[0], recommendations: string[]): void {
    recommendations.push(...buildInstructionRecommendations({
      repoRoot: input.repoRoot,
      instructions: input.instructions,
      instructionPolicy: input.instructionPolicy,
      supplyChainSafetyConfigured: input.effectiveConfig.instructions.supplyChainSafety,
    }));
    const reviewAgent = input.gateReadiness?.reviewAgent;
    if (reviewAgent?.instructionStale) {
      recommendations.push(`Managed instructions are older than the running tool (${reviewAgent.instructionToolVersion ?? 'missing'} vs ${reviewAgent.runningToolVersion}). Run \`${reviewAgent.instructionRefreshCommand}\` to refresh them.`);
    }
  }

  private addGateReadinessRecommendations(gateReadiness: ReturnType<typeof buildGateReadinessDiagnostics>, recommendations: string[]): void {
    if (gateReadiness.gates.invalidCommands.length > 0) recommendations.push(`Configured gates have invalid commands: ${gateReadiness.gates.invalidCommands.join(', ')}. Fix the selected Executor config before using gate readiness output.`);
    if (gateReadiness.gates.supplyChainSensitive > 0) recommendations.push(`Supply-chain-sensitive gates detected: ${gateReadiness.gates.supplyChainSensitiveGates.join(', ')}. Review canonical supply-chain guard evidence before running those commands.`);
    if (gateReadiness.audit.readiness === 'needs-action') {
      recommendations.push(
        gateReadiness.audit.agentBrowser.state === 'present-but-failing'
          ? 'Manual UI audit is enabled but agent-browser failed its capability probe. Repair the install or use fallback browser automation manually.'
          : 'Manual UI audit is enabled but agent-browser was not found on PATH. Install agent-browser or use fallback browser automation manually.',
      );
    }
    if (gateReadiness.aiq.enabled && gateReadiness.aiq.readiness === 'missing') {
      recommendations.push(
        gateReadiness.aiq.tool.state === 'present-but-failing'
          ? 'Quality Control is enabled but `aiq` failed its capability probe. Repair the install before relying on that gate.'
          : 'Quality Control is enabled but aiq readiness is missing. Configure an aiq gate and ensure `aiq` is available before relying on that gate.',
      );
    }
    if (gateReadiness.prReview.readiness === 'missing') recommendations.push('PR review gates need authenticated GitHub CLI access. Run `gh auth login` before requesting or inspecting PR reviewers.');
    for (const nextAction of gateReadiness.reviewPreflight.nextActions) recommendations.push(`Review preflight: ${nextAction}`);
    if (gateReadiness.reviewAgent.localRunner.readiness === 'unavailable') recommendations.push('Local review-agent adapter is configured without a local runner. Record repository-scoped local evidence manually before relying on local review gates.');
    if (gateReadiness.supplyChain.readiness === 'needs-action') recommendations.push('Supply-chain policy is configured but not strict enough for normal readiness. Review lifecycle-script, lockfile, and package-age settings in the selected Executor config.');
    for (const host of gateReadiness.reviewAgent.hostModels ?? []) {
      if (host.absent.length === 0) continue;
      recommendations.push(`Configured ${host.host} review model(s) are absent from the live catalog: ${host.absent.join(', ')}. Update policy.reviews.models or refresh the host CLI.`);
    }
  }

  private async readQueue(recommendations: string[]): Promise<{
    queueDriftCount: number;
    queueMultipleInProgress: boolean;
    queueError?: string;
    activeIssue: { number: number } | null;
    openIssuesForMilestones: GitHubIssue[];
  }> {
    let queueDriftCount = 0;
    let queueMultipleInProgress = false;
    let queueError: string | undefined;
    let activeIssue: { number: number } | null = null;
    const openIssuesForMilestones: GitHubIssue[] = [];
    try {
      const q = await computeQueue();
      queueDriftCount = q.driftCount;
      queueMultipleInProgress = q.multipleInProgress;
      for (const item of q.items) {
        const issue = item.issue;
        if (issue.providerId === 'github' && issue.number !== null) {
          openIssuesForMilestones.push({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels,
            assignees: issue.assignees,
            milestone: issue.milestone,
            url: issue.url,
            declaredBlockers: issue.declaredBlockers.filter((blocker): blocker is number => typeof blocker === 'number'),
          });
        }
      }
      const activeItems = q.items.filter(item => item.effectiveStatus === 'InProgress');
      const activeSummary = activeItems.length === 1 ? activeItems[0].issue : null;
      activeIssue = activeSummary?.providerId === 'github' && activeSummary.number !== null ? { number: activeSummary.number } : null;
      if (queueDriftCount > 0 || queueMultipleInProgress) recommendations.push(`Queue drift (${queueDriftCount}) or multiple S-InProgress detected. Run \`aie deps fix --dry-run\` then \`aie deps fix\`.`);
    } catch (err: unknown) {
      queueError = err instanceof Error ? err.message : String(err);
      recommendations.push(`Queue health check failed: ${queueError}. Fix gh auth, repository state, or run \`aie queue --json\` for detailed diagnostics.`);
    }
    return { queueDriftCount, queueMultipleInProgress, queueError, activeIssue, openIssuesForMilestones };
  }

  private async readPullRequests(config: Config, recommendations: string[]): Promise<{ openPullRequests: PullRequestSummary[]; blockingPullRequests: PullRequestSummary[]; pullRequestError?: string }> {
    let openPullRequests: PullRequestSummary[] = [];
    let pullRequestError: string | undefined;
    try {
      openPullRequests = await listOpenPullRequests(config);
    } catch (err: unknown) {
      pullRequestError = err instanceof Error ? err.message : String(err);
      if (config.blockOnOpenPRs) recommendations.push(`Open pull request check failed: ${pullRequestError}. Fix gh auth or repository state, then rerun \`aie doctor\`.`);
    }
    const blockingPullRequests = openPullRequests.filter(pr => !pr.ignored);
    if (config.blockOnOpenPRs && blockingPullRequests.length > 0) recommendations.push(`Open pull requests block new issue work: ${blockingPullRequests.map(pr => `#${pr.number}`).join(', ')}. Merge, close, or configure ignored automation authors before starting new work.`);
    return { openPullRequests, blockingPullRequests, pullRequestError };
  }

  private addBaseRefRecommendation(baseRef: ReturnType<typeof getBaseRefStatus>, config: Config, recommendations: string[]): void {
    if (config.requireBaseBranchFreshness && (!baseRef.resolved || !baseRef.upToDate)) recommendations.push(`Base branch ${baseRef.remote}/${baseRef.branch} is ${baseRef.resolved ? 'not current locally' : 'not resolved'}. Update the local base branch from the configured remote before starting new work.`);
  }

  private addLifecycleRecommendations(lifecycle: ReturnType<typeof buildLifecycleDiagnostics>, activeIssue: { number: number } | null, recommendations: string[]): void {
    if (!lifecycle.branchNamingValid) recommendations.push('Branch naming policy must include <number> and <slug> before lifecycle branch checks can be reliable.');
    if (activeIssue && lifecycle.currentBranchMatchesActiveIssue === false) recommendations.push(`Current branch does not match active issue #${activeIssue.number}. Run \`aie branch check ${activeIssue.number}\` before shipping.`);
  }

  private async readMilestones(config: Config, openIssuesForMilestones: GitHubIssue[], recommendations: string[]): Promise<Pick<DoctorDiagnostics, 'milestones' | 'milestoneWarnings' | 'milestoneError'>> {
    try {
      const repository = await getRepositoryIdentity();
      return { milestones: await listMilestones(repository), milestoneWarnings: findMilestoneWarnings(openIssuesForMilestones, config) };
    } catch (err: unknown) {
      const milestoneError = err instanceof Error ? err.message : String(err);
      recommendations.push(`Milestone health check failed: ${milestoneError}. Fix gh auth or repository state, then rerun \`aie doctor\`.`);
      return { milestones: [], milestoneWarnings: [], milestoneError };
    }
  }

  private addMilestoneRecommendations(warnings: DoctorDiagnostics['milestoneWarnings'], recommendations: string[]): void {
    if (warnings.length === 0) return;
    const sample = warnings.slice(0, 3).map(warning => warning.message).join(' ');
    recommendations.push(`Milestone preservation warnings detected: ${sample} Review milestone assignments before relying on milestone ordering.`);
  }

  private resolveCurrentEvidence(repoRoot: string | null, currentBranch: string, openPullRequests: PullRequestSummary[]): { head: string | null; lanes: string[] } {
    if (!repoRoot) return { head: null, lanes: [] };
    const currentPr = openPullRequests.find(pr => pr.headRefName === currentBranch);
    if (!currentPr) return { head: null, lanes: [] };
    let headSha: string;
    try {
      headSha = execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim();
    } catch {
      return { head: null, lanes: [] };
    }
    if (!/^[a-f0-9]{4,64}$/i.test(headSha)) return { head: null, lanes: [] };
    const evidenceRoot = join(repoRoot, '.qube', 'aie', 'reviews');
    if (!existsSync(evidenceRoot)) return { head: headSha, lanes: [] };
    const lanes = new Set<string>();
    try {
      const rootReal = realpathSync(evidenceRoot);
      for (const issueDir of readdirSync(evidenceRoot)) {
        if (!/^\d+$/.test(issueDir)) continue;
        const headDir = join(evidenceRoot, issueDir, String(currentPr.number), headSha);
        if (!existsSync(headDir)) continue;
        let headDirReal: string;
        try {
          headDirReal = realpathSync(headDir);
        } catch {
          continue;
        }
        if (!headDirReal.startsWith(rootReal + sep)) continue;
        for (const file of readdirSync(headDir)) {
          if (file.startsWith('.') || !file.endsWith('.json') || file.endsWith('.raw-output.json')) continue;
          const lane = file.slice(0, -'.json'.length);
          if (matchesLaneEvidenceIdentity(join(headDir, file), rootReal, lane, Number(issueDir), currentPr.number, headSha)) lanes.add(lane);
        }
      }
    } catch {
      return { head: headSha, lanes: [] };
    }
    return { head: headSha, lanes: [...lanes].sort() };
  }

  private checkGhAuth(): { available: boolean; authenticated: boolean } {
    try {
      execSync('gh --version', { stdio: 'ignore' });
    } catch {
      return { available: false, authenticated: false };
    }
    try {
      const out = execSync('gh auth status', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return { available: true, authenticated: out.includes('Logged in to github.com') || out.includes('github.com') };
    } catch {
      return { available: true, authenticated: false };
    }
  }

  private checkNodeVersion(): { version: string; satisfies: boolean; required: string } {
    try {
      const pkg = requirePackage('../package.json') as { engines?: { node?: string } };
      const required = (pkg.engines && pkg.engines.node) || '>=24.0.0';
      const currentMajor = parseInt(process.version.replace(/^v/, '').split('.')[0], 10);
      return { version: process.version, satisfies: currentMajor >= 24, required };
    } catch {
      return { version: process.version, satisfies: false, required: '>=24.0.0' };
    }
  }

  private async checkConfig(repoRoot: string | null): Promise<{ present: boolean; valid: boolean; configPath?: string; configDisplayPath: string; baseBranch?: string; baseRemote?: string; note?: string; errors?: ValidationError[]; fieldSources?: Readonly<Record<string, string>> }> {
    if (!repoRoot) return { present: false, valid: true, configDisplayPath: 'selected Executor config', note: 'Not inside a git repository' };
    const configPath = selectConfigPath(repoRoot);
    const configDisplay = displayConfigPath(repoRoot, configPath);
    const repositoryPresent = existsSync(configPath);
    const loaded = await loadConfigFile(repoRoot);
    if (!loaded.ok) return { present: loaded.present, valid: false, configPath, configDisplayPath: configDisplay, errors: loaded.errors, note: `Effective Executor config has ${loaded.errors.length} validation error(s)`, fieldSources: loaded.fieldSources };
    if (!loaded.config) return { present: false, valid: true, configPath, configDisplayPath: configDisplay, note: `No ${configDisplay} or user-global config — using built-in defaults`, fieldSources: loaded.fieldSources };
    return {
      present: loaded.present,
      valid: true,
      configPath,
      configDisplayPath: configDisplay,
      baseBranch: loaded.config.baseBranch,
      baseRemote: loaded.config.baseRemote,
      note: repositoryPresent ? undefined : 'Repository config is absent; effective settings come from user-global config and defaults.',
      fieldSources: loaded.fieldSources,
    };
  }

  private async checkLabels(config?: Config): Promise<{ ok: boolean; missing: string[]; drifted: string[]; duplicates: string[]; labelsError?: string }> {
    const result = { ok: true, missing: [] as string[], drifted: [] as string[], duplicates: [] as string[], labelsError: undefined as string | undefined };
    try {
      const plan = computeLabelPlan(parseGhLabelList((await runGh(['label', 'list', '--json', 'name,color,description', '--limit', '1000'])).stdout), getDesiredLabels(config || getDefaults()));
      if (plan.created.length > 0) {
        result.ok = false;
        result.missing = plan.created.map(label => label.name);
      }
      if (plan.updated.length > 0) {
        result.ok = false;
        result.drifted = plan.updated.map(label => label.name);
      }
    } catch (err: unknown) {
      result.ok = false;
      if (err instanceof Error && err.message.includes('Duplicate label name')) result.duplicates = [err.message];
      else result.labelsError = err instanceof Error ? err.message : 'Unknown error during labels check';
    }
    return result;
  }
}

export function matchesLaneEvidenceIdentity(filePath: string, evidenceRootReal: string, lane: string, issueNumber: number, prNumber: number, headSha: string): boolean {
  try {
    const fileReal = realpathSync(filePath);
    if (!fileReal.startsWith(evidenceRootReal + sep)) return false;
    const parsed = JSON.parse(readFileSync(fileReal, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const laneId = parsed.lane ?? parsed.id;
    return laneId === lane
      && parsed.issueNumber === issueNumber
      && parsed.prNumber === prNumber
      && parsed.headSha === headSha
      && typeof parsed.status === 'string' && parsed.status.trim() !== ''
      && typeof parsed.runnerProvenance === 'object' && parsed.runnerProvenance !== null;
  } catch {
    return false;
  }
}

export function buildDoctorDiagnostics(options: { offline?: boolean } = {}): Promise<DoctorDiagnostics> {
  return new DoctorDiagnosticsBuilder(options).buildDiagnostics();
}
