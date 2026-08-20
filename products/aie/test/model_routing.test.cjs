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
const { detectInstalledReviewHostsOnPath } = require('../dist/app/model_routing_hosts.js');
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

  it('accepts Cursor as a model-routing host', () => {
    const file = configToFileShape(getDefaults());
    file.policy.modelRouting = buildModelRoutingFromSelections({
      primaryHost: 'cursor',
      primaryModel: 'default',
    });
    const result = validateConfig(file);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.config.modelRouting.catalog[0].host, 'cursor');
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

  it('uses Cursor as the primary host', () => {
    const policy = buildModelRoutingFromSelections({
      primaryHost: 'cursor',
      primaryModel: 'default',
    });
    const resolved = resolveModelRouting(policy, getDefaults().reviewModels, ['cursor']);
    assert.equal(resolved.primary.host, 'cursor');
    assert.equal(resolved.routes['mechanical-implementation'].selected.host, 'cursor');
  });

  it('resolves Cursor for independent review without changing delegated route selections', () => {
    const policy = buildModelRoutingFromSelections({
      primaryHost: 'codex',
      primaryModel: 'default',
      independentReviewTier: 'review',
    });
    const reviewModels = getDefaults().reviewModels;
    reviewModels.review.cursor = { model: 'cursor-review-model', effort: null };

    const resolved = resolveModelRouting(policy, reviewModels, ['codex'], ['cursor']);

    assert.equal(resolved.routes['independent-review'].host, 'cursor');
    assert.equal(resolved.routes['independent-review'].model, 'cursor-review-model');
    assert.equal(resolved.routes['mechanical-implementation'].selected.host, 'codex');
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

  it('renders the Cursor command runner when another primary delegates to Cursor', () => {
    const config = getDefaults();
    config.modelRouting = buildModelRoutingFromSelections({
      primaryHost: 'claude-code',
      primaryModel: 'default',
      mechanical: { host: 'cursor', model: 'default' },
    });
    const runners = renderModelRoutingRunnerFiles(config);
    assert.deepEqual(runners.map(file => file.relativePath), ['.cursor/commands/qube-route-runner.md']);
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

  it('detects Cursor through its supported CLI names', () => {
    assert.deepEqual(detectInstalledRoutingHosts(command => command === 'cursor-agent'), ['cursor']);
    assert.deepEqual(detectInstalledRoutingHosts(command => command === 'agent'), ['cursor']);
  });

  it('derives launch candidates from every canonical host profile', async () => {
    const profiles = await getAgentHostProfiles(['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    for (const profile of profiles) {
      const candidates = new Set([...profile.executables.names, ...profile.executables.windowsNames]);
      assert.deepEqual(detectInstalledRoutingHosts(command => candidates.has(command)), [profile.id], profile.id);
    }
  });

  it('discovers Cursor for review through the registered adapter', () => {
    const installed = detectInstalledReviewHostsOnPath(command => command === 'cursor-agent', 'linux');
    assert.deepEqual(installed, ['cursor']);
    assert.deepEqual(detectInstalledReviewHostsOnPath(command => command === 'cursor-agent', 'win32'), ['cursor']);
  });

  it('reuses an existing routing-host scan while discovering review hosts', () => {
    const lookups = [];
    const installed = detectInstalledReviewHostsOnPath(command => {
      lookups.push(command);
      return command === 'cursor-agent';
    }, 'linux', ['codex']);

    assert.deepEqual(installed, ['codex', 'cursor']);
    assert.equal(lookups.includes('codex'), false);
  });
});
