const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, delimiter, join } = require('node:path');

const { getDefaults } = require('../dist/config/index.js');
const { runInit } = require('../dist/init/index.js');
const { getInstructionStatus } = require('../dist/repo/index.js');
const { buildGateReadinessDiagnostics, buildInstructionPolicyDiagnostics, buildInstructionRecommendations, buildMigrationReadinessDiagnostics, buildProviderHealthDiagnostics, buildRepositoryPolicyDiagnostics, buildReviewPreflightDiagnostics, buildWorkflowReadiness, chooseNextCommand, computeDoctorOk, selectedAgentHosts } = require('../dist/doctor.js');
const { formatDoctorHuman } = require('../dist/renderers/doctor_renderer.js');
const { requiredLocalReviewLanes } = require('../dist/local_review_evidence.js');
const { hasCanonicalSupplyChainGuardInstruction, SUPPLY_CHAIN_GUARD_NAME, SUPPLY_CHAIN_GUARD_SKILL_PATH, SUPPLY_CHAIN_GUARD_URL } = require('../dist/supply_chain_guard.js');

function makeGitRepo() {
  return cloneGitRepo('configured', 'aie-doctor-');
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
    assert.equal(health.providers.ci.kind, 'github');
    assert.equal(health.providers.ci.supported, true);
    assert.equal(health.providers.repository.kind, 'local-git');
    assert.equal(health.providers.repository.supported, true);
    assert.equal(health.normalizedPolicy.priorityLabels, 1);
    assert.equal(health.normalizedPolicy.baseRef, 'origin/main');
    assert.deepEqual(health.warnings, []);
  });

  it('treats GitLab and Jenkins CI kinds as supported provider health', () => {
    const gitlab = getDefaults();
    gitlab.providers.ci.kind = 'gitlab';
    const jenkins = getDefaults();
    jenkins.providers.ci.kind = 'jenkins';

    assert.equal(buildProviderHealthDiagnostics(gitlab).providers.ci.supported, true);
    assert.equal(buildProviderHealthDiagnostics(jenkins).providers.ci.supported, true);
    assert.deepEqual(buildProviderHealthDiagnostics(gitlab).warnings, []);
    assert.deepEqual(buildProviderHealthDiagnostics(jenkins).warnings, []);
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
    config.reviewAdapter = 'mixed';
    config.reviewAgents = ['@copilot', '@coderabbitai', 'oracle', 'custom bot'];
    config.localReviewAgents = ['local-oracle'];
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
    assert.equal(diagnostics.prReview.adapter, 'mixed');
    assert.deepEqual(diagnostics.prReview.localReviewers, ['local-oracle']);
    assert.equal(diagnostics.prReview.localRunnerReadiness, 'missing');
    assert.equal(diagnostics.prReview.reviewWaitMinutes, 3);
    assert.equal(diagnostics.reviewAgent.adapter, 'mixed');
    assert.equal(diagnostics.reviewAgent.descriptorSupport.available, true);
    assert.equal(diagnostics.reviewAgent.descriptorSupport.runnerAvailable, false);
    assert.ok(diagnostics.reviewAgent.descriptorSupport.categories.includes('review'));
    assert.ok(diagnostics.reviewAgent.descriptorSupport.agents.includes('oracle'));
    assert.ok(diagnostics.reviewAgent.descriptorSupport.promptFragments.some(fragment => fragment.id === 'safety/review-output-untrusted'));
    assert.deepEqual(diagnostics.reviewAgent.localReviewers, ['local-oracle']);
    assert.equal(diagnostics.reviewAgent.localEvidenceRoot, '.qube/aie/reviews');
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'missing');
    assert.equal(diagnostics.reviewAgent.localRunner.codex.promptOnly, true);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.independentReviewer, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.freshContext, false);
    assert.equal(diagnostics.aiq.enabled, true);
    assert.equal(diagnostics.aiq.configured, true);
    assert.ok(['ready', 'missing'].includes(diagnostics.aiq.readiness));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('github-copilot'));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('coderabbitai'));
    assert.ok(diagnostics.reviewAgent.externalServices.includes('custom-pr-reviewer:custom-bot'));
    assert.ok(!diagnostics.reviewAgent.externalServices.includes('oracle'));
    assert.ok(!diagnostics.externalServices.includes('local-oracle'));
    assert.equal(diagnostics.supplyChain.readiness, 'ready');
    assert.ok(diagnostics.supplyChain.supplyChainSensitiveGates.includes('build'));
  });

  it('reports ready review-preflight diagnostics when local review is configured', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 3, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 42\nsize: 128\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo, read:org\n',
    });

    assert.equal(diagnostics.enabled, true);
    assert.equal(diagnostics.readiness, 'ready');
    assert.equal(diagnostics.checks.disk.readiness, 'ready');
    assert.equal(diagnostics.checks.dist.present, true);
    assert.equal(diagnostics.checks.dist.path, 'products/aie/dist/bin/run.js');
    assert.equal(diagnostics.checks.gitObjects.looseCount, 42);
    assert.equal(diagnostics.checks.githubReviewAuth.readiness, 'ready');
    assert.equal(diagnostics.checks.githubReviewAuth.authenticated, true);
    assert.deepEqual(diagnostics.nextActions, []);
  });

  it('reports missing dist and low disk as review-preflight action items', () => {
    const repo = makeGitRepo();
    const config = getDefaults();
    config.reviewAdapter = 'mixed';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 1, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
    });

    assert.equal(diagnostics.readiness, 'missing');
    assert.equal(diagnostics.checks.disk.readiness, 'needs-action');
    assert.match(diagnostics.checks.disk.nextAction, /2 GiB/);
    assert.equal(diagnostics.checks.dist.readiness, 'missing');
    assert.match(diagnostics.checks.dist.nextAction, /pnpm --filter @tjalve\/aie run build/);
    assert.ok(diagnostics.nextActions.length >= 2);
  });

  it('uses user-available disk blocks for review-preflight disk readiness', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 3, bavail: 1, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
    });

    assert.equal(diagnostics.readiness, 'needs-action');
    assert.equal(diagnostics.checks.disk.readiness, 'needs-action');
    assert.equal(diagnostics.checks.disk.freeBytes, 1024 * 1024 * 1024);
  });

  it('reports high loose git object counts with housekeeping guidance', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'shadow';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 50000\nsize: 100000\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
    });

    assert.equal(diagnostics.readiness, 'needs-action');
    assert.equal(diagnostics.checks.gitObjects.readiness, 'needs-action');
    assert.equal(diagnostics.checks.gitObjects.looseCount, 50000);
    assert.match(diagnostics.checks.gitObjects.nextAction, /git gc --prune=now/);
  });

  it('reports GitHub pull request review auth scope issues in review preflight', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: read:org\n',
    });

    assert.equal(diagnostics.readiness, 'needs-action');
    assert.equal(diagnostics.checks.githubReviewAuth.readiness, 'needs-action');
    assert.equal(diagnostics.checks.githubReviewAuth.authenticated, true);
    assert.deepEqual(diagnostics.checks.githubReviewAuth.scopes, ['read:org']);
    assert.match(diagnostics.checks.githubReviewAuth.nextAction, /pull request reviews/);
  });

  it('reports configured route probe results under review preflight', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-fallback-test', effort: 'low' };
    config.reviewFailover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const probed = [];

    const ready = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
      probeRoute: (host, model) => {
        probed.push(`${host}:${model}`);
        return { host, model, status: 'ready', executable: `${host}-probe`, version: 'probe-test', modelListed: host === 'grok-build' ? true : null, diagnostic: null };
      },
    });

    assert.equal(ready.readiness, 'ready');
    assert.equal(ready.checks.routeProbes.readiness, 'ready');
    assert.deepEqual(probed.sort(), ['codex:gpt-fallback-test', 'grok-build:grok-4.5']);
    assert.equal(ready.checks.routeProbes.routes.length, 2);
    assert.ok(ready.checks.routeProbes.routes.every(route => route.status === 'ready'));

    const blocked = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
      probeRoute: (host, model) => (host === 'grok-build'
        ? { host, model, status: 'blocked', executable: null, version: null, modelListed: false, diagnostic: `Configured review model "${model}" is not in the grok catalog. Update the trusted review model configuration to a listed model.` }
        : { host, model, status: 'ready', executable: 'codex-probe', version: 'probe-test', modelListed: null, diagnostic: null }),
    });

    assert.equal(blocked.checks.routeProbes.readiness, 'needs-action');
    assert.equal(blocked.readiness, 'needs-action');
    const blockedRoute = blocked.checks.routeProbes.routes.find(route => route.host === 'grok-build');
    assert.match(blockedRoute.nextAction, /not in the grok catalog/);
    assert.ok(blocked.nextActions.some(action => /blocked review route/.test(action)));
    assert.ok(blocked.nextActions.some(action => /not in the grok catalog/.test(action)));
  });

  it('keeps route probes disabled when no routed review lanes are configured', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';
    let probeCalls = 0;

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'count: 2\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
      probeRoute: () => { probeCalls += 1; throw new Error('must not probe'); },
    });

    assert.equal(probeCalls, 0);
    assert.equal(diagnostics.checks.routeProbes.readiness, 'disabled');
    assert.deepEqual(diagnostics.checks.routeProbes.routes, []);
    assert.equal(diagnostics.readiness, 'ready');
  });

  it('reports malformed loose git object output as unavailable', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => 'unexpected output\n',
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
    });

    assert.equal(diagnostics.readiness, 'unavailable');
    assert.equal(diagnostics.checks.gitObjects.readiness, 'unavailable');
    assert.equal(diagnostics.checks.gitObjects.looseCount, null);
    assert.match(diagnostics.checks.gitObjects.nextAction, /git count-objects -v/);
  });

  it('reports failed loose git object inspection as unavailable', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, 'products', 'aie', 'dist', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'dist', 'bin', 'run.js'), 'export function run() {}\n');
    const config = getDefaults();
    config.reviewAdapter = 'local';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: repo,
      statfs: () => ({ bfree: 4, bsize: 1024 * 1024 * 1024 }),
      gitCountObjects: () => { throw new Error('git timed out'); },
      ghAuthStatus: () => 'Logged in to github.com\nToken scopes: repo\n',
    });

    assert.equal(diagnostics.readiness, 'unavailable');
    assert.equal(diagnostics.checks.gitObjects.readiness, 'unavailable');
    assert.equal(diagnostics.checks.gitObjects.looseCount, null);
    assert.match(diagnostics.checks.gitObjects.nextAction, /could not inspect loose git objects/);
  });

  it('keeps review-preflight disabled when local review is off', () => {
    const config = getDefaults();
    config.reviewAdapter = 'github';

    const diagnostics = buildReviewPreflightDiagnostics(config, {
      repoRoot: process.cwd(),
      statfs: () => { throw new Error('should not run'); },
      gitCountObjects: () => { throw new Error('should not run'); },
    });

    assert.equal(diagnostics.enabled, false);
    assert.equal(diagnostics.readiness, 'disabled');
    assert.deepEqual(diagnostics.nextActions, []);
  });

  it('reports configured local-command runner readiness separately from Codex host review support', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-command',
      command: 'aie:fixture-local-review',
    }];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.reviewAgent.descriptorSupport.runnerAvailable, true);
    assert.equal(diagnostics.reviewAgent.localRunner.configured, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'ready');
    assert.equal(diagnostics.reviewAgent.localRunner.command, 'aie:fixture-local-review');
    assert.equal(diagnostics.reviewAgent.localRunner.codex.promptOnly, true);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.codex.missingCapabilities, ['codex-local-reviewer-not-configured']);
    assert.equal(diagnostics.prReview.localRunnerReadiness, 'ready');
  });

  it('reports commandless local-host lanes as Codex subagent host action', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.localReviewAgents = ['codex'];
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
    }];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.reviewAgent.localRunner.configured, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'needs-action');
    assert.equal(diagnostics.reviewAgent.localRunner.capabilities.canRun, true);
    assert.equal(diagnostics.reviewAgent.localRunner.capabilities.canRunShell, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.independentReviewer, true);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.promptOnly, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.freshContext, true);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.codex.missingCapabilities, []);
    assert.match(diagnostics.reviewAgent.localRunner.nextAction, /spawnPrompt/);
  });

  function isolatedLocalHostConfig() {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewMode = 'isolated';
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    config.reviewFailover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    config.localReviewAgents = ['grok-build', 'codex'];
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    config.reviewModels.review.codex = { model: 'gpt-5.6-luna', effort: null };
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
    }];
    return config;
  }

  function readyProbe(host, model) {
    return { host, model, status: 'ready', executable: `${host}-probe`, version: 'probe-test', modelListed: true, diagnostic: null };
  }

  it('reports isolated review as ready when Grok and Codex routes probe ready', () => {
    const config = isolatedLocalHostConfig();
    const diagnostics = buildGateReadinessDiagnostics(config, {
      ghAuthenticated: true,
      probeRoute: readyProbe,
    });
    const workflow = buildWorkflowReadiness({
      config,
      configValid: true,
      labelsOk: true,
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      queueError: undefined,
      lifecycle: {
        branchNamingValid: true,
        inProgressIssueCount: 0,
        activeIssueNumber: null,
        activeIssueBranch: null,
        currentBranchMatchesActiveIssue: null,
        linkedWorktreeBlocked: false,
        openPullRequestCheckEnabled: true,
        baseBranchFresh: true,
        queueError: undefined,
        lifecycleCommandsReady: true,
      },
      gateReadiness: diagnostics,
      instructions: {
        agents: false,
        agentsManaged: false,
        claude: false,
        claudeManaged: false,
        opencodeMakeItSo: false,
        opencodeMakeItSoManaged: false,
        opencodeMakeitsoAlias: false,
        opencodeMakeitsoAliasManaged: false,
        codexReviewFocusAgent: false,
        codexReviewFocusAgentManaged: false,
        targets: [],
      },
      dirty: { dirty: false, entries: [] },
      currentBranch: 'main',
      blockingPullRequests: [],
      evidence: { head: null, lanes: [] },
    });
    const byStage = Object.fromEntries(workflow.stages.map(stage => [stage.stage, stage]));

    assert.equal(diagnostics.reviewAgent.mode, 'isolated');
    assert.equal(diagnostics.reviewAgent.localRunner.configured, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'ready');
    assert.equal(diagnostics.reviewAgent.localRunner.capabilities.canRun, true);
    assert.match(diagnostics.reviewAgent.localRunner.nextAction, /aie pr gate/);
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction, /spawnPrompt/);
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction, /Codex subagent/);
    assert.equal(byStage.review.status, 'ready');
    assert.equal(workflow.review.state, 'local-lanes');
    assert.notEqual(workflow.review.state, 'fallback-only');
  });

  it('does not report isolated review ready when a route probe is blocked', () => {
    const config = isolatedLocalHostConfig();
    const diagnostics = buildGateReadinessDiagnostics(config, {
      ghAuthenticated: true,
      probeRoute: (host, model) => (host === 'grok-build'
        ? { host, model, status: 'blocked', executable: null, version: null, modelListed: false, diagnostic: 'Grok route is blocked.' }
        : readyProbe(host, model)),
    });

    assert.notEqual(diagnostics.reviewAgent.localRunner.readiness, 'ready');
    assert.ok(diagnostics.reviewAgent.localRunner.readiness === 'needs-action' || diagnostics.reviewAgent.localRunner.readiness === 'missing');
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction ?? '', /spawnPrompt/);
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction ?? '', /paste/);
  });

  it('does not report isolated review ready when no route targets exist', () => {
    const config = isolatedLocalHostConfig();
    config.reviewRoute = null;
    config.reviewFailover = null;
    config.reviewModels.review = {};
    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true, probeRoute: readyProbe });

    assert.notEqual(diagnostics.reviewAgent.localRunner.readiness, 'ready');
    assert.ok(diagnostics.reviewAgent.localRunner.readiness === 'needs-action' || diagnostics.reviewAgent.localRunner.readiness === 'missing');
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction ?? '', /spawnPrompt/);
    assert.doesNotMatch(diagnostics.reviewAgent.localRunner.nextAction ?? '', /local-command review lane command/);
  });

  it('does not claim commandless local-host review support without configured Codex agent', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.localReviewAgents = [];
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
    }];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.reviewAgent.localRunner.configured, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'missing');
    assert.equal(diagnostics.reviewAgent.localRunner.capabilities.canRun, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.independentReviewer, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.promptOnly, true);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.codex.missingCapabilities, ['codex-local-reviewer-not-configured']);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.missingTools, ['codex local review agent']);
  });

  it('reports OpenCode local-host review-runner status distinctly from Codex', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.localReviewAgents = ['opencode'];
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
    }];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.reviewAgent.localRunner.configured, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'missing');
    assert.equal(diagnostics.reviewAgent.localRunner.codex.independentReviewer, false);
    assert.equal(diagnostics.reviewAgent.localRunner.opencode.independentReviewer, false);
    assert.equal(diagnostics.reviewAgent.localRunner.opencode.promptOnly, true);
    assert.equal(diagnostics.reviewAgent.localRunner.opencode.hooks, true);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.opencode.missingCapabilities, ['opencode-local-review-runner-unsupported']);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.missingTools, ['opencode local review runner']);
    assert.match(diagnostics.reviewAgent.localRunner.nextAction, /OpenCode does not currently expose/);
  });

  it('reports configured local-host command as Codex independent review capability', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewLanes = [{
      id: 'issue-compliance',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
      command: 'aie:fixture-local-review',
    }];

    const diagnostics = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });

    assert.equal(diagnostics.reviewAgent.descriptorSupport.runnerAvailable, true);
    assert.equal(diagnostics.reviewAgent.localRunner.readiness, 'ready');
    assert.equal(diagnostics.reviewAgent.localRunner.command, 'aie:fixture-local-review');
    assert.equal(diagnostics.reviewAgent.localRunner.codex.independentReviewer, true);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.promptOnly, false);
    assert.equal(diagnostics.reviewAgent.localRunner.codex.freshContext, true);
    assert.deepEqual(diagnostics.reviewAgent.localRunner.codex.missingCapabilities, []);
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

describe('staged workflow readiness', () => {
  function healthyLifecycle(overrides = {}) {
    return {
      branchNamingValid: true,
      inProgressIssueCount: 0,
      activeIssueNumber: null,
      activeIssueBranch: null,
      currentBranchMatchesActiveIssue: null,
      linkedWorktreeBlocked: false,
      openPullRequestCheckEnabled: true,
      baseBranchFresh: true,
      queueError: undefined,
      lifecycleCommandsReady: true,
      ...overrides,
    };
  }

  function instructionsFixture(overrides = {}) {
    return {
      agents: false,
      agentsManaged: false,
      claude: false,
      claudeManaged: false,
      opencodeMakeItSo: false,
      opencodeMakeItSoManaged: false,
      opencodeMakeitsoAlias: false,
      opencodeMakeitsoAliasManaged: false,
      codexReviewFocusAgent: false,
      codexReviewFocusAgentManaged: false,
      targets: [],
      ...overrides,
    };
  }

  function workflowInput(config, gateReadiness, overrides = {}) {
    return {
      config,
      configValid: true,
      labelsOk: true,
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      queueError: undefined,
      lifecycle: healthyLifecycle(),
      gateReadiness,
      instructions: instructionsFixture(),
      dirty: { dirty: false, entries: [] },
      currentBranch: 'main',
      blockingPullRequests: [],
      evidence: { head: null, lanes: [] },
      ...overrides,
    };
  }

  function stagesById(workflow) {
    return Object.fromEntries(workflow.stages.map(stage => [stage.stage, stage]));
  }

  it('reports lifecycle ready, gates unconfigured, review fallback-only, issue start blocked, and manual shipping for a fallback-only repository', () => {
    const config = getDefaults();
    config.reviewAgents = [];
    config.autonomousMode = false;
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const workflow = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      instructions: instructionsFixture({ agents: true, agentsManaged: true }),
      dirty: { dirty: true, entries: ['?? .qube/aie/config.json'] },
    }));
    const byStage = stagesById(workflow);
    assert.equal(byStage['lifecycle'].status, 'ready');
    assert.equal(byStage['quality-gates'].status, 'unconfigured');
    assert.equal(byStage['review'].status, 'fallback-only');
    assert.equal(byStage['issue-start'].status, 'blocked');
    assert.match(byStage['issue-start'].detail, /dirty primary checkout/);
    assert.match(byStage['issue-start'].detail, /\.qube\/aie\/config\.json/);
    assert.equal(byStage['shipping'].status, 'manual');
    assert.equal(byStage['shipping'].nextAction, null);
    assert.deepEqual(workflow.shipping, { mode: 'manual' });
    assert.deepEqual(workflow.selectedHosts, ['codex']);
    // The safe fallback prompt stays available without being represented as enforced review execution.
    assert.equal(workflow.review.fallbackPromptAvailable, true);
    assert.equal(workflow.review.fallbackEnforcesReview, false);
    assert.equal(workflow.review.state, 'fallback-only');
    // Exactly one prioritized next action per incomplete stage; complete stages and explicit modes carry none.
    for (const stage of workflow.stages) {
      if (stage.status === 'ready' || stage.status === 'manual' || stage.status === 'disabled') {
        assert.equal(stage.nextAction, null, `${stage.stage} must not demand action`);
      } else {
        assert.equal(typeof stage.nextAction, 'string', `${stage.stage} must carry a next action`);
        assert.notEqual(stage.nextAction.trim(), '');
      }
    }
  });

  it('names a present-but-failing agent-browser in the ui-audit stage', () => {
    const fixtureBin = mkdtempSync(join(tmpdir(), 'aie-doctor-workflow-probe-'));
    try {
      const windows = process.platform === 'win32';
      const file = join(fixtureBin, windows ? 'agent-browser.cmd' : 'agent-browser');
      if (windows) writeFileSync(file, '@echo off\r\nexit /b 7\r\n');
      else {
        writeFileSync(file, '#!/bin/sh\nexit 7\n');
        chmodSync(file, 0o755);
      }
      const config = getDefaults();
      config.manualUiAudit = true;
      const gateReadiness = buildGateReadinessDiagnostics(config, {
        ghAuthenticated: true,
        env: windows ? { OS: 'Windows_NT', PATH: fixtureBin, PATHEXT: '.CMD;.EXE' } : { PATH: fixtureBin },
        platform: process.platform,
        pathDelimiter: delimiter,
      });
      const workflow = buildWorkflowReadiness(workflowInput(config, gateReadiness));
      const stage = stagesById(workflow)['ui-audit'];
      assert.equal(stage.status, 'needs-action');
      assert.match(stage.detail, /capability probe/);
    } finally {
      rmSync(fixtureBin, { recursive: true, force: true });
    }
  });

  it('reports zero configured gates as unconfigured, not implicitly healthy', () => {
    const config = getDefaults();
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    assert.equal(gateReadiness.gates.configured, 0);
    const workflow = buildWorkflowReadiness(workflowInput(config, gateReadiness));
    const gatesStage = stagesById(workflow)['quality-gates'];
    assert.equal(gatesStage.status, 'unconfigured');
    assert.notEqual(gatesStage.status, 'ready');
    assert.match(gatesStage.nextAction, /gates/i);
  });

  it('blocks issue start on a dirty checkout even when everything else is ready', () => {
    const config = getDefaults();
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const clean = buildWorkflowReadiness(workflowInput(config, gateReadiness));
    assert.equal(stagesById(clean)['issue-start'].status, 'ready');
    assert.equal(stagesById(clean)['issue-start'].nextAction, null);
    const dirty = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      dirty: { dirty: true, entries: [' M src/setup.ts'] },
    }));
    const stage = stagesById(dirty)['issue-start'];
    assert.equal(stage.status, 'blocked');
    assert.match(stage.detail, /uncommitted changes/);
    assert.match(stage.nextAction, /primary checkout/);
  });

  it('reports lanes, runner, publisher, and current evidence independently for a local-host review profile', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewAgents = [];
    config.reviewLanes = [
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', command: 'claude --print' },
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', command: 'claude --print' },
    ];
    config.providers.review.publisher = { mode: 'token' };
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const withEvidence = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      evidence: { head: 'abc123', lanes: ['code-quality', 'issue-compliance', 'performance'] },
    }));
    assert.deepEqual(withEvidence.review.lanes.required, [...requiredLocalReviewLanes('local-focused')]);
    assert.deepEqual(withEvidence.review.lanes.configured, ['issue-compliance', 'code-quality']);
    assert.equal(withEvidence.review.lanes.runnerReadiness, 'ready');
    assert.deepEqual(withEvidence.review.publisher, { configured: true, mode: 'token' });
    assert.deepEqual(withEvidence.review.evidence, { state: 'present', head: 'abc123', lanes: ['code-quality', 'issue-compliance', 'performance'] });
    assert.equal(withEvidence.review.state, 'evidence-ready');
    assert.equal(stagesById(withEvidence)['review'].status, 'ready');
    // Partial required-lane coverage stays local-lanes: evidence-ready needs every required lane covered.
    const partialEvidence = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      evidence: { head: 'abc123', lanes: ['code-quality'] },
    }));
    assert.equal(partialEvidence.review.state, 'local-lanes');
    assert.equal(partialEvidence.review.evidence.state, 'present');
    // The same profile without current-head evidence reports the lanes and runner unchanged but the evidence gap independently.
    const withoutEvidence = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      evidence: { head: 'abc123', lanes: [] },
    }));
    assert.equal(withoutEvidence.review.state, 'local-lanes');
    assert.equal(withoutEvidence.review.evidence.state, 'missing');
    assert.equal(withoutEvidence.review.lanes.runnerReadiness, 'ready');
    // Lock files, raw-output captures, and unknown names never count as lane evidence.
    const forgedEvidence = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      evidence: { head: 'abc123', lanes: ['.review-lock', 'code-quality.raw-output', 'not-a-lane'] },
    }));
    assert.equal(forgedEvidence.review.evidence.state, 'missing');
    assert.deepEqual(forgedEvidence.review.evidence.lanes, []);
    assert.equal(forgedEvidence.review.state, 'local-lanes');
    // Without a current PR head, evidence is not applicable instead of fabricated.
    const noHead = buildWorkflowReadiness(workflowInput(config, gateReadiness));
    assert.equal(noHead.review.evidence.state, 'not-applicable');
  });

  it('reports readiness for each configured review source independently, dropping disabled sources', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewAgents = [];
    config.reviewLanes = [
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', command: 'claude --print' },
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', command: 'claude --print' },
    ];
    config.reviewSources = [
      { id: 'local-lanes', identity: 'lane', expected: ['issue-compliance', 'code-quality'], blocking: true, markers: 'trusted', enabled: true },
      { id: 'security-reviewer', identity: 'reviewer', expected: ['security-lead'], blocking: false, markers: 'provider', enabled: true },
      { id: 'disabled-source', identity: 'reviewer', expected: ['someone'], blocking: true, markers: 'trusted', enabled: false },
    ];
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const workflow = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      evidence: { head: 'abc123', lanes: ['issue-compliance'] },
    }));

    assert.deepEqual(workflow.review.sources.map(source => source.id), ['local-lanes', 'security-reviewer']);
    const laneSource = workflow.review.sources.find(source => source.id === 'local-lanes');
    assert.equal(laneSource.identity, 'lane');
    assert.equal(laneSource.readiness, 'missing');
    assert.match(laneSource.detail, /code-quality/);
    const reviewerSource = workflow.review.sources.find(source => source.id === 'security-reviewer');
    assert.equal(reviewerSource.identity, 'reviewer');
    assert.equal(reviewerSource.blocking, false);
    assert.equal(reviewerSource.readiness, 'ready');
  });

  it('reports issue start unavailable when the working tree cannot be observed', () => {
    const config = getDefaults();
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const workflow = buildWorkflowReadiness(workflowInput(config, gateReadiness, {
      dirty: { dirty: false, entries: [], error: 'git status failed: not a git repository' },
    }));
    const stage = stagesById(workflow)['issue-start'];
    assert.equal(stage.status, 'unavailable');
    assert.notEqual(stage.status, 'ready');
    assert.match(stage.detail, /could not be observed/);
    assert.match(stage.detail, /not reported as clean/);
    assert.match(stage.nextAction, /git/);
  });

  it('never recommends OpenCode initialization for a Codex-only repository', () => {
    const config = getDefaults();
    const instructionPolicy = buildInstructionPolicyDiagnostics(config, null);
    const codexOnly = instructionsFixture({
      agents: true,
      agentsManaged: true,
      codexReviewFocusAgent: true,
      codexReviewFocusAgentManaged: true,
      targets: [{ name: 'agents', path: 'AGENTS.md', present: true, managed: true, checksumValid: true, healthy: true }],
    });
    const recommendations = buildInstructionRecommendations({ repoRoot: '/repo', instructions: codexOnly, instructionPolicy, supplyChainSafetyConfigured: false });
    assert.equal(recommendations.some(entry => entry.includes('OpenCode')), false);
    assert.equal(chooseNextCommand(true, recommendations).includes('opencode'), false);
    assert.deepEqual(selectedAgentHosts(codexOnly), ['codex']);
    // A present-but-unmanaged OpenCode asset is a selected host that still gets the repair recommendation.
    const opencodeUnmanaged = instructionsFixture({ agents: true, agentsManaged: true, opencodeMakeItSo: true });
    const repairRecommendations = buildInstructionRecommendations({ repoRoot: '/repo', instructions: opencodeUnmanaged, instructionPolicy, supplyChainSafetyConfigured: false });
    assert.equal(repairRecommendations.some(entry => entry.includes('OpenCode project command is not installed')), true);
    assert.deepEqual(selectedAgentHosts(opencodeUnmanaged), ['codex', 'opencode']);
  });

  it('exposes the same staged readiness in doctor JSON and human output', () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, 'uncommitted-setup.txt'), 'setup\n');

    const result = binRun(['doctor', '--json'], repo);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.workflowReadiness, 'doctor JSON must expose workflowReadiness');
    assert.deepEqual(parsed.workflowReadiness.stages.map(stage => stage.stage), ['lifecycle', 'issue-start', 'quality-gates', 'review', 'publication', 'ui-audit', 'shipping']);
    const issueStart = parsed.workflowReadiness.stages.find(stage => stage.stage === 'issue-start');
    assert.equal(issueStart.status, 'blocked');
    assert.match(issueStart.detail, /uncommitted-setup\.txt/);

    const human = formatDoctorHuman(parsed);
    assert.match(human, /Workflow readiness:/);
    for (const stage of parsed.workflowReadiness.stages) {
      const line = `- ${stage.stage}: ${stage.status} — ${stage.detail}${stage.nextAction ? ` Next: ${stage.nextAction}` : ''}`;
      assert.ok(human.includes(line), `human output must contain the staged line for ${stage.stage}`);
    }
    assert.ok(human.includes(`Shipping mode: ${parsed.workflowReadiness.shipping.mode}`));
    assert.ok(human.includes(`Review state: ${parsed.workflowReadiness.review.state};`));
  });
});

describe('workflow evidence identity', () => {
  it('counts provider reviewers only for adapters that run them', () => {
    const config = getDefaults();
    config.reviewAdapter = 'local';
    config.reviewAgents = ['coderabbitai'];
    config.reviewLanes = [];
    const gateReadiness = buildGateReadinessDiagnostics(config, { ghAuthenticated: true });
    const workflow = buildWorkflowReadiness({
      config,
      configValid: true,
      labelsOk: true,
      queueDriftCount: 0,
      queueMultipleInProgress: false,
      queueError: undefined,
      lifecycle: {
        branchNamingValid: true,
        inProgressIssueCount: 0,
        activeIssueNumber: null,
        activeIssueBranch: null,
        currentBranchMatchesActiveIssue: null,
        linkedWorktreeBlocked: false,
        openPullRequestCheckEnabled: true,
        baseBranchFresh: true,
        queueError: undefined,
        lifecycleCommandsReady: true,
      },
      gateReadiness,
      instructions: {
        agents: false,
        agentsManaged: false,
        claude: false,
        claudeManaged: false,
        opencodeMakeItSo: false,
        opencodeMakeItSoManaged: false,
        opencodeMakeitsoAlias: false,
        opencodeMakeitsoAliasManaged: false,
        codexReviewFocusAgent: false,
        codexReviewFocusAgentManaged: false,
        targets: [],
      },
      dirty: { dirty: false, entries: [], error: null },
      currentBranch: 'main',
      blockingPullRequests: [],
      evidence: { head: null, lanes: [] },
    });
    // The local adapter never runs provider reviewers, so their names cannot make review readiness ready.
    assert.deepEqual(workflow.review.providerReviewers, []);
    assert.notEqual(workflow.review.state, 'provider-reviewers');
  });

  it('accepts only identity-bound lane evidence records inside the evidence root', () => {
    const { matchesLaneEvidenceIdentity } = require('../dist/doctor.js');
    const { realpathSync, symlinkSync, rmSync } = require('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'aie-evidence-identity-'));
    const evidenceRoot = join(root, '.qube', 'aie', 'reviews');
    const headDir = join(evidenceRoot, '304', '395', 'abc123');
    mkdirSync(headDir, { recursive: true });
    const rootReal = realpathSync(evidenceRoot);

    const validRecord = {
      lane: 'code-quality',
      issueNumber: 304,
      prNumber: 395,
      headSha: 'abc123',
      status: 'passed',
      runnerProvenance: { runnerKind: 'local-host', host: 'model-host' },
    };
    writeFileSync(join(headDir, 'code-quality.json'), JSON.stringify(validRecord));
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'code-quality.json'), rootReal, 'code-quality', 304, 395, 'abc123'), true);

    // Empty, forged, or mismatched records never count as current evidence.
    writeFileSync(join(headDir, 'issue-compliance.json'), '{}');
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'issue-compliance.json'), rootReal, 'issue-compliance', 304, 395, 'abc123'), false);
    writeFileSync(join(headDir, 'performance.json'), JSON.stringify({ ...validRecord, lane: 'performance', headSha: 'stale99' }));
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'performance.json'), rootReal, 'performance', 304, 395, 'abc123'), false);
    writeFileSync(join(headDir, 'tests-quality.json'), JSON.stringify({ ...validRecord, lane: 'code-quality' }));
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'tests-quality.json'), rootReal, 'tests-quality', 304, 395, 'abc123'), false);
    writeFileSync(join(headDir, 'manual-qa.json'), JSON.stringify({ ...validRecord, lane: 'manual-qa', runnerProvenance: null }));
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'manual-qa.json'), rootReal, 'manual-qa', 304, 395, 'abc123'), false);
    writeFileSync(join(headDir, 'final-gate.json'), 'not json');
    assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'final-gate.json'), rootReal, 'final-gate', 304, 395, 'abc123'), false);

    // A symlink resolving outside the evidence root is rejected even with valid content.
    const outsideFile = join(root, 'outside-evidence.json');
    writeFileSync(outsideFile, JSON.stringify({ ...validRecord, lane: 'task-record-compliance' }));
    let symlinkCreated = false;
    try {
      symlinkSync(outsideFile, join(headDir, 'task-record-compliance.json'), 'file');
      symlinkCreated = true;
    } catch {
      // Symlink creation needs elevated rights on some Windows setups; the containment rule is still enforced at runtime.
    }
    if (symlinkCreated) {
      assert.equal(matchesLaneEvidenceIdentity(join(headDir, 'task-record-compliance.json'), rootReal, 'task-record-compliance', 304, 395, 'abc123'), false);
    }
    rmSync(root, { recursive: true, force: true });
  });
});

describe('review session locks', () => {
  const { findReviewSessionLocks, REVIEW_SESSION_LOCK_MAX_AGE_MINUTES } = require('../dist/app/local_review_runner_support.js');

  function writeLock(repo, issue, pr, head, body) {
    const dir = join(repo, '.qube', 'aie', 'reviews', String(issue), String(pr), head);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.review-lock.json'), body);
    return `.qube/aie/reviews/${issue}/${pr}/${head}/.review-lock.json`;
  }

  it('detects fresh, stale, malformed, and head-mismatched locks with cleanup guidance', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-review-lock-'));
    const now = Date.parse('2026-07-19T12:00:00Z');
    const freshPath = writeLock(repo, 93, 12, 'abc123', JSON.stringify({ version: 1, issueNumber: 93, prNumber: 12, headSha: 'abc123', createdAt: new Date(now - 5 * 60_000).toISOString() }));
    const stalePath = writeLock(repo, 94, 13, 'def456', JSON.stringify({ version: 1, issueNumber: 94, prNumber: 13, headSha: 'def456', createdAt: new Date(now - 2 * 60 * 60_000).toISOString() }));
    const malformedPath = writeLock(repo, 95, 14, 'ghi789', 'not json');

    const locks = findReviewSessionLocks(repo, { now });
    const byPath = Object.fromEntries(locks.map(lock => [lock.path, lock]));
    assert.equal(locks.length, 3);
    assert.equal(byPath[freshPath].stale, false);
    assert.match(byPath[freshPath].reason, /active review session/);
    assert.equal(byPath[stalePath].stale, true);
    assert.match(byPath[stalePath].reason, new RegExp(`${REVIEW_SESSION_LOCK_MAX_AGE_MINUTES}-minute staleness threshold`));
    assert.match(byPath[stalePath].cleanupCommand, /Delete \.qube\/aie\/reviews\/94\/13\/def456\/\.review-lock\.json/);
    assert.equal(byPath[malformedPath].stale, true);
    assert.match(byPath[malformedPath].reason, /malformed/);
    // Scoped to one PR, a fresh lock for an older head counts as stale.
    const scoped = findReviewSessionLocks(repo, { now, prNumber: 12, currentHeadSha: 'newhead' });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0].stale, true);
    assert.match(scoped[0].reason, /not the current PR head/);
    // No locks means no reports.
    const empty = mkdtempSync(join(tmpdir(), 'aie-review-lock-empty-'));
    assert.deepEqual(findReviewSessionLocks(empty, { now }), []);
    // An unreadable evidence directory fails closed as an unknown-state stale report.
    const unreadable = mkdtempSync(join(tmpdir(), 'aie-review-lock-unreadable-'));
    mkdirSync(join(unreadable, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(unreadable, '.qube', 'aie', 'reviews'), 'not a directory');
    const failedClosed = findReviewSessionLocks(unreadable, { now });
    assert.equal(failedClosed.length, 1);
    assert.equal(failedClosed[0].stale, true);
    assert.match(failedClosed[0].reason, /could not be read/);
    assert.match(failedClosed[0].cleanupCommand, /Fix filesystem access/);
  });

  it('reports stale locks through doctor with cleanup guidance', () => {
    const repo = makeGitRepo();
    const dir = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.review-lock.json'), JSON.stringify({ version: 1, issueNumber: 93, prNumber: 12, headSha: 'abc123', createdAt: '2026-01-01T00:00:00Z' }));

    const result = binRun(['doctor', '--json'], repo);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.reviewSessionLocks.length, 1);
    assert.equal(parsed.reviewSessionLocks[0].stale, true);
    assert.match(parsed.reviewSessionLocks[0].cleanupCommand, /Delete \.qube\/aie\/reviews\/93\/12\/abc123\/\.review-lock\.json/);
    assert.equal(parsed.recommendations.some(entry => entry.includes('Stale review session lock detected')), true);
    const human = formatDoctorHuman(parsed);
    assert.match(human, /Review session locks: .*\(stale\)/);
    assert.match(human, /Stale review lock: /);
  });

  it('blocks issue start while a review session lock exists and names the unblocking command', async () => {
    const { buildPreStartPolicy } = require('../dist/app/pre_start_policy.js');
    const repo = makeGitRepo();
    const dir = join(repo, '.qube', 'aie', 'reviews', '93', '12', 'abc123');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.review-lock.json'), JSON.stringify({ version: 1, issueNumber: 93, prNumber: 12, headSha: 'abc123', createdAt: '2026-01-01T00:00:00Z' }));
    const config = getDefaults();
    config.requireBaseBranchFreshness = false;
    config.blockOnOpenPRs = true;
    const exec = async () => ({ stdout: '[]', stderr: '', code: 0 });

    const policy = await buildPreStartPolicy({ config, issueNumber: 93, bypassForResume: false, exec, cwd: repo });
    const lockCheck = policy.checks.find(check => check.name === 'review-lock');
    assert.equal(lockCheck.ok, false);
    assert.match(lockCheck.reason, /stale review session lock/i);
    assert.match(lockCheck.reason, /Delete \.qube\/aie\/reviews\/93\/12\/abc123\/\.review-lock\.json/);
    assert.equal(policy.ok, false);

    // Resume bypass skips the lock check like the other pre-start checks.
    const bypassed = await buildPreStartPolicy({ config, issueNumber: 93, bypassForResume: true, exec, cwd: repo });
    assert.equal(bypassed.checks.find(check => check.name === 'review-lock').skipped, true);
  });
});

describe('doctor executable lookup', () => {
  it('reports a working agent-browser as available without which on PATH', () => {
    const fixture = createLookupFixture('agent-browser', 0);
    try {
      assert.equal(existsSync(join(fixture.bin, 'which')), false);
      assert.equal(existsSync(join(fixture.bin, 'which.exe')), false);
      const config = getDefaults();
      config.manualUiAudit = true;
      const readiness = buildGateReadinessDiagnostics(config, fixture.options);
      assert.equal(readiness.audit.agentBrowser.available, true);
      assert.equal(readiness.audit.agentBrowser.state, 'available');
      assert.equal(readiness.audit.agentBrowser.reasonCode, 'found');
      assert.ok(readiness.audit.agentBrowser.resolvedPath);
      assert.equal(readiness.audit.readiness, 'ready');
    } finally {
      fixture.cleanup();
    }
  });

  it('reports a present but failing agent-browser as present-but-failing, not missing', () => {
    const fixture = createLookupFixture('agent-browser', 7);
    try {
      const config = getDefaults();
      config.manualUiAudit = true;
      const readiness = buildGateReadinessDiagnostics(config, fixture.options);
      assert.equal(readiness.audit.agentBrowser.available, false);
      assert.equal(readiness.audit.agentBrowser.state, 'present-but-failing');
      assert.equal(readiness.audit.agentBrowser.reasonCode, 'present-but-failing');
      assert.notEqual(readiness.audit.agentBrowser.state, 'missing');
      assert.equal(readiness.audit.readiness, 'needs-action');
      assert.match(readiness.audit.agentBrowser.nextAction, /capability probe/);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports a missing agent-browser as missing when PATH has no which', () => {
    const empty = mkdtempSync(join(tmpdir(), 'aie-doctor-empty-path-'));
    try {
      const config = getDefaults();
      config.manualUiAudit = true;
      const readiness = buildGateReadinessDiagnostics(config, {
        ghAuthenticated: false,
        env: process.platform === 'win32'
          ? { OS: 'Windows_NT', PATH: empty, PATHEXT: '.CMD;.EXE' }
          : { PATH: empty },
        platform: process.platform,
        pathDelimiter: delimiter,
      });
      assert.equal(readiness.audit.agentBrowser.available, false);
      assert.equal(readiness.audit.agentBrowser.state, 'missing');
      assert.equal(readiness.audit.agentBrowser.reasonCode, 'missing');
      assert.equal(readiness.audit.agentBrowser.resolvedPath, null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('resolves a Windows .cmd agent-browser through PATH/PATHEXT without which', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-doctor-win-cmd-'));
    try {
      const bin = join(root, 'Program Files', 'Qube Tools');
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, 'agent-browser.cmd'), '@echo off\r\nexit /b 0\r\n');
      const config = getDefaults();
      config.manualUiAudit = true;
      const readiness = buildGateReadinessDiagnostics(config, {
        ghAuthenticated: false,
        env: { OS: 'Windows_NT', PATH: [bin, bin].join(';'), PATHEXT: '.CMD;.EXE' },
        platform: 'win32',
        pathDelimiter: ';',
      });
      assert.equal(basename(String(readiness.audit.agentBrowser.resolvedPath)).toLowerCase(), 'agent-browser.cmd');
      assert.notEqual(readiness.audit.agentBrowser.state, 'missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function createLookupFixture(command, exitCode) {
  const bin = mkdtempSync(join(tmpdir(), 'aie-doctor-lookup-'));
  const windows = process.platform === 'win32';
  const file = join(bin, windows ? `${command}.cmd` : command);
  if (windows) {
    writeFileSync(file, `@echo off\r\nexit /b ${exitCode}\r\n`);
  } else {
    writeFileSync(file, `#!/bin/sh\nexit ${exitCode}\n`);
    chmodSync(file, 0o755);
  }
  return {
    bin,
    options: {
      ghAuthenticated: false,
      env: windows
        ? { OS: 'Windows_NT', PATH: bin, PATHEXT: '.CMD;.EXE' }
        : { PATH: bin },
      platform: process.platform,
      pathDelimiter: delimiter,
    },
    cleanup() {
      rmSync(bin, { recursive: true, force: true });
    },
  };
}
