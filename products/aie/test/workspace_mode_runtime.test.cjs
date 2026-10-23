const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const productRoot = join(__dirname, '..');
const bin = join(productRoot, 'bin', 'run');
const { guardExecutorShippingCommand } = require('../dist/workspace_mode_guard.js');

function workspace(modeSource) {
  const root = mkdtempSync(join(tmpdir(), 'aie-workspace-mode-'));
  mkdirSync(join(root, '.qube'), { recursive: true });
  writeFileSync(join(root, '.qube', 'mode.json'), modeSource);
  const nested = join(root, 'apps', 'service');
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

function sentinelPath(root) {
  const directory = join(root, 'sentinel-bin');
  const calls = join(root, 'external-commands.log');
  mkdirSync(directory, { recursive: true });
  if (process.platform === 'win32') {
    for (const command of ['git', 'gh']) writeFileSync(join(directory, `${command}.cmd`), `@echo ${command}>>"${calls}"\r\n@exit /b 97\r\n`);
  } else {
    for (const command of ['git', 'gh']) {
      const path = join(directory, command);
      writeFileSync(path, `#!/bin/sh\necho ${command} >> "${calls}"\nexit 97\n`, { mode: 0o755 });
    }
  }
  return { directory, calls };
}

function runWithSentinels(args, cwd, sentinel) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: sentinel.directory,
      Path: sentinel.directory,
      PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    },
  });
}

describe('workspace mode runtime guard', () => {
  it('blocks issue commands from a nested plain folder before Git or GitHub runs', () => {
    const fixture = workspace(`${JSON.stringify({ version: 1, mode: 'local' }, null, 2)}\n`);
    const sentinel = sentinelPath(fixture.root);

    const result = runWithSentinels(['queue', '--json'], fixture.nested, sentinel);

    assert.equal(result.status, 5, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.errorKind, 'workspace-mode-local');
    assert.equal(output.mode, 'local');
    assert.equal(output.workspaceRoot, fixture.root);
    assert.match(output.nextAction, /qube mode shipping/);
    assert.equal(existsSync(sentinel.calls), false, existsSync(sentinel.calls) ? readFileSync(sentinel.calls, 'utf8') : '');
  });

  it('fails closed on malformed mode state before Git or GitHub runs', () => {
    const fixture = workspace('{"version":1,"mode":"unexpected"}\n');
    const sentinel = sentinelPath(fixture.root);

    const result = runWithSentinels(['status', '--json'], fixture.nested, sentinel);

    assert.equal(result.status, 5, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.errorKind, 'workspace-mode-invalid');
    assert.match(output.nextAction, /Correct \.qube\/mode\.json/);
    assert.equal(existsSync(sentinel.calls), false, existsSync(sentinel.calls) ? readFileSync(sentinel.calls, 'utf8') : '');
  });

  it('keeps help and local inspection commands available in local mode', () => {
    const fixture = workspace(`${JSON.stringify({ version: 1, mode: 'local' }, null, 2)}\n`);
    assert.equal(guardExecutorShippingCommand(['queue', '--help'], fixture.nested), null);
    assert.equal(guardExecutorShippingCommand(['schema', '--json'], fixture.nested), null);
    assert.equal(guardExecutorShippingCommand(['gates', 'plan', '--dry-run'], fixture.nested), null);
    assert.equal(guardExecutorShippingCommand(['run', 'status', '--name', 'app'], fixture.nested), null);
    assert.equal(guardExecutorShippingCommand(['repo', 'inspect', '--json'], fixture.nested)?.exitCode, 5);
    assert.equal(guardExecutorShippingCommand(['pr', 'thread', 'resolve', '12', '--thread', 'help'], fixture.nested)?.exitCode, 5);
  });

  it('plans gates from explicit changed paths without running Git in local mode', () => {
    const fixture = workspace(`${JSON.stringify({ version: 1, mode: 'local' }, null, 2)}\n`);
    const sentinel = sentinelPath(fixture.root);

    const result = runWithSentinels(['gates', 'plan', '--changed', 'src/app.ts', '--json'], fixture.nested, sentinel);

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.match(JSON.stringify(output), /without Git inspection/);
    assert.equal(existsSync(sentinel.calls), false, existsSync(sentinel.calls) ? readFileSync(sentinel.calls, 'utf8') : '');
  });

  it('serves help and version metadata without running Git or GitHub in local mode', () => {
    const fixture = workspace(`${JSON.stringify({ version: 1, mode: 'local' }, null, 2)}\n`);
    const sentinel = sentinelPath(fixture.root);

    const help = runWithSentinels(['queue', '--help'], fixture.nested, sentinel);
    const version = runWithSentinels(['--version'], fixture.nested, sentinel);
    const subcommandVersion = runWithSentinels(['queue', '--version'], fixture.nested, sentinel);

    assert.equal(help.status, 0, help.stderr);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(subcommandVersion.status, 5, subcommandVersion.stderr);
    assert.equal(existsSync(sentinel.calls), false, existsSync(sentinel.calls) ? readFileSync(sentinel.calls, 'utf8') : '');
  });

  it('checks malformed state before gate planning can inspect Git', () => {
    const fixture = workspace('{"version":1,"mode":"unexpected"}\n');
    const failure = guardExecutorShippingCommand(['gates', 'plan', '--changed', 'src/app.ts'], fixture.nested);
    assert.equal(failure?.exitCode, 5);
    assert.match(failure?.stdout || failure?.stderr || '', /workspace mode|mode could not be read/i);
  });

  it('preserves shipping behavior when mode is absent or set to shipping', () => {
    const plain = mkdtempSync(join(tmpdir(), 'aie-workspace-shipping-'));
    const configured = workspace(`${JSON.stringify({ version: 1, mode: 'shipping' }, null, 2)}\n`);
    assert.equal(guardExecutorShippingCommand(['queue'], plain), null);
    assert.equal(guardExecutorShippingCommand(['pr', 'gate', '12'], configured.nested), null);
  });

  it('classifies Executor issue and shipping entry points as blocked in local mode', () => {
    const fixture = workspace(`${JSON.stringify({ version: 1, mode: 'local' }, null, 2)}\n`);
    const commands = [
      ['doctor'], ['status'], ['labels', 'setup'], ['queue'], ['next'], ['start', 'next'], ['switch', '94'], ['complete', '93'],
      ['checklist', 'verify', '93'], ['init', '.'], ['gates', 'status'], ['audit', 'ui', '93'], ['review', 'gate', '93'],
      ['pr', 'view', '12'], ['branch', 'check', '93'], ['repo', 'inspect'], ['repo', 'prime'], ['deps', 'graph'], ['view', '93'],
    ];
    for (const command of commands) {
      assert.equal(guardExecutorShippingCommand(command, fixture.nested)?.exitCode, 5, command.join(' '));
    }
  });
});
