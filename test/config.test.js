/**
 * M1.3 config tests (baseline).
 * Covers load, defaults, missing file behavior, and basic validation.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, DEFAULT_CONFIG } = require('../lib/config.js');

test('loadConfig returns defaults when no aie.config.json', () => {
  const result = loadConfig(process.cwd());
  assert.ok(result.config, 'should return a config object');
  assert.equal(result.config.version, 1);
  assert.equal(result.path, null);
  assert.equal(result.error?.kind, 'CONFIG_NOT_FOUND');
});

test('loadConfig defaults match spec priorities, statuses, components', () => {
  assert.deepEqual(DEFAULT_CONFIG.priorities, ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low']);
  assert.deepEqual(DEFAULT_CONFIG.statuses, ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking']);
  assert.ok(DEFAULT_CONFIG.components.includes('C-Tooling'));
  assert.ok(DEFAULT_CONFIG.components.includes('C-DevEx'));
});

test('loadConfig detects invalid JSON', () => {
  const tmp = path.join(process.cwd(), 'aie.config.json');
  fs.writeFileSync(tmp, '{ bad json');
  try {
    const result = loadConfig(process.cwd());
    assert.equal(result.error?.kind, 'CONFIG_PARSE_ERROR');
  } finally {
    fs.unlinkSync(tmp);
  }
});
