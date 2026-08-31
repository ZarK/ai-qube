'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { probeModelRoute, sanitizeProbeText } = require('../dist/app/model_route_probe.js');
const { parseGrokModelCatalog } = require('@tjalve/qube-adapter-grok-build');
const { getReviewHostAdapter, registerReviewHostAdapterForTests, resetReviewHostAdaptersForTests } = require('../dist/app/review_host_adapters.js');

const GROK_MODELS_OUTPUT = [
  'You are logged in with grok.com.',
  '',
  'Default model: grok-4.6',
  '',
  'Available models:',
  '  * grok-4.6 (default)',
  '  - grok-4.5',
  '  grok-4-mini',
  '',
].join('\n');

describe('model route probe', () => {
  it('parses the grok model catalog into model ids', () => {
    assert.deepEqual(parseGrokModelCatalog(GROK_MODELS_OUTPUT), ['grok-4.6', 'grok-4.5', 'grok-4-mini']);
    assert.equal(parseGrokModelCatalog('no catalog here'), null);
    assert.equal(parseGrokModelCatalog('Available models:\n'), null);
  });

  it('reports ready when the grok CLI resolves and the configured model is listed', () => {
    const commands = [];
    const check = probeModelRoute('grok-build', 'grok-4.5', (executable, args) => {
      commands.push([executable, ...args]);
      if (args[0] === '--version') return 'grok 0.2.102 (abc) [stable]\n';
      if (args[0] === 'models') return GROK_MODELS_OUTPUT;
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => 'grok-cli');
    assert.equal(check.status, 'ready');
    assert.equal(check.executable, 'grok-cli');
    assert.equal(check.modelListed, true);
    assert.equal(check.version, 'grok 0.2.102 (abc) [stable]');
    assert.equal(check.diagnostic, null);
    assert.ok(commands.every(command => command[0] === 'grok-cli'));
  });

  it('blocks when the configured model is missing from the grok catalog', () => {
    const check = probeModelRoute('grok-build', 'grok-9-imaginary', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      return GROK_MODELS_OUTPUT;
    }, () => 'grok-cli');
    assert.equal(check.status, 'blocked');
    assert.equal(check.modelListed, false);
    assert.match(check.diagnostic, /grok-9-imaginary/);
    assert.match(check.diagnostic, /grok-4\.5/);
    assert.match(check.diagnostic, /Update the trusted review model configuration/);
  });

  it('reports ready when the Codex CLI lists the configured model', () => {
    const check = probeModelRoute('codex', 'gpt-5.6-luna', (_executable, args) => {
      if (args[0] === '--version') return 'codex-cli 0.1.0\n';
      if (args[0] === 'debug' && args[1] === 'models') return JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }] });
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => 'codex-cli');
    assert.equal(check.status, 'ready');
    assert.equal(check.modelListed, true);
    assert.equal(check.diagnostic, null);
  });

  it('probes Cursor version, capabilities, browser authentication, and model before the batch', () => {
    const commands = [];
    const check = probeModelRoute('cursor', 'gpt-5.6-luna-high', (_executable, args) => {
      commands.push(args);
      if (args.at(-1) === '--version') return '2026.08.11-build\n';
      if (args.at(-2) === 'acp' && args.at(-1) === '--help') return 'Usage: agent acp\nStart the Cursor Agent as an ACP (Agent Client Protocol) server';
      if (args.at(-1) === '--help') return 'acp --print --output-format --mode ask --model --workspace --sandbox';
      if (args.includes('status')) return JSON.stringify({ status: 'authenticated', isAuthenticated: true, userInfo: { email: 'private@example.test' } });
      if (args.at(-1) === 'models') return 'Available models\n\ngpt-5.6-luna-high - GPT';
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => ({ executable: 'powershell.exe', prefixArgs: ['-File', 'cursor-agent.ps1'] }), 'linux');
    assert.equal(check.status, 'ready');
    assert.equal(check.modelListed, true);
    assert.equal(check.executable, 'powershell.exe');
    assert.ok(commands.every(args => args[0] === '-File' && args[1] === 'cursor-agent.ps1'));
  });

  it('binds a compatible Windows Cursor display model to its exact ACP value', () => {
    const commands = [];
    const check = probeModelRoute('cursor', 'cursor-grok-4.6-high-fast', (_executable, args) => {
      commands.push(args);
      if (args.at(-1) === '--version') return '2026.08.11-build';
      if (args.at(-2) === 'acp' && args.at(-1) === '--help') return 'Usage: agent acp\nAgent Client Protocol';
      if (args.at(-1) === '--help') return 'ask';
      if (args.includes('status')) return JSON.stringify({ status: 'authenticated', isAuthenticated: true });
      if (args.at(-1) === 'models') return 'Available models\ncursor-grok-4.6-high - Grok High\ncursor-grok-4.6-high-fast - Grok High Fast';
      if (args.at(-1) === '--acp-models') return JSON.stringify({ version: 1, transport: 'acp', options: [{ value: 'grok-4.6[effort=high,fast=true]', name: 'Grok High Fast' }] });
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => ({ executable: 'node.exe', prefixArgs: ['cursor-acp-runner.js', '--'] }), 'win32');

    assert.equal(check.status, 'ready');
    assert.equal(check.reasonCode, null);
    assert.equal(check.transport, 'acp');
    assert.equal(check.resolvedModel, 'grok-4.6[effort=high,fast=true]');
    assert.deepEqual(check.availableModels, ['cursor-grok-4.6-high-fast']);
    assert.ok(commands.some(args => args.at(-1) === '--acp-models'));
  });

  it('blocks the observed Cursor display and ACP semantic mismatch', () => {
    const check = probeModelRoute('cursor', 'cursor-grok-4.6-medium-fast', (_executable, args) => {
      if (args.at(-1) === '--version') return '2026.08.11-build';
      if (args.at(-2) === 'acp' && args.at(-1) === '--help') return 'Usage: agent acp\nAgent Client Protocol';
      if (args.at(-1) === '--help') return 'ask';
      if (args.includes('status')) return JSON.stringify({ status: 'authenticated', isAuthenticated: true });
      if (args.at(-1) === 'models') return 'Available models\ncursor-grok-4.6-medium-fast - Grok Medium Fast\ncursor-grok-4.6-high-fast - Grok High Fast';
      if (args.at(-1) === '--acp-models') return JSON.stringify({ version: 1, transport: 'acp', options: [{ value: 'grok-4.6[effort=high,fast=true]', name: 'Grok High Fast' }] });
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => 'cursor-agent', 'win32');

    assert.equal(check.status, 'blocked');
    assert.equal(check.reasonCode, 'model-route-model-unsupported');
    assert.equal(check.transport, 'acp');
    assert.equal(check.resolvedModel, null);
    assert.deepEqual(check.availableModels, ['cursor-grok-4.6-high-fast']);
  });

  it('blocks Cursor before a lane when browser login is missing', () => {
    const check = probeModelRoute('cursor', 'gpt-5.6-luna-high', (_executable, args) => {
      if (args.at(-1) === '--version') return '2026.08.11-build';
      if (args.at(-2) === 'acp' && args.at(-1) === '--help') return 'Usage: agent acp\nStart the Cursor Agent as an ACP (Agent Client Protocol) server';
      if (args.at(-1) === '--help') return 'acp --print --output-format --mode ask --model --workspace --sandbox';
      if (args.includes('status')) return JSON.stringify({ status: 'unauthenticated', isAuthenticated: false });
      return 'Available models\n\ngpt-5.6-luna-high - GPT';
    }, () => 'cursor-agent');
    assert.equal(check.status, 'blocked');
    assert.match(check.diagnostic, /cursor-agent login/);
    assert.doesNotMatch(check.diagnostic, /private@example/);
  });

  it('blocks when the configured model is missing from the Codex catalog', () => {
    const check = probeModelRoute('codex', 'gpt-missing', (_executable, args) => {
      if (args[0] === '--version') return 'codex-cli 0.1.0\n';
      return JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }] });
    }, () => 'codex-cli');
    assert.equal(check.status, 'blocked');
    assert.equal(check.modelListed, false);
    assert.match(check.diagnostic, /gpt-missing/);
  });

  it('blocks when the Codex catalog cannot be read or parsed', () => {
    const unreadable = probeModelRoute('codex', 'gpt-5.6-luna', (_executable, args) => {
      if (args[0] === '--version') return 'codex-cli 0.1.0\n';
      throw new Error('debug models failed');
    }, () => 'codex-cli');
    assert.equal(unreadable.status, 'blocked');
    assert.equal(unreadable.modelListed, null);
    assert.match(unreadable.diagnostic, /model catalog could not be read/);

    const unparsed = probeModelRoute('codex', 'gpt-5.6-luna', (_executable, args) => {
      if (args[0] === '--version') return 'codex-cli 0.1.0\n';
      return 'totally unexpected output';
    }, () => 'codex-cli');
    assert.equal(unparsed.status, 'blocked');
    assert.equal(unparsed.modelListed, null);
    assert.match(unparsed.diagnostic, /catalog output was unrecognized/);
  });

  it('blocks when the grok catalog cannot be read or parsed', () => {
    const unreadable = probeModelRoute('grok-build', 'grok-4.5', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      throw new Error('not logged in');
    }, () => 'grok-cli');
    assert.equal(unreadable.status, 'blocked');
    assert.match(unreadable.diagnostic, /model catalog could not be read/);

    const unparsed = probeModelRoute('grok-build', 'grok-4.5', (executable, args) => {
      if (args[0] === '--version') return 'grok 0.2.102\n';
      return 'totally unexpected output';
    }, () => 'grok-cli');
    assert.equal(unparsed.status, 'blocked');
    assert.match(unparsed.diagnostic, /catalog output was unrecognized/);
  });

  it('blocks with an actionable diagnostic when the host CLI is unresolvable', () => {
    const check = probeModelRoute('grok-build', 'grok-4.5', () => {
      throw new Error('must not run a command for an unresolvable host');
    }, () => {
      throw new Error('grok review route is unavailable. Expose the authenticated grok CLI on PATH; QUBE does not install or authenticate model hosts.');
    });
    assert.equal(check.status, 'blocked');
    assert.equal(check.executable, null);
    assert.match(check.diagnostic, /not resolvable/);
    assert.match(check.diagnostic, /Install and authenticate the grok CLI/);
  });

  it('blocks when the resolved CLI does not report a version', () => {
    const check = probeModelRoute('grok-build', 'grok-4.5', () => {
      throw new Error('spawn EINVAL');
    }, () => 'grok-cli');
    assert.equal(check.status, 'blocked');
    assert.equal(check.executable, 'grok-cli');
    assert.match(check.diagnostic, /did not report a version/);
  });

  it('sanitizes untrusted host CLI output before it reaches diagnostics', () => {
    assert.equal(sanitizeProbeText('\u001b[31mgrok 1.0\u001b[0m'), 'grok 1.0');
    assert.equal(sanitizeProbeText('line with\u0007\u0000 controls'), 'line with controls');
    assert.ok(sanitizeProbeText('x'.repeat(500)).length <= 200);
    const version = probeModelRoute('grok-build', null, () => '\u001b[32mgrok 9.9\u001b[0m\n', () => 'grok-cli').version;
    assert.equal(version, 'grok 9.9');
  });

  it('blocks when the resolved CLI reports an empty version', () => {
    const check = probeModelRoute('grok-build', 'grok-4.5', () => '\n\n', () => 'grok-cli');
    assert.equal(check.status, 'blocked');
    assert.match(check.diagnostic, /empty version/);
  });

  it('fails closed when a registered host declares a required capability as unmet', () => {
    registerReviewHostAdapterForTests({
      id: 'capability-gap-host',
      capabilities: { structuredOutput: false, readOnlySandbox: true },
      requiredCapabilities: ['structured-output', 'read-only-sandbox'],
      requiresPromptFile: false,
      requiresSchemaFile: false,
      executableNames: ['capability-gap-host'],
      windowsExecutableNames: [],
      windowsNodeModulesScriptPath: () => null,
      windowsFallbackExecutablePath: () => null,
      buildInvocation: () => ({ args: [], stdin: null }),
      parseEnvelope: () => null,
      probeAfterVersion: () => ({ status: 'ready', modelListed: null, diagnostic: null }),
    });
    try {
      const check = probeModelRoute(
        'capability-gap-host',
        null,
        () => { throw new Error('must not run a command for a capability-gapped host'); },
        () => { throw new Error('must not resolve an executable for a capability-gapped host'); },
      );
      assert.equal(check.status, 'blocked');
      assert.equal(check.executable, null);
      assert.match(check.diagnostic, /structured-output/);
      assert.match(check.diagnostic, /capability-gap-host/);
    } finally {
      resetReviewHostAdaptersForTests();
    }
  });

  it('probes Codex through the shared shim-aware resolution and the debug models catalog', () => {
    const commands = [];
    const check = probeModelRoute('codex', 'gpt-5.6-luna', (executable, args) => {
      commands.push([executable, ...args]);
      if (args.includes('--version')) return 'codex-cli 0.144.5\n';
      if (args.includes('debug')) return JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }] });
      throw new Error(`unexpected probe command: ${args.join(' ')}`);
    }, () => ({ executable: 'node-cli', prefixArgs: ['codex.js'] }));
    assert.equal(check.status, 'ready');
    assert.equal(check.executable, 'node-cli');
    assert.equal(check.modelListed, true);
    assert.equal(check.version, 'codex-cli 0.144.5');
    assert.deepEqual(commands, [
      ['node-cli', 'codex.js', '--version'],
      ['node-cli', 'codex.js', 'debug', 'models'],
    ]);
  });

  it('keeps review probes shell-free on Windows, Linux, and macOS', () => {
    const portableHost = 'portable-probe-test';
    registerReviewHostAdapterForTests({
      ...getReviewHostAdapter('codex'),
      id: portableHost,
      windowsShell: undefined,
    });
    try {
      for (const platform of ['win32', 'linux', 'darwin']) {
        const commands = [];
        const executable = platform === 'win32' ? 'node.exe' : 'node';
        const check = probeModelRoute(portableHost, 'gpt-5.6-luna', (command, args) => {
          commands.push([command, ...args]);
          if (args.includes('--version')) return 'codex-cli 0.144.5\n';
          if (args.includes('debug')) return JSON.stringify({ models: [{ slug: 'gpt-5.6-luna' }] });
          throw new Error(`unexpected probe command: ${args.join(' ')}`);
        }, () => ({ executable, prefixArgs: ['codex.js'] }), platform);
        assert.equal(check.status, 'ready');
        assert.ok(commands.every(command => command[0] === executable && command[1] === 'codex.js'));
        assert.ok(commands.every(command => !command.includes('cmd.exe') && !command.includes('sh')));
      }
    } finally {
      resetReviewHostAdaptersForTests();
    }
  });
});
