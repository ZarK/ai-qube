'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mkdirSync } = require('node:fs');
const { join } = require('node:path');

const { validateConfig, getDefaults, configToFileShape } = require('../dist/config/index.js');
const {
  buildModelRoutingFromSelections,
  defaultModelRoutingPolicy,
  detectInstalledRoutingHosts,
  resolveModelRouting,
} = require('../dist/core/model_routing.js');
const { renderAgentInstructions, renderModelRoutingRunnerFiles } = require('../dist/init_content.js');
const { getAgentHostProfiles } = require('../dist/agent_hosts.js');
const { runInit } = require('../dist/init/index.js');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

function withRouting(overrides) {
  const file = configToFileShape(getDefaults());
  file.policy.modelRouting = {
    ...defaultModelRoutingPolicy(),
    ...overrides,
  };
  return file;
}

describe('modelRouting schema', () => {
  it('accepts the default catalog and route classes', () => {
    const result = validateConfig({ version: 1 });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.config.modelRouting.primary, 'primary');
    assert.equal(result.config.modelRouting.routes['independent-review'].reviewTier, 'review');
  });

  it('rejects an unknown host', () => {
    const file = withRouting({
      catalog: [{ id: 'x', host: 'gemini', transport: 'cli', costRank: 1, notes: 'no' }],
    });
    const result = validateConfig(file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /host/.test(error.message)));
  });

  it('rejects a fallback chain that does not end at primary', () => {
    const file = withRouting({
      primary: 'primary',
      catalog: [
        { id: 'primary', host: 'claude-code', transport: 'host', costRank: 3, notes: 'primary' },
        { id: 'cheap', host: 'grok-build', transport: 'cli', costRank: 1, notes: 'cheap' },
      ],
      routes: {
        'mechanical-implementation': { preferred: 'cheap', fallback: ['cheap'] },
        'exploration-investigation': { preferred: 'primary', fallback: ['primary'] },
        'independent-review': { reviewTier: 'review' },
        'synthesis-judgment': { preferred: 'primary', fallback: ['primary'] },
      },
    });
    const result = validateConfig(file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /end at the primary/.test(error.message)));
  });

  it('rejects independent-review catalog model selection', () => {
    const file = withRouting({});
    file.policy.modelRouting.routes['independent-review'] = { preferred: 'primary', fallback: ['primary'] };
    const result = validateConfig(file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => /must not duplicate/.test(error.message)));
  });

  it('rejects malformed modelRouting JSON', () => {
    const file = configToFileShape(getDefaults());
    file.policy.modelRouting = 'nope';
    const result = validateConfig(file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.modelRouting'));
  });
});

describe('modelRouting resolver', () => {
  it('records a substitution when the preferred host is not installed', () => {
    const policy = buildModelRoutingFromSelections({
      primaryHost: 'claude-code',
      primaryModel: 'default',
      mechanical: { host: 'grok-build', model: 'grok-4.5' },
    });
    const resolved = resolveModelRouting(policy, getDefaults().reviewModels, ['claude-code']);
    assert.equal(resolved.routes['mechanical-implementation'].selected.id, 'claude-code:default');
    assert.ok(resolved.substitutions.some(item => item.from === 'grok-build:grok-4.5'));
    assert.equal(resolved.routes['independent-review'].reviewTier, 'review');
  });

  it('keeps the preferred model when its host is installed', () => {
    const policy = buildModelRoutingFromSelections({
      primaryHost: 'claude-code',
      primaryModel: 'default',
      mechanical: { host: 'grok-build', model: 'grok-4.5' },
    });
    const resolved = resolveModelRouting(policy, getDefaults().reviewModels, ['claude-code', 'grok-build']);
    assert.equal(resolved.routes['mechanical-implementation'].selected.id, 'grok-build:grok-4.5');
    assert.equal(resolved.routes['mechanical-implementation'].substitutions.length, 0);
  });
});

describe('modelRouting host assets', () => {
  it('renders routing instructions and wrapper runners only for non-primary hosts', async () => {
    const config = getDefaults();
    config.modelRouting = buildModelRoutingFromSelections({
      primaryHost: 'claude-code',
      primaryModel: 'default',
      mechanical: { host: 'grok-build', model: 'grok-4.5' },
    });
    const hosts = await getAgentHostProfiles(['claude-code', 'grok-build']);
    const instructions = renderAgentInstructions(config, hosts);
    assert.match(instructions, /Model routing:/);
    assert.match(instructions, /mechanical-implementation/);
    assert.match(instructions, /reviewModels/);
    const runners = renderModelRoutingRunnerFiles(config);
    assert.deepEqual(runners.map(file => file.relativePath), ['.grok/agents/qube-route-runner.md']);
    assert.match(runners[0].body, /self-contained prompt/);
  });

  it('writes the grok wrapper when init selects a grok mechanical route', async () => {
    const repo = cloneGitRepo('committed', 'aie-routing-');
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    const result = await runInit({
      target: '.',
      tool: 'grok-build',
      dryRun: false,
      force: false,
      cwd: repo,
      policy: {
        modelRouting: buildModelRoutingFromSelections({
          primaryHost: 'claude-code',
          primaryModel: 'default',
          mechanical: { host: 'grok-build', model: 'grok-4.5' },
        }),
      },
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    const agents = readConfigured(repo, '.grok/agents/qube-route-runner.md');
    assert.match(agents, /qube-route-runner|wrapper runner/i);
    assert.ok(result.modelRouting);
    assert.equal(result.modelRouting.routes['independent-review'].reviewTier, 'review');
  });
});

function readConfigured(repo, relativePath) {
  return require('node:fs').readFileSync(join(repo, relativePath), 'utf8');
}

describe('installed host detection', () => {
  it('uses the lookup callback instead of inheriting every host', () => {
    const installed = detectInstalledRoutingHosts(command => command === 'claude');
    assert.deepEqual(installed, ['claude-code']);
  });
});
