const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { getDefaults } = require('../dist/config/index.js');
const { runInit } = require('../dist/init/index.js');
const { getInstructionStatus } = require('../dist/repo/index.js');
const { buildGateReadinessDiagnostics, buildInstructionPolicyDiagnostics, buildMigrationReadinessDiagnostics, buildProviderHealthDiagnostics, buildRepositoryPolicyDiagnostics, computeDoctorOk } = require('../dist/doctor.js');
const { hasCanonicalSupplyChainGuardInstruction, SUPPLY_CHAIN_GUARD_NAME, SUPPLY_CHAIN_GUARD_SKILL_PATH, SUPPLY_CHAIN_GUARD_URL } = require('../dist/supply_chain_guard.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-doctor-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

describe('doctor diagnostics', () => {
  it('reports managed instruction health and configured instruction policy', async () => {
    const repo = makeGitRepo();
    const config = getDefaults();
    config.instructions.namingRules = true;

    const init = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo, policy: { instructions: { namingRules: true } } });
    assert.equal(init.ok, true);

    const status = getInstructionStatus(repo);
    const policy = buildInstructionPolicyDiagnostics(config, repo);

    assert.equal(status.agents, true);
    assert.equal(status.claude, true);
    assert.equal(status.opencodeMakeItSo, true);
    assert.equal(status.opencodeMakeItSoManaged, true);
    assert.equal(status.targets.find(target => target.path === 'AGENTS.md').managed, true);
    assert.equal(status.targets.find(target => target.path === 'AGENTS.md').healthy, true);
    assert.equal(policy.namingRules.configured, true);
    assert.equal(policy.namingRules.installed, true);
    assert.equal(policy.implementationGuardrails.installed, true);
    assert.equal(policy.supplyChainSafety.installed, true);
    assert.equal(policy.canonicalSupplyChainGuard.installed, true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /Naming rules:/);
  });

  it('reports repository and supply-chain policy without mutating', () => {
    const config = getDefaults();
    config.noWorktree = true;
    config.blockOnOpenPRs = true;
    config.requireBaseBranchFreshness = true;
    config.baseRemote = 'upstream';
    config.baseBranch = 'trunk';
    config.milestoneOrdering.enabled = true;
    config.milestoneOrdering.missingAssignment = 'block';
    config.supplyChain.packageAgeDays = 9;

    const policy = buildRepositoryPolicyDiagnostics(config);

    assert.equal(policy.noWorktree, true);
    assert.equal(policy.blockOnOpenPRs, true);
    assert.equal(policy.requireBaseBranchFreshness, true);
    assert.equal(policy.baseRemote, 'upstream');
    assert.equal(policy.baseBranch, 'trunk');
    assert.equal(policy.milestoneOrdering, true);
    assert.equal(policy.missingMilestonePolicy, 'block');
    assert.equal(policy.supplyChain.packageAgeDays, 9);
  });

  it('reports provider health from normalized config policy', () => {
    const config = getDefaults();
    config.policy.labels.priorities = ['Urgent'];
    config.priorityLabels = ['Urgent'];
    config.normalizedPolicy.labels.priorities = [{ name: 'Urgent', description: '', color: '' }];

    const health = buildProviderHealthDiagnostics(config);

    assert.equal(health.providers.work.kind, 'github');
    assert.equal(health.providers.work.supported, true);
    assert.equal(health.providers.repository.kind, 'local-git');
    assert.equal(health.providers.repository.supported, true);
    assert.equal(health.normalizedPolicy.priorityLabels, 1);
    assert.equal(health.normalizedPolicy.baseRef, 'origin/main');
    assert.deepEqual(health.warnings, []);
  });

  it('reports actionable warnings for required unsupported provider kinds', () => {
    const config = getDefaults();
    config.providers.review.kind = 'local-git';
    config.providers.capabilities.review = true;

    const health = buildProviderHealthDiagnostics(config);

    assert.equal(health.providers.review.required, true);
    assert.equal(health.providers.review.supported, false);
    assert.equal(health.warnings.length, 1);
    assert.match(health.warnings[0], /Failed to validate review provider/);
    assert.match(health.warnings[0], /providers\.review\.kind/);
    assert.match(health.warnings[0], /Next action:/);
  });

  it('reports gate, audit, review, PR review, aiq, external-service, and supply-chain readiness', () => {
    const config = getDefaults();
    config.manualUiAudit = false;
    config.qualityControl = true;
    config.reviewAgents = ['@copilot', '@coderabbitai', 'oracle', 'custom bot'];
    config.reviewWaitMinutes = 3;
    config.gates = [
      { name: 'build', kind: 'build', command: 'npm run build', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
      { name: 'deploy check', kind: 'custom', command: 'node scripts/check-deploy.js', stage: 'pre-merge', required: false, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: true },
      { name: 'quality control', kind: 'aiq', command: 'aiq run', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.gates.configured, 3);
    assert.equal(diagnostics.gates.required, 2);
    assert.equal(diagnostics.gates.advisory, 1);
    assert.equal(diagnostics.gates.byStage['pre-pr'], 2);
    assert.equal(diagnostics.gates.byKind.aiq, 1);
    assert.equal(diagnostics.gates.supplyChainSensitive, 2);
    assert.deepEqual(diagnostics.gates.externalServiceGates, ['deploy check']);
    assert.equal(diagnostics.gates.evidence.total, 3);
    assert.equal(diagnostics.gates.evidence.notRecorded, 3);
    assert.equal(diagnostics.gates.gateEvidence.length, 3);
    assert.ok(diagnostics.gates.gateEvidence.every(gate => gate.source === 'configured-gate' && gate.trust === 'unverified' && gate.reasonCode === 'missing-evidence'));
    assert.equal(diagnostics.audit.manualUiAudit, false);
    assert.equal(diagnostics.audit.readiness, 'disabled');
    assert.equal(diagnostics.prReview.readiness, 'ready');
    assert.equal(diagnostics.prReview.reviewWaitMinutes, 3);
    assert.equal(diagnostics.aiq.enabled, true);
    assert.equal(diagnostics.aiq.configured, true);
    assert.ok(['ready', 'missing'].includes(diagnostics.aiq.readiness));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('github-copilot'));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('coderabbitai'));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('custom-pr-reviewer:custom-bot'));
    assert.ok(!diagnostics.reviewAgent.externalServices.includes('oracle'));
    assert.equal(diagnostics.supplyChain.readiness, 'ready');
    assert.ok(diagnostics.supplyChain.supplyChainSensitiveGates.includes('build'));
  });

  it('redacts token-like values from gate readiness diagnostics', () => {
    const token = 'ghp_' + '1234567890abcdef'.repeat(2) + '1234';
    const config = getDefaults();
    config.manualUiAudit = false;
    config.reviewAgents = [token];
    config.gates = [
      { name: token, kind: 'custom', command: `npm test ${token}`, stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: { TOKEN: token }, externalService: true },
    ];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: false });
    const serialized = JSON.stringify(diagnostics);

    assert.doesNotMatch(serialized, /1234567890abcdef/);
    assert.match(serialized, /\[REDACTED\]/);
    assert.ok(diagnostics.gates.externalServiceGates.includes('[REDACTED]'));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('custom-pr-reviewer:[REDACTED]'));
  });

  it('emits product-generic doctor JSON with gate readiness diagnostics', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'gh-queue.sh'), '#!/usr/bin/env bash\n');
    writeFileSync(join(repo, 'AGENTS.md'), 'Use gh-queue.sh before selecting the next issue.\n');

    const result = binRun(['doctor', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.command, 'doctor');
    assert.equal(parsed.providerHealth.providers.work.kind, 'github');
    assert.equal(parsed.providerHealth.providers.repository.kind, 'local-git');
    assert.equal(typeof parsed.providerHealth.normalizedPolicy.priorityLabels, 'number');
    assert.equal(typeof parsed.gateReadiness.gates.configured, 'number');
    assert.equal(typeof parsed.gateReadiness.gates.evidence.notRecorded, 'number');
    assert.equal(Array.isArray(parsed.gateReadiness.gates.gateEvidence), true);
    assert.equal(parsed.migrationReadiness.available, true);
    assert.equal(parsed.migrationReadiness.detectedPaths, 2);
    assert.equal(parsed.migrationReadiness.legacyState, 'detected');
    assert.deepEqual(parsed.migrationReadiness.detectedCategories, ['instruction-block', 'shell-helper']);
    assert.equal(parsed.migrationReadiness.wrapperState.installed, 0);
    assert.equal(parsed.migrationReadiness.remainingLegacyReferences.count, 1);
    assert.deepEqual(parsed.migrationReadiness.remainingLegacyReferences.paths, ['AGENTS.md']);
    assert.equal(parsed.migrationReadiness.cleanupStatus, 'blocked');
    assert.ok(parsed.migrationReadiness.recommendedCommands.includes('aie migrate legacy --cleanup --dry-run'));
    assert.equal(parsed.migrationReadiness.nextCommand, 'aie migrate legacy --dry-run');
    assert.equal(parsed.gateReadiness.audit.screenshotUpload, 'disabled');
    assert.equal(Array.isArray(parsed.gateReadiness.externalServices), true);
    assert.equal(parsed.recommendations.some(recommendation => recommendation.includes('Labels health check failed')), true);
  });

  it('reports config recommendations against the selected legacy config path', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'aie.config.json'), '{ invalid json');

    const result = binRun(['doctor', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.configPresent, true);
    assert.equal(parsed.configValid, false);
    assert.equal(parsed.recommendations.some(recommendation => recommendation.includes('Failed to read or parse aie.config.json')), true);
  });

  it('reports installed and stale compatibility wrapper state', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'gh-priority-order.sh'), [
      '#!/usr/bin/env sh',
      '# executor-compat-wrapper-version: 1',
      '# executor-compat-wrapper-command: aie stale',
      'exec aie stale "$@"',
      '',
    ].join('\n'));

    const plan = await require('../dist/migrate/index.js').buildMigrationPlan({ cwd: repo, dryRun: true });
    const diagnostics = buildMigrationReadinessDiagnostics(plan);

    assert.equal(diagnostics.wrapperState.installed, 1);
    assert.equal(diagnostics.wrapperState.stale, 1);
    assert.deepEqual(diagnostics.wrapperState.stalePaths, ['gh-priority-order.sh']);
    assert.equal(diagnostics.remainingLegacyReferences.count, 0);
    assert.ok(diagnostics.recommendedCommands.includes('aie migrate legacy --install-wrappers --dry-run'));
    assert.equal(diagnostics.recommendedCommands.includes('aie migrate legacy --install-wrappers --apply --dry-run'), false);
  });

  it('counts unique migration diagnostic paths', () => {
    const plan = {
      repoRoot: null,
      inventory: [
        { category: 'instruction-block', path: 'AGENTS.md', confidence: 'medium' },
        { category: 'workflow-doc', path: 'AGENTS.md', confidence: 'medium' },
      ],
      plannedFileChanges: [],
      cleanupCandidates: [],
      conflicts: [],
    };

    const diagnostics = buildMigrationReadinessDiagnostics(plan);

    assert.equal(diagnostics.detectedPaths, 1);
    assert.equal(diagnostics.remainingLegacyReferences.count, 1);
    assert.deepEqual(diagnostics.remainingLegacyReferences.paths, ['AGENTS.md']);
  });

  it('shows doctor help without running diagnostics', () => {
    const repo = makeGitRepo();

    const result = binRun(['doctor', '--help'], repo);

    assert.equal(result.status, 0);
    assert.match(result.stdout, /Check runtime environment/);
    assert.match(result.stdout, /--json/);
  });

  it('marks configured instruction policy missing when managed files are absent', () => {
    const repo = makeGitRepo();
    const config = getDefaults();
    config.instructions.namingRules = true;

    const policy = buildInstructionPolicyDiagnostics(config, repo);

    assert.equal(policy.namingRules.configured, true);
    assert.equal(policy.namingRules.installed, false);
    assert.equal(policy.implementationGuardrails.configured, true);
    assert.equal(policy.implementationGuardrails.installed, false);
    assert.equal(policy.supplyChainSafety.configured, true);
    assert.equal(policy.supplyChainSafety.installed, false);
    assert.equal(policy.canonicalSupplyChainGuard.configured, true);
    assert.equal(policy.canonicalSupplyChainGuard.installed, false);
  });

  it('requires the canonical guard reference for supply-chain instruction health', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'AGENTS.md'), [
      '<!-- BEGIN EXECUTOR MANAGED SECTION -->',
      'Supply-chain safety requires package-age gates before adding or upgrading dependencies.',
      '<!-- END EXECUTOR MANAGED SECTION -->',
      '',
    ].join('\n'));
    const config = getDefaults();

    const policy = buildInstructionPolicyDiagnostics(config, repo);

    assert.equal(policy.supplyChainSafety.installed, true);
    assert.equal(policy.canonicalSupplyChainGuard.installed, false);
  });

  it('matches canonical guard scope with bounded guarded-work tokens', () => {
    const baseText = `${SUPPLY_CHAIN_GUARD_NAME} ${SUPPLY_CHAIN_GUARD_URL} ${SUPPLY_CHAIN_GUARD_SKILL_PATH}`;

    assert.equal(hasCanonicalSupplyChainGuardInstruction(`${baseText} before CI work`), true);
    assert.equal(hasCanonicalSupplyChainGuardInstruction(`${baseText} before package manager work`), true);
    assert.equal(hasCanonicalSupplyChainGuardInstruction(`${baseText} artificial wording only`), false);
  });

  it('accounts for instruction health and configured worktree policy in readiness', () => {
    const healthy = {
      isRepo: true,
      configValid: true,
      gitAvailable: true,
      ghAvailable: true,
      nodeSatisfies: true,
      isWorktree: true,
      noWorktreePolicy: false,
      labelsOk: true,
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: true },
      blockingPullRequestCount: 0,
      instructionInstallOk: true,
    };

    assert.equal(computeDoctorOk(healthy), true);
    assert.equal(computeDoctorOk({ ...healthy, configValid: false }), false);
    assert.equal(computeDoctorOk({ ...healthy, noWorktreePolicy: true }), false);
    assert.equal(computeDoctorOk({ ...healthy, baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: false }, requireBaseBranchFreshness: false }), true);
    assert.equal(computeDoctorOk({ ...healthy, baseRef: { remote: 'origin', branch: 'main', resolved: true, upToDate: false }, requireBaseBranchFreshness: true }), false);
    assert.equal(computeDoctorOk({ ...healthy, blockingPullRequestCount: 0, pullRequestError: 'gh failed', blockOnOpenPRs: false }), true);
    assert.equal(computeDoctorOk({ ...healthy, blockingPullRequestCount: 0, pullRequestError: 'gh failed', blockOnOpenPRs: true }), false);
    assert.equal(computeDoctorOk({ ...healthy, instructionInstallOk: false }), false);
  });
});
