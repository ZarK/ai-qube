/**
 * M1.5 redaction safety test.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { redact } = require('../lib/redact.js');

test('redact hides GitHub tokens', () => {
  const input = 'error with ghp_1234567890abcdefghij and gho_xxx';
  const out = redact(input);
  assert.ok(!out.includes('ghp_'));
  assert.ok(out.includes('[REDACTED]'));
});

test('redact hides long tokens conservatively', () => {
  const input = 'token=abcdefghijklmnopqrstuvwxyz1234567890ABCD';
  assert.ok(redact(input).includes('[REDACTED]'));
});
