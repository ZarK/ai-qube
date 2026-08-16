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
    executableNames: ['fake-review-host'],
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
  it('lists and resolves the Codex and Grok Build package adapters', () => {
    assert.deepEqual(listReviewHostIds().sort(), ['codex', 'grok-build']);
    assert.equal(isRegisteredReviewHost('codex'), true);
    assert.equal(isRegisteredReviewHost('grok-build'), true);
    assert.equal(isRegisteredReviewHost('unknown-host'), false);
    assert.equal(getReviewHostAdapter('codex').id, 'codex');
    assert.equal(getReviewHostAdapter('grok-build').id, 'grok-build');
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

  it('restores the registered Codex and Grok Build adapters after reset', () => {
    registerReviewHostAdapterForTests(fakeAdapter({ id: 'another-fake-host' }));
    try {
      assert.ok(listReviewHostIds().includes('another-fake-host'));
    } finally {
      resetReviewHostAdaptersForTests();
    }
    assert.deepEqual(listReviewHostIds().sort(), ['codex', 'grok-build']);
  });

  it('parses a Grok json-schema envelope when text is already an object', () => {
    const adapter = getReviewHostAdapter('grok-build');
    const lane = { recommendation: 'approve', status: 'passed', severity: 'none' };
    const parsed = adapter.parseEnvelope(JSON.stringify({ text: lane, sessionId: 'grok-session' }));
    assert.equal(parsed.sessionId, 'grok-session');
    assert.deepEqual(JSON.parse(parsed.text), lane);
  });

  it('parses a Grok JSONL final event and a session_id alias', () => {
    const adapter = getReviewHostAdapter('grok-build');
    const lane = { recommendation: 'approve', status: 'passed' };
    const stdout = [
      JSON.stringify({ type: 'progress', text: 'working' }),
      JSON.stringify({ text: lane, session_id: 'from-jsonl' }),
    ].join('\n');
    const parsed = adapter.parseEnvelope(stdout);
    assert.equal(parsed.sessionId, 'from-jsonl');
    assert.deepEqual(JSON.parse(parsed.text), lane);
  });

  it('lists grok and Codex models through each adapter catalog', () => {
    const grok = getReviewHostAdapter('grok-build');
    assert.equal(typeof grok.listCatalog, 'function');
    assert.deepEqual(grok.listCatalog({
      executable: 'grok',
      prefixArgs: [],
      runCommand: () => 'Available models:\n- grok-4.5\n- grok-4\n',
    }), ['grok-4.5', 'grok-4']);
    const codex = getReviewHostAdapter('codex');
    assert.equal(typeof codex.listCatalog, 'function');
    assert.deepEqual(codex.listCatalog({
      executable: 'codex',
      prefixArgs: [],
      runCommand: () => JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }, { slug: 'gpt-5.5' }, { slug: '  ' }] }),
    }), ['gpt-5.6-luna', 'gpt-5.5']);
    assert.equal(codex.listCatalog({
      executable: 'codex',
      prefixArgs: [],
      runCommand: () => 'not-json',
    }), null);
  });

  it('reports no missing capabilities for the packaged Codex and Grok Build adapters', () => {
    assert.deepEqual(missingReviewHostCapabilities(getReviewHostAdapter('codex')), []);
    assert.deepEqual(missingReviewHostCapabilities(getReviewHostAdapter('grok-build')), []);
  });

  it('names every required capability the adapter does not declare', () => {
    const gapped = fakeAdapter({ capabilities: { structuredOutput: false, readOnlySandbox: false } });
    assert.deepEqual(missingReviewHostCapabilities(gapped), ['structured-output', 'read-only-sandbox']);
  });
});
