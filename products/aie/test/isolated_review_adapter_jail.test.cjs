'use strict';

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');
const { validateConfig, configToFileShape, getDefaults } = require('../dist/config/index.js');
const { buildInitQuestions } = require('../dist/init/questions.js');
const { listReviewAgentAdapters } = require('../dist/providers/review_agent_adapters.js');
const {
  loadReviewHostAdapterPackage,
  omitReviewHostPackagesForTests,
  resetReviewHostAdaptersForTests,
} = require('../dist/app/review_host_adapters.js');

function defaultFile() {
  return configToFileShape(getDefaults());
}

describe('isolated review adapter jail', () => {
  afterEach(() => {
    resetReviewHostAdaptersForTests();
  });

  it('rejects reviewRoute.host grok-build when the Grok Build adapter is missing', () => {
    omitReviewHostPackagesForTests(['@tjalve/qube-adapter-grok-build']);
    const input = defaultFile();
    input.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    const result = validateConfig(input);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => (
      error.path === 'policy.reviews.route.host'
      && /@tjalve\/qube-adapter-grok-build/.test(error.message)
      && /not installed/.test(error.message)
    )));
  });

  it('rejects Codex isolated review and omits Codex from init review-model options when the Codex adapter is missing', () => {
    omitReviewHostPackagesForTests(['@tjalve/qube-adapter-codex']);
    const input = defaultFile();
    input.policy.reviews.models = {
      review: { codex: { model: 'gpt-5.6-luna', effort: null } },
      economy: {},
      synthesis: {},
    };
    input.policy.reviews.route = { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    const result = validateConfig(input);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => (
      error.path === 'policy.reviews.route.host'
      && /@tjalve\/qube-adapter-codex/.test(error.message)
      && /not installed/.test(error.message)
    )));
    assert.ok(result.errors.some((error) => (
      error.path === 'policy.reviews.models.review.codex'
      && /@tjalve\/qube-adapter-codex/.test(error.message)
    )));

    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['codex', 'grok-build'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { codex: ['gpt-5.6-luna'], 'grok-build': ['grok-4.5'] },
      },
      answers: {},
    });
    const models = questions.find((item) => item.id === 'review-models');
    assert.ok(models);
    assert.ok(!models.options.some((option) => String(option.value).startsWith('codex:')));
    assert.ok(models.options.some((option) => option.value === 'grok-build:grok-4.5'));
    assert.ok(!questions.find((item) => item.id === 'reviewers').options.some((option) => option.value === 'codex'));
  });

  it('probes and builds the isolated Grok Build runner from the installed adapter package', () => {
    const adapter = loadReviewHostAdapterPackage('@tjalve/qube-adapter-grok-build');
    assert.ok(adapter);
    assert.equal(adapter.id, 'grok-build');
    const built = adapter.buildInvocation({
      repoRoot: '/repo',
      model: 'grok-4.5',
      effort: null,
      maxTurns: 8,
      prompt: 'inspect',
      promptPath: '/repo/.git/qube/aie/model-route/grok.prompt',
      schemaPath: null,
      schemaJson: '{}',
    }, 'grok');
    assert.ok(built.args.includes('--prompt-file'));
    assert.ok(built.args.includes('--sandbox'));
    const probe = adapter.probeAfterVersion({
      model: 'grok-4.5',
      executable: 'grok',
      prefixArgs: [],
      version: '1.0.0',
      runCommand: () => 'Available models:\n- grok-4.5\n- grok-4.6\n',
    });
    assert.equal(probe.status, 'ready');
    assert.equal(probe.modelListed, true);
  });

  it('does not treat Claude Code or OpenCode as selectable isolated review hosts', () => {
    const input = defaultFile();
    input.policy.reviews.route = { host: 'claude-code', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    const claude = validateConfig(input);
    assert.equal(claude.ok, false);
    assert.ok(claude.errors.some((error) => (
      error.path === 'policy.reviews.route.host'
      && /claude-code/.test(error.message)
    )));

    input.policy.reviews.route = { host: 'opencode', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    const opencode = validateConfig(input);
    assert.equal(opencode.ok, false);
    assert.ok(opencode.errors.some((error) => (
      error.path === 'policy.reviews.route.host'
      && /opencode/.test(error.message)
    )));

    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['claude-code', 'opencode'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: { 'claude-code': ['claude-sonnet-5'], opencode: ['anthropic/claude-sonnet-5'] },
      },
      answers: {},
    });
    const reviewMode = questions.find((item) => item.id === 'review-mode');
    assert.equal(reviewMode.options.find((option) => option.value === 'isolated').available, false);
    const models = questions.find((item) => item.id === 'review-models');
    assert.ok(!models.options.some((option) => String(option.value).startsWith('claude-code:')));
    assert.ok(!models.options.some((option) => String(option.value).startsWith('opencode:')));
  });

  it('does not advertise a builtin Codex reviewer from @tjalve/aie', async () => {
    const adapters = await listReviewAgentAdapters('local');
    const codex = adapters.find((adapter) => adapter.id === 'codex');
    assert.ok(codex);
    assert.equal(codex.packageName, '@tjalve/qube-adapter-codex');
    assert.notEqual(codex.packageName, '@tjalve/aie');

    omitReviewHostPackagesForTests(['@tjalve/qube-adapter-codex']);
    const withoutCodex = await listReviewAgentAdapters('local');
    assert.deepEqual(withoutCodex.map((adapter) => adapter.id), ['local-command']);
    assert.equal(withoutCodex[0].packageName, '@tjalve/aie');
  });
});
