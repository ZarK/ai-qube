'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseGrokModelCatalog, probeModelRoute } = require('../dist/app/model_route_probe.js');

const GROK_MODELS_OUTPUT = [
  'You are logged in with grok.com.',
  '',
  'Default model: grok-4.5',
  '',
  'Available models:',
  '  * grok-4.5 (default)',
  '  grok-4-mini',
  '',
].join('\n');

describe('model route probe', () => {
  it('parses the grok model catalog into model ids', () => {
    assert.deepEqual(parseGrokModelCatalog(GROK_MODELS_OUTPUT), ['grok-4.5', 'grok-4-mini']);
    assert.equal(parseGrokModelCatalog('no catalog here'), null);
    assert.equal(parseGrokModelCatalog('Available models:\n'), null);
  });

  it('reports ready when the grok CLI resolves and the configured model is listed', () => {
    const commands = [];
    const check = probeModelRoute('grok', 'grok-4.5', (executable, args) => {
      commands.push([executable, ...args]);
      if (args[0] === '--version') return 'grok 0.2.102 (abc) [stable]\n';
      if (args[0] === 'models') return GROK_MODELS_OUTPUT;
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    });
    assert.equal(check.status, 'ready');
    assert.equal(check.modelListed, true);
    assert.equal(check.version, 'grok 0.2.102 (abc) [stable]');
    assert.equal(check.diagnostic, null);
    assert.ok(commands.every(command => command[1] === '--version' || command[1] === 'models'));
  });

  it('blocks when the configured model is missing from the grok catalog', () => {
    const check = probeModelRoute('grok', 'grok-9-imaginary', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      return GROK_MODELS_OUTPUT;
    });
    assert.equal(check.status, 'blocked');
    assert.equal(check.modelListed, false);
    assert.match(check.diagnostic, /grok-9-imaginary/);
    assert.match(check.diagnostic, /grok-4\.5/);
    assert.match(check.diagnostic, /Update the trusted review model configuration/);
  });

  it('blocks when the grok catalog cannot be read or parsed', () => {
    const unreadable = probeModelRoute('grok', 'grok-4.5', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      throw new Error('not logged in');
    });
    assert.equal(unreadable.status, 'blocked');
    assert.match(unreadable.diagnostic, /model catalog could not be read/);

    const unparsed = probeModelRoute('grok', 'grok-4.5', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      return 'totally unexpected output';
    });
    assert.equal(unparsed.status, 'blocked');
    assert.match(unparsed.diagnostic, /catalog output was unrecognized/);
  });

  it('blocks with an actionable diagnostic when the host CLI is unresolvable', () => {
    const check = probeModelRoute('grok', 'grok-4.5', () => {
      throw new Error('spawn grok ENOENT');
    });
    assert.equal(check.status, 'blocked');
    assert.equal(check.executable, null);
    assert.match(check.diagnostic, /not resolvable|did not report a version/);
    assert.match(check.diagnostic, /Install and authenticate the grok CLI/);
  });

  it('probes codex with version only because the CLI exposes no model catalog', () => {
    const commands = [];
    const check = probeModelRoute('codex', 'gpt-5.6-luna', (executable, args) => {
      commands.push(args.join(' '));
      return 'codex-cli 0.144.5\n';
    });
    assert.equal(check.status, 'ready');
    assert.equal(check.modelListed, null);
    assert.equal(check.version, 'codex-cli 0.144.5');
    assert.ok(commands.every(command => command === '--version'));
  });
});
