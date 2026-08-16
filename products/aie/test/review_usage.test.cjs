'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { getReviewHostAdapter, readHostUsage } = require('../dist/app/review_host_adapters.js');

describe('host-reported usage', () => {
  it('keeps recognized token and cost fields and omits everything else', () => {
    assert.deepEqual(readHostUsage({
      input_tokens: 12,
      output_tokens: 4,
      cached_input_tokens: 3,
      total_tokens: 19,
      cost: 0.02,
      currency: 'USD',
      tokens: 0,
    }), {
      inputTokens: 12,
      outputTokens: 4,
      cachedInputTokens: 3,
      totalTokens: 19,
      cost: 0.02,
      currency: 'USD',
    });
  });

  it('omits missing usage instead of inventing zeros', () => {
    assert.equal(readHostUsage(undefined), undefined);
    assert.equal(readHostUsage(null), undefined);
    assert.equal(readHostUsage({}), undefined);
    assert.equal(readHostUsage({ tokens: 0 }), undefined);
    assert.equal(readHostUsage({ input_tokens: 'lots', output_tokens: -4 }), undefined);
  });

  it('parses Codex turn.completed usage and ignores envelopes with no usage', () => {
    const adapter = getReviewHostAdapter('codex');
    const withUsage = adapter.parseEnvelope([
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 21, cached_input_tokens: 2, output_tokens: 7 } }),
    ].join('\n'));
    assert.deepEqual(withUsage.usage, { inputTokens: 21, cachedInputTokens: 2, outputTokens: 7 });

    const withoutUsage = adapter.parseEnvelope([
      JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"ok":true}' } }),
    ].join('\n'));
    assert.equal(withoutUsage.usage, undefined);
  });

  it('parses Grok envelope usage and omits malformed token counts', () => {
    const adapter = getReviewHostAdapter('grok-build');
    const withUsage = adapter.parseEnvelope(JSON.stringify({
      text: '{"status":"passed"}',
      sessionId: 'grok-session',
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }));
    assert.deepEqual(withUsage.usage, { inputTokens: 8, outputTokens: 3, totalTokens: 11 });

    const malformed = adapter.parseEnvelope(JSON.stringify({
      text: '{"status":"passed"}',
      sessionId: 'grok-session',
      usage: { tokens: 0, input_tokens: 'twelve' },
    }));
    assert.equal(malformed.usage, undefined);
  });
});
