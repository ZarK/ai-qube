'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  getReviewHostAdapter,
  isRegisteredReviewHost,
  listReviewHostIds,
  missingReviewHostCapabilities,
  registerReviewHostAdapterForTests,
  resetReviewHostAdaptersForTests,
} = require('../dist/app/review_host_adapters.js');

function fakeAdapter(overrides = {}) {
  return {
    id: 'fake-review-host',
    capabilities: { structuredOutput: true, readOnlySandbox: true },
    requiredCapabilities: ['structured-output', 'read-only-sandbox'],
    requiresPromptFile: true,
    requiresSchemaFile: false,
    windowsExecutableNames: ['fake-review-host.exe'],
    windowsNodeModulesScriptPath: () => null,
    windowsFallbackExecutablePath: () => null,
    buildInvocation: context => ({ args: ['--prompt-file', context.promptPath ?? ''], stdin: null }),
    parseEnvelope: stdout => {
      const parsed = JSON.parse(stdout);
      return { text: parsed.text, sessionId: parsed.sessionId ?? null };
    },
    probeAfterVersion: () => ({ status: 'ready', modelListed: null, diagnostic: null }),
    ...overrides,
  };
}

describe('review host adapter registry', () => {
  it('lists and resolves the built-in codex and grok adapters', () => {
    assert.deepEqual(listReviewHostIds().sort(), ['codex', 'grok']);
    assert.equal(isRegisteredReviewHost('codex'), true);
    assert.equal(isRegisteredReviewHost('grok'), true);
    assert.equal(isRegisteredReviewHost('unknown-host'), false);
    assert.equal(getReviewHostAdapter('codex').id, 'codex');
    assert.equal(getReviewHostAdapter('grok').id, 'grok');
  });

  it('rejects an unregistered host id with a named reason', () => {
    assert.throws(() => getReviewHostAdapter('unknown-host'), /No review host adapter is registered for "unknown-host"/);
  });

  it('registers, resolves, and removes a test-double host adapter without touching gate, runner, or probe code', () => {
    registerReviewHostAdapterForTests(fakeAdapter());
    try {
      assert.equal(isRegisteredReviewHost('fake-review-host'), true);
      assert.ok(listReviewHostIds().includes('fake-review-host'));
      const adapter = getReviewHostAdapter('fake-review-host');
      const built = adapter.buildInvocation({
        repoRoot: '/repo',
        model: null,
        effort: null,
        maxTurns: 8,
        prompt: 'inspect',
        promptPath: '/repo/.git/qube/aie/model-route/fake.prompt',
        schemaPath: null,
        schemaJson: '{}',
      }, 'fake-review-host.exe');
      assert.deepEqual(built.args, ['--prompt-file', '/repo/.git/qube/aie/model-route/fake.prompt']);
      assert.equal(built.stdin, null);
      const parsed = adapter.parseEnvelope(JSON.stringify({ text: 'payload', sessionId: 'fake-session' }));
      assert.deepEqual(parsed, { text: 'payload', sessionId: 'fake-session' });
    } finally {
      resetReviewHostAdaptersForTests();
    }
    assert.equal(isRegisteredReviewHost('fake-review-host'), false);
  });

  it('restores exactly the built-in adapters after reset', () => {
    registerReviewHostAdapterForTests(fakeAdapter({ id: 'another-fake-host' }));
    try {
      assert.ok(listReviewHostIds().includes('another-fake-host'));
    } finally {
      resetReviewHostAdaptersForTests();
    }
    assert.deepEqual(listReviewHostIds().sort(), ['codex', 'grok']);
  });

  it('reports no missing capabilities for the built-in codex and grok adapters', () => {
    assert.deepEqual(missingReviewHostCapabilities(getReviewHostAdapter('codex')), []);
    assert.deepEqual(missingReviewHostCapabilities(getReviewHostAdapter('grok')), []);
  });

  it('names every required capability the adapter does not declare', () => {
    const gapped = fakeAdapter({ capabilities: { structuredOutput: false, readOnlySandbox: false } });
    assert.deepEqual(missingReviewHostCapabilities(gapped), ['structured-output', 'read-only-sandbox']);
  });
});
