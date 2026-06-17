import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { createRequire } from 'node:module';
import { join } from 'path';
import { cwd } from 'process';
import { Config, getDefaults, loadConfig, validateConfig, ValidationError } from './config/index.js';
import { detectLegacyState } from './init/index.js';
import { getDesiredLabels, computeLabelPlan, parseGhLabelList } from './labels.js';
import { runGh } from './gh.js';
import { buildMigrationPlan } from './migrate/index.js';
import { buildMigrationReadinessDiagnostics } from './migration_diagnostics.js';
import { computeQueue } from './queue/index.js';
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
import { buildGateReadinessDiagnostics, buildInstructionPolicyDiagnostics, buildLifecycleDiagnostics, buildProviderHealthDiagnostics, buildRepositoryPolicyDiagnostics, chooseNextCommand, computeDoctorOk, DoctorDiagnostics, missingConfiguredInstructionChecks } from './doctor_diagnostics/index.js';

export {
  buildGateReadinessDiagnostics,
  buildInstructionPolicyDiagnostics,
  buildLifecycleDiagnostics,
  buildProviderHealthDiagnostics,
  buildRepositoryPolicyDiagnostics,
  computeDoctorOk,
} from './doctor_diagnostics/index.js';
export { buildMigrationReadinessDiagnostics } from './migration_diagnostics.js';

const requirePackage = createRequire(import.meta.url);

class DoctorDiagnosticsBuilder {
  async buildDiagnostics(): Promise<DoctorDiagnostics> {
    const repoRoot = this.getRepoRoot();
    const isRepo = !!repoRoot;
    const gitAvailable = this.checkGit();
    const ghStatus = this.checkGhAuth();
    const nodeStatus = this.checkNodeVersion();
    const branch = this.getCurrentBranch();
    const isWorktree = this.checkIsWorktree();
    const configStatus = await this.checkConfig();
    const effectiveConfig = (configStatus.valid ? (await loadConfig()) : null) || getDefaults();
    const labelStatus = await this.checkLabels(effectiveConfig);
    const baseRef = getBaseRefStatus(effectiveConfig, repoRoot);
    const instructions = getInstructionStatus(repoRoot);
    const planning = getPlanningStatus(repoRoot);
    const legacy = repoRoot ? await detectLegacyState(repoRoot) : [];
    const providerHealth = buildProviderHealthDiagnostics(effectiveConfig);
    const instructionPolicy = buildInstructionPolicyDiagnostics(effectiveConfig, repoRoot);
    const repositoryPolicy = buildRepositoryPolicyDiagnostics(effectiveConfig);
    const gateReadiness = buildGateReadinessDiagnostics(effectiveConfig, { ghAuthenticated: ghStatus.authenticated, evidenceRoot: repoRoot ?? undefined });
    const migrationReadiness = buildMigrationReadinessDiagnostics(await buildMigrationPlan({ dryRun: true, cwd: cwd() }));
    const unmanagedTargets = repoRoot ? instructions.targets.filter(target => target.present && !target.managed) : [];
    const unhealthyTargets = repoRoot ? instructions.targets.filter(target => target.managed && !target.healthy) : [];
    const missingInstructionChecks = missingConfiguredInstructionChecks(instructionPolicy);
    const recommendations = this.buildEarlyRecommendations({ nodeStatus, gitAvailable, ghStatus, isRepo, isWorktree, configStatus, effectiveConfig, repoRoot, instructions, providerHealth, instructionPolicy, legacy, gateReadiness, migrationReadiness });
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
    const milestoneState = await this.readMilestones(effectiveConfig, queueState.openIssuesForMilestones, recommendations);
    this.addMilestoneRecommendations(milestoneState.milestoneWarnings, recommendations);
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
      instructionInstallOk: !repoRoot || (instructions.opencodeMakeItSoManaged && (instructions.agentsManaged || instructions.claudeManaged) && unmanagedTargets.length === 0 && unhealthyTargets.length === 0 && missingInstructionChecks.length === 0),
    });
    return {
      ok: overallOk,
      command: 'doctor',
      cwd: cwd(),
      isRepo,
      nodeVersion: nodeStatus.version,
      nodeSatisfies: nodeStatus.satisfies,
      git: gitAvailable,
      gh: ghStatus.available,
      ghAuthenticated: ghStatus.authenticated,
      currentBranch: branch,
      isWorktree,
      configPresent: configStatus.present,
      configValid: configStatus.valid,
      configErrors: configStatus.errors,
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
      legacy,
      providerHealth,
      instructionPolicy,
      repositoryPolicy,
      gateReadiness,
      migrationReadiness,
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
    legacy: Awaited<ReturnType<typeof detectLegacyState>>;
    gateReadiness: ReturnType<typeof buildGateReadinessDiagnostics>;
    migrationReadiness: ReturnType<typeof buildMigrationReadinessDiagnostics>;
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
    if (input.legacy.length > 0) {
      recommendations.push(`Legacy Executor helper state detected: ${input.legacy.map(item => `${item.category} (${item.paths.join(', ')})`).join('; ')}. Run \`aie migrate legacy --dry-run\` to review the non-mutating migration plan.`);
    }
    if (input.migrationReadiness.detectedPaths > 0 && input.legacy.length === 0) recommendations.push('Migration plan is available for detected legacy paths. Run `aie migrate legacy --dry-run` to review preservation and cleanup candidates.');
    if (input.migrationReadiness.wrapperState.stale > 0) recommendations.push(`Stale compatibility wrappers detected: ${input.migrationReadiness.wrapperState.stalePaths.join(', ')}. Run \`aie migrate legacy --install-wrappers --dry-run\`, then \`aie migrate legacy --install-wrappers --apply\` to refresh wrappers.`);
    if (input.migrationReadiness.remainingLegacyReferences.count > 0) recommendations.push(`Remaining legacy references detected: ${input.migrationReadiness.remainingLegacyReferences.paths.join(', ')}. Run \`aie migrate legacy --dry-run\` to review replacement or cleanup options.`);
    return recommendations;
  }

  private addConfigRecommendations(configStatus: Awaited<ReturnType<DoctorDiagnosticsBuilder['checkConfig']>>, recommendations: string[]): void {
    if (!configStatus.present) {
      recommendations.push('No aie.config.json found — using built-in defaults (create manually or run aie init once available).');
      return;
    }
    if (configStatus.errors && configStatus.errors.length > 0) {
      const firstErr = configStatus.errors[0];
      recommendations.push(`Fix aie.config.json: ${firstErr.path} - ${firstErr.message}${firstErr.suggestion ? ' (' + firstErr.suggestion + ')' : ''}`);
      return;
    }
    if (configStatus.note) recommendations.push(configStatus.note);
  }

  private addLabelRecommendations(labelStatus: Awaited<ReturnType<DoctorDiagnosticsBuilder['checkLabels']>>, recommendations: string[]): void {
    if (labelStatus.ok) return;
    if (labelStatus.labelsError) recommendations.push(`Labels health check failed: ${labelStatus.labelsError}. Fix gh auth, repository state, or run \`aie doctor --json\` for full diagnostics.`);
    if (labelStatus.missing.length > 0) recommendations.push(`Missing Executor labels: ${labelStatus.missing.join(', ')}. Run \`aie labels setup --dry-run\` then \`aie labels setup\`.`);
    if (labelStatus.drifted.length > 0) recommendations.push(`Drifted Executor labels (color or description): ${labelStatus.drifted.join(', ')}. Run \`aie labels setup --dry-run\` then \`aie labels setup\`.`);
    if (labelStatus.duplicates.length > 0) recommendations.push(`Duplicate label names across families in aie.config.json: ${labelStatus.duplicates.join(', ')}. Fix config.`);
  }

  private addInstructionRecommendations(input: Parameters<DoctorDiagnosticsBuilder['buildEarlyRecommendations']>[0], recommendations: string[]): void {
    const unmanagedTargets = input.repoRoot ? input.instructions.targets.filter(target => target.present && !target.managed) : [];
    const unhealthyTargets = input.repoRoot ? input.instructions.targets.filter(target => target.managed && !target.healthy) : [];
    const missingInstructionChecks = missingConfiguredInstructionChecks(input.instructionPolicy);
    if (input.repoRoot && !input.instructions.agentsManaged && !input.instructions.claudeManaged) recommendations.push('Managed always-loaded instructions are not installed. Run `aie init . --dry-run` to review installation.');
    if (input.repoRoot && !input.instructions.opencodeMakeItSoManaged) recommendations.push('OpenCode project command is not installed. Run `aie init . --tool opencode --dry-run` to review installation.');
    if (unmanagedTargets.length > 0) recommendations.push(`Instruction targets without Executor managed sections: ${unmanagedTargets.map(target => target.path).join(', ')}. Run \`aie init . --dry-run\` to review safe updates.`);
    if (input.repoRoot && missingInstructionChecks.length > 0) recommendations.push(`Configured instruction policy is not installed for: ${missingInstructionChecks.join(', ')}. Run \`aie init . --dry-run\` to refresh managed instructions.`);
    if (unhealthyTargets.length > 0) recommendations.push(`Managed instruction targets need refresh: ${unhealthyTargets.map(target => target.path).join(', ')}. Run \`aie init . --dry-run\` to review safe updates.`);
    if (input.repoRoot && input.effectiveConfig.instructions.supplyChainSafety && !input.instructionPolicy.supplyChainSafety.installed) recommendations.push('Supply-chain safety instructions are configured but not installed. Run `aie init . --dry-run` to refresh managed instructions before dependency work.');
    if (input.repoRoot && input.effectiveConfig.instructions.supplyChainSafety && !input.instructionPolicy.canonicalSupplyChainGuard.installed) recommendations.push('Canonical supply-chain guard instructions are configured but not installed. Run `aie init . --dry-run` to refresh managed instructions before dependency work.');
  }

  private addGateReadinessRecommendations(gateReadiness: ReturnType<typeof buildGateReadinessDiagnostics>, recommendations: string[]): void {
    if (gateReadiness.gates.invalidCommands.length > 0) recommendations.push(`Configured gates have invalid commands: ${gateReadiness.gates.invalidCommands.join(', ')}. Fix aie.config.json before using gate readiness output.`);
    if (gateReadiness.gates.supplyChainSensitive > 0) recommendations.push(`Supply-chain-sensitive gates detected: ${gateReadiness.gates.supplyChainSensitiveGates.join(', ')}. Review canonical supply-chain guard evidence before running those commands.`);
    if (gateReadiness.audit.readiness === 'needs-action') recommendations.push('Manual UI audit is enabled but agent-browser was not found on PATH. Install agent-browser or use fallback browser automation manually.');
    if (gateReadiness.aiq.enabled && gateReadiness.aiq.readiness === 'missing') recommendations.push('Quality Control is enabled but aiq readiness is missing. Configure an aiq gate and ensure `aiq` is available before relying on that gate.');
    if (gateReadiness.prReview.readiness === 'missing') recommendations.push('PR review gates need authenticated GitHub CLI access. Run `gh auth login` before requesting or inspecting PR reviewers.');
    if (gateReadiness.supplyChain.readiness === 'needs-action') recommendations.push('Supply-chain policy is configured but not strict enough for normal readiness. Review lifecycle-script, lockfile, and package-age settings in aie.config.json.');
  }

  private async readQueue(recommendations: string[]): Promise<{
    queueDriftCount: number;
    queueMultipleInProgress: boolean;
    queueError?: string;
    activeIssue: { number: number } | null;
    openIssuesForMilestones: Parameters<typeof buildLifecycleDiagnostics>[0]['openIssues'];
  }> {
    let queueDriftCount = 0;
    let queueMultipleInProgress = false;
    let queueError: string | undefined;
    let activeIssue: { number: number } | null = null;
    const openIssuesForMilestones: Parameters<typeof buildLifecycleDiagnostics>[0]['openIssues'] = [];
    try {
      const q = await computeQueue();
      queueDriftCount = q.driftCount;
      queueMultipleInProgress = q.multipleInProgress;
      openIssuesForMilestones.push(...q.items.map(item => item.issue));
      const activeItems = q.items.filter(item => item.effectiveStatus === 'InProgress');
      activeIssue = activeItems.length === 1 ? activeItems[0].issue : null;
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

  private async readMilestones(config: Config, openIssuesForMilestones: Parameters<typeof buildLifecycleDiagnostics>[0]['openIssues'], recommendations: string[]): Promise<Pick<DoctorDiagnostics, 'milestones' | 'milestoneWarnings' | 'milestoneError'>> {
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

  private checkGit(): boolean {
    try {
      execSync('git --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
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

  private getRepoRoot(): string | null {
    try {
      return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  }

  private getCurrentBranch(): string {
    const repoRoot = this.getRepoRoot();
    if (!repoRoot) return 'unknown';
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim();
    } catch {
      return 'unknown';
    }
  }

  private checkIsWorktree(): boolean {
    const repoRoot = this.getRepoRoot();
    if (!repoRoot) return false;
    try {
      const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim();
      const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repoRoot }).trim();
      return gitDir !== commonDir && gitDir.split(/[\\/]/).includes('worktrees');
    } catch {
      return false;
    }
  }

  private async checkConfig(): Promise<{ present: boolean; valid: boolean; baseBranch?: string; baseRemote?: string; note?: string; errors?: ValidationError[] }> {
    const repoRoot = this.getRepoRoot();
    if (!repoRoot) return { present: false, valid: true, note: 'Not inside a git repository' };
    const configPath = join(repoRoot, 'aie.config.json');
    const present = existsSync(configPath);
    if (!present) return { present: false, valid: true, note: 'No aie.config.json — using built-in defaults' };
    try {
      const validation = validateConfig(JSON.parse(await readFile(configPath, 'utf8')));
      if (validation.ok && validation.config) return { present: true, valid: true, baseBranch: validation.config.baseBranch, baseRemote: validation.config.baseRemote };
      return { present: true, valid: false, errors: validation.errors, note: `aie.config.json has ${validation.errors.length} validation error(s)` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { present: true, valid: false, note: `Failed to read or parse aie.config.json: ${message}. Fix JSON syntax or file permissions, then rerun \`aie doctor --json\`.` };
    }
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

export function buildDoctorDiagnostics(): Promise<DoctorDiagnostics> {
  return new DoctorDiagnosticsBuilder().buildDiagnostics();
}
