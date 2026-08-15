const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');

const { getDefaults } = require('../dist/config/index.js');
const { runLocalReviewRunner } = require('../dist/app/local_review_runner.js');
const { runPrLaneRerun } = require('../dist/app/pr_lane_rerun.js');
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
    config.reviewRoute = { host: 'grok', tier: 'review', timeoutSeconds: 60, maxTurns: 4 };
    config.reviewModels.review.grok = { model: 'grok-4.5', effort: null };
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
});
