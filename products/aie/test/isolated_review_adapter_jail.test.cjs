'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { validateConfig, configToFileShape, getDefaults } = require('../dist/config/index.js');
const { buildInitQuestions } = require('../dist/init/questions.js');
const { getReviewHostAdapter } = require('../dist/app/review_host_adapters.js');

function defaultFile() {
  return configToFileShape(getDefaults());
}

describe('isolated review harness contract', () => {
  it('accepts the three implemented isolated harnesses and rejects native-only harnesses', () => {
    for (const host of ['codex', 'grok-build', 'cursor']) {
      const input = defaultFile();
      input.policy.reviews.route = { host, tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
      assert.equal(validateConfig(input).errors.some((error) => error.path === 'policy.reviews.route.host'), false, host);
    }
    for (const host of ['claude-code', 'opencode']) {
      const input = defaultFile();
      input.policy.reviews.route = { host, tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
      const result = validateConfig(input);
      assert.equal(result.ok, false, host);
      assert.ok(result.errors.some((error) => error.path === 'policy.reviews.route.host' && error.message.includes(host)));
    }
  });

  it('builds the Grok Build isolated invocation from the required adapter', () => {
    const adapter = getReviewHostAdapter('grok-build');
    const built = adapter.buildInvocation({
      repoRoot: '/repo', model: 'grok-4.5', effort: null, maxTurns: 8, prompt: 'inspect',
      promptPath: '/repo/.git/qube/aie/model-route/grok.prompt', schemaPath: null, schemaJson: '{}',
    }, 'grok');
    assert.ok(built.args.includes('--prompt-file'));
    assert.ok(built.args.includes('--sandbox'));
  });

  it('shows isolated model choices only for installed harnesses that support isolated execution', () => {
    const questions = buildInitQuestions({
      machine: {
        installedHosts: ['codex', 'claude-code', 'opencode', 'grok-build', 'cursor'],
        agentBrowserAvailable: false,
        aiqAvailable: false,
        hasUserFacingUi: false,
        liveModels: {
          codex: ['gpt-5.6-luna'],
          'claude-code': ['claude-sonnet-5'],
          opencode: ['anthropic/claude-sonnet-5'],
          'grok-build': ['grok-4.5'],
          cursor: ['composer-2'],
        },
      },
      answers: {},
    });
    const models = questions.find((item) => item.id === 'review-models');
    const values = models.options.map((option) => String(option.value));
    assert.ok(values.some((value) => value.startsWith('codex:')));
    assert.ok(values.some((value) => value.startsWith('grok-build:')));
    assert.ok(values.some((value) => value.startsWith('cursor:')));
    assert.ok(!values.some((value) => value.startsWith('claude-code:')));
    assert.ok(!values.some((value) => value.startsWith('opencode:')));
  });
});
