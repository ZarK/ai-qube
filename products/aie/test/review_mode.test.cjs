const assert = require('node:assert/strict');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { getDefaults } = require('../dist/config/index.js');
const { inferReviewMode, readAiePackageVersion, reviewModeOf } = require('../dist/review_mode.js');
const { resolveModelReviewPlan } = require('../dist/app/local_review_runner.js');
const { renderAgentInstructions } = require('../dist/init_content.js');
const { getAgentHostProfiles } = require('../dist/agent_hosts.js');
const { renderManagedSection, readManagedToolVersion } = require('../dist/managed_file.js');
const { buildGateReadinessDiagnostics } = require('../dist/doctor_diagnostics/index.js');
const { runInit } = require('../dist/init/index.js');

function isolatedConfig(mode = null) {
  const config = getDefaults();
  config.reviewAdapter = 'local';
  config.reviewMode = mode;
  config.reviewRoute = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
  config.reviewModels.review['grok-build'] = { model: 'grok-4.5', effort: null };
  config.reviewLanes = [{
    id: 'code-quality',
    required: 'always',
    match: [],
    severityThreshold: 'high',
    prompt: [],
    tools: [],
    runner: 'local-host',
    rereview: 'always-rerun',
    route: null,
    carryForwardContext: 'all',
    tier: 'review',
    suppress: [],
    maxAdvisoryFindings: null,
    optOut: false,
  }];
  return config;
}

describe('review mode resolution', () => {
  it('infers isolated when a route is set, host for local without a route, and external otherwise', () => {
    assert.equal(inferReviewMode({ adapter: 'github', route: { host: 'grok-build', tier: 'review', timeoutSeconds: 1, maxTurns: 1 } }), 'isolated');
    assert.equal(inferReviewMode({ adapter: 'local', route: null }), 'host');
    assert.equal(inferReviewMode({ adapter: 'github', route: null }), 'external');
  });

  it('lets an explicit mode override leftover route details', () => {
    const config = isolatedConfig('external');
    assert.equal(reviewModeOf(config), 'external');
    assert.equal(resolveModelReviewPlan(config, 'code-quality'), null);
  });

  it('plans isolated model routes only in isolated mode', () => {
    const isolated = isolatedConfig('isolated');
    const host = isolatedConfig('host');
    assert.equal(resolveModelReviewPlan(isolated, 'code-quality').host, 'grok-build');
    assert.equal(resolveModelReviewPlan(host, 'code-quality'), null);
  });
});

describe('review mode doctor and init', () => {
  it('prints the active mode and flags a stale instruction stamp', async () => {
    const repo = cloneGitRepo('committed', 'aie-review-mode-');
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, 'AGENTS.md'), renderManagedSection('## Executor Issue Workflow\n'));
    const stamped = readFileSync(join(repo, 'AGENTS.md'), 'utf8').replace(
      /executor-managed-tool:\s*[^\s]+/,
      'executor-managed-tool: 0.0.1',
    );
    writeFileSync(join(repo, 'AGENTS.md'), stamped);
    const readiness = buildGateReadinessDiagnostics(isolatedConfig(null), { ghAuthenticated: false, evidenceRoot: repo });
    assert.equal(readiness.reviewAgent.mode, 'isolated');
    assert.equal(readiness.reviewAgent.modeSource, 'inferred');
    assert.equal(readiness.reviewAgent.instructionToolVersion, '0.0.1');
    assert.equal(readiness.reviewAgent.instructionStale, true);
    assert.match(readiness.reviewAgent.instructionRefreshCommand, /aie init \. --force/);

    writeFileSync(join(repo, 'AGENTS.md'), renderManagedSection('## Executor Issue Workflow\n'));
    writeFileSync(join(repo, 'CLAUDE.md'), readFileSync(join(repo, 'AGENTS.md'), 'utf8').replace(
      /executor-managed-tool:\s*[^\s]+/,
      'executor-managed-tool: 0.0.1',
    ));
    const mixed = buildGateReadinessDiagnostics(isolatedConfig(null), { ghAuthenticated: false, evidenceRoot: repo });
    assert.equal(mixed.reviewAgent.instructionStale, true);
  });

  it('stamps the running tool version on a fresh init and names the active mode', async () => {
    const repo = cloneGitRepo('committed', 'aie-review-mode-init-');
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    const result = await runInit({
      target: '.',
      tool: 'opencode',
      dryRun: false,
      force: false,
      cwd: repo,
      yes: true,
      guide: true,
      installedHosts: ['grok-build'],
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    assert.equal(readManagedToolVersion(agents), readAiePackageVersion());
    assert.match(agents, /Review mode: isolated\./);
    assert.equal(existsSync(join(__dirname, '../docs/review-modes.md')), true);
    const hosts = await getAgentHostProfiles(['opencode']);
    const isolated = isolatedConfig('isolated');
    assert.match(renderAgentInstructions(isolated, hosts), /Review mode: isolated\./);
  });
});
