const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const { getDefaults } = require('../dist/config/index.js');
const { runLocalReviewRunner } = require('../dist/app/local_review_runner.js');
const { runPrLaneRerun } = require('../dist/app/pr_lane_rerun.js');
const { readLocalReviewGate, readCurrentHeadLaneEvidence } = require('../dist/local_review_evidence.js');
const { defaultFreshSetupLanes } = require('../dist/config/fresh_setup_lanes.js');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

describe('pr lane rerun', () => {
  it('rejects an unknown lane without executing', async () => {
    const result = await runPrLaneRerun({
      config: getDefaults(),
      repoRoot: process.cwd(),
      prNumber: 12,
      lane: 'not-a-lane',
      headSha: 'abc123',
      issueNumbers: [551],
      dryRun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.executions, 0);
    assert.deepEqual(result.lanesRun, []);
    assert.match(result.errors[0], /Unknown review lane/);
  });

  it('rejects an inactive lane without executing other lanes', async () => {
    const config = getDefaults();
    config.reviewMode = 'isolated';
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewLanes = [
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'always-rerun', route: null, carryForwardContext: 'all', tier: 'review', suppress: [], maxAdvisoryFindings: null, optOut: false },
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta', route: null, carryForwardContext: 'scope', tier: 'review', suppress: [], maxAdvisoryFindings: null, optOut: false },
    ];
    const result = await runPrLaneRerun({
      config,
      repoRoot: process.cwd(),
      prNumber: 12,
      lane: 'security',
      headSha: 'abc123',
      issueNumbers: [551],
      dryRun: true,
      changedPaths: ['src/index.ts'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.executions, 0);
    assert.ok(!result.lanesRun.includes('issue-compliance'));
    assert.ok(!result.lanesRun.includes('code-quality'));
    assert.match(result.errors[0], /not active/);
  });

  it('plans only the named lane once and does not execute siblings', async () => {
    const repo = cloneGitRepo('committed', 'aie-lane-rerun-');
    const config = getDefaults();
    config.reviewMode = 'isolated';
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 60, maxTurns: 4 };
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    config.reviewLanes = defaultFreshSetupLanes();
    const result = await runLocalReviewRunner(config, {
      repoRoot: repo,
      issueNumbers: [551],
      prNumber: 12,
      headSha: 'abc123',
      required: true,
      shadow: false,
      dryRun: true,
      onlyLanes: ['code-quality'],
      forceLanes: ['code-quality'],
      changedPaths: ['src/index.ts'],
    });
    const names = [...new Set(result.lanes.map(lane => lane.lane))];
    assert.deepEqual(names, ['code-quality']);
    assert.equal(result.lanes.filter(lane => lane.lane === 'code-quality').length, 1);
    assert.ok(!names.includes('issue-compliance'));
    assert.ok(!names.includes('security'));
  });

  it('executes one named lane and reuses it on the following gate run', async () => {
    const repo = cloneGitRepo('committed', 'aie-lane-rerun-reuse-');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const config = getDefaults();
    config.reviewMode = 'isolated';
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 60, maxTurns: 4 };
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    config.reviewLanes = [defaultFreshSetupLanes().find(lane => lane.id === 'code-quality')];
    let executions = 0;
    const runnerInput = {
      repoRoot: repo,
      issueNumbers: [551],
      prNumber: 12,
      headSha,
      required: true,
      shadow: false,
      dryRun: false,
      changedPaths: ['src/index.ts'],
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => headSha,
      routeProbe: () => ({ host: 'grok-build', model: 'grok-4.5', status: 'ready', executable: 'grok.exe', version: 'test', modelListed: true, diagnostic: null, resolved: 'grok.exe' }),
      modelRouteProcess: async invocation => {
        executions += 1;
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        const areas = ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || 'code-quality').split(', ');
        const body = {
          issueNumber: 551,
          prNumber: 12,
          headSha,
          lane: 'code-quality',
          status: 'passed',
          severity: 'none',
          recommendation: 'approve',
          summary: 'Code-quality review passed.',
          blockers: [],
          findings: [],
          artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
          commands: ['git diff --check'],
          surfaces: ['PR diff'],
          contextReviewed: [{ kind: 'diff', source: 'git diff', trust: 'local-evidence', freshness: 'current' }],
          toolsUsed: ['git'],
          completeness: 'Inspected the complete code-quality scope at the current head.',
          coverage: areas.map(area => ({ area, status: 'clear' })),
          preconditions: [],
        };
        return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'rerun-session' }) };
      },
    };

    const rerun = await runLocalReviewRunner(config, { ...runnerInput, onlyLanes: ['code-quality'], forceLanes: ['code-quality'] });
    assert.equal(executions, 1);
    assert.equal(rerun.lanes.length, 1);
    assert.equal(rerun.lanes[0].evidenceSource, 'fresh-run');

    const followingGate = await runLocalReviewRunner(config, runnerInput);
    assert.equal(executions, 1, 'the following gate must not execute the completed lane again');
    assert.equal(followingGate.lanes.length, 1);
    assert.equal(followingGate.lanes[0].evidenceSource, 'local');
  });

  it('leaves the lane not passed when a rerun ends on max turns after an incomplete lane', async () => {
    const repo = cloneGitRepo('committed', 'aie-lane-rerun-max-turns-');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const config = getDefaults();
    config.reviewMode = 'isolated';
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 60, maxTurns: 4 };
    config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
    config.reviewLanes = [defaultFreshSetupLanes().find(lane => lane.id === 'code-quality')];
    let mode = 'incomplete';
    let executions = 0;
    const runnerInput = {
      repoRoot: repo,
      issueNumbers: [551],
      prNumber: 12,
      headSha,
      required: true,
      shadow: false,
      dryRun: false,
      changedPaths: ['src/index.ts'],
      resolveModelHost: async () => 'grok.exe',
      resolveModelHead: async () => headSha,
      routeProbe: () => ({ host: 'grok-build', model: 'grok-4.5', status: 'ready', executable: 'grok.exe', version: 'test', modelListed: true, diagnostic: null, resolved: 'grok.exe' }),
      modelRouteProcess: async invocation => {
        executions += 1;
        if (mode === 'max-turns') return { exitCode: 1, stderr: 'Error: max turns reached', stdout: '', timedOut: false, stdinDelivered: true };
        const prompt = readFileSync(invocation.promptPath, 'utf8');
        const areas = ((prompt.match(/Attest coverage for exactly these areas: ([^\n]+?)\. Each coverage entry/) || [])[1] || 'code-quality').split(', ');
        const body = {
          issueNumber: 551, prNumber: 12, headSha, lane: 'code-quality',
          status: 'inconclusive', severity: 'none', recommendation: 'inconclusive',
          summary: 'Review not complete because the fixture scope could not be inspected.',
          blockers: [], findings: [],
          artifacts: [{ kind: 'command', path: 'command:git diff --check', sha256: null }],
          commands: ['git diff --check'], surfaces: ['PR diff'],
          contextReviewed: [{ kind: 'diff', source: 'git diff', trust: 'local-evidence', freshness: 'current' }],
          toolsUsed: ['git'],
          completeness: 'Inspection not complete because the fixture scope could not be inspected.',
          coverage: areas.map(area => ({ area, status: 'not-inspected' })),
          preconditions: [],
        };
        return { exitCode: 0, stderr: '', timedOut: false, stdinDelivered: true, stdout: JSON.stringify({ text: JSON.stringify(body), sessionId: 'incomplete-session' }) };
      },
    };

    const firstGate = await runLocalReviewRunner(config, runnerInput);
    assert.equal(firstGate.lanes[0].status, 'completed');
    assert.equal(readCurrentHeadLaneEvidence(repo, 551, 12, headSha, 'code-quality').status, 'inconclusive');

    mode = 'max-turns';
    const rerun = await runLocalReviewRunner(config, { ...runnerInput, onlyLanes: ['code-quality'], forceLanes: ['code-quality'] });
    assert.equal(rerun.lanes[0].status, 'failed');
    assert.equal(rerun.lanes[0].blocker, 'model-route-max-turns');

    const afterRerun = readCurrentHeadLaneEvidence(repo, 551, 12, headSha, 'code-quality');
    assert.notEqual(afterRerun.status, 'passed', 'a max-turns rerun must not leave a passed lane at this head');
    assert.equal(afterRerun.status, 'inconclusive');
    assert.match(`${afterRerun.summary} ${afterRerun.completeness}`, /model-route-max-turns/);

    const nextGate = await runLocalReviewRunner(config, runnerInput);
    assert.ok(executions >= 3);
    assert.equal(nextGate.lanes[0].status, 'failed');
    assert.equal(nextGate.lanes[0].blocker, 'model-route-max-turns');
    const gate = readLocalReviewGate({
      repoRoot: repo, issueNumbers: [551], prNumber: 12, headSha, reviewers: [], required: true,
      profile: 'local-focused', activeFocuses: ['code-quality'],
    });
    assert.notEqual(gate.status, 'passed');
    assert.notEqual(gate.evidence[0].lanes.find(lane => lane.id === 'code-quality')?.status, 'passed');
    assert.ok(existsSync(join(repo, '.qube', 'aie', 'reviews', '551', '12', headSha, 'code-quality.json')));
  });

  it('reports a failed named-lane attempt with its route reason', async () => {
    const config = getDefaults();
    config.reviewMode = 'isolated';
    config.reviewAdapter = 'local';
    config.reviewProfile = 'local-focused';
    config.reviewLanes = defaultFreshSetupLanes();
    const result = await runPrLaneRerun({
      config,
      repoRoot: process.cwd(),
      prNumber: 12,
      lane: 'code-quality',
      headSha: 'abc123',
      issueNumbers: [551],
      changedPaths: ['src/index.ts'],
      runRunner: async () => ({
        status: 'failed',
        lanes: [{
          lane: 'code-quality',
          status: 'failed',
          evidenceSource: null,
          blocker: 'model-route-output-envelope',
          summary: 'The host returned no supported terminal response.',
        }],
        unavailable: [],
      }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.executions, 1);
    assert.equal(result.attempted, true);
    assert.equal(result.reasonCode, 'model-route-output-envelope');
    assert.deepEqual(result.lanesRun, ['code-quality']);
    assert.match(result.errors[0], /model-route-output-envelope/);
    assert.match(result.nextAction, /Fix model-route-output-envelope/);
  });
});
