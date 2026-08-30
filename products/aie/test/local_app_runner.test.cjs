const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
require('./support/compile_cache.cjs');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aie-runner-'));
  mkdirSync(join(root, '.qube', 'aie'), { recursive: true });
  writeFileSync(join(root, '.qube', 'aie', 'config.json'), JSON.stringify({
    version: 1,
    providers: {
      work: { kind: 'github' },
      review: { kind: 'github' },
      repository: { kind: 'local-git' },
      ci: { kind: 'github' },
      layout: { kind: 'local' },
      capabilities: { work: true, review: true, repository: true, ci: true, layout: true },
    },
    policy: {},
  }, null, 2));
  return root;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

describe('local app runner service', () => {
  it('builds Windows-hidden detached spawn plans and deterministic paths', async () => {
    const { buildSpawnPlan, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit');
    const plan = buildSpawnPlan({ repoRoot: root, name: 'ui-audit', cwd: 'apps/web', command: ['npm.cmd', 'run', 'dev'], platform: 'linux' }, paths);

    assert.equal(plan.command, 'npm.cmd');
    assert.deepEqual(plan.args, ['run', 'dev']);
    assert.equal(plan.cwd, resolve(root, 'apps/web'));
    assert.equal(plan.detached, true);
    assert.equal(plan.windowsHide, true);
    assert.equal(plan.shell, false);
    assert.equal(paths.metadataPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'metadata.json'));
    assert.equal(paths.currentAttemptPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'current-attempt.json'));
    assert.equal(paths.attemptId, null);
    assert.equal(paths.stdoutPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'stdout-not-started.log'));
    assert.equal(paths.stderrPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'stderr-not-started.log'));
  });

  it('resolves Windows launcher scripts and escapes them through cmd.exe', async () => {
    const { buildSpawnPlan, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const bin = join(root, 'win-bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'pnpm.cmd'), '@echo off\r\n');
    const paths = runPaths(root, 'ui-audit');
    const plan = buildSpawnPlan({
      repoRoot: root,
      name: 'ui-audit',
      command: ['pnpm', 'dev', 'quoted "arg"'],
      platform: 'win32',
      env: { PATH: bin, PATHEXT: '.CMD;.EXE', OS: 'Windows_NT', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    }, paths);

    assert.match(plan.command, /cmd\.exe$/i);
    assert.equal(plan.args[0], '/d');
    assert.equal(plan.args[1], '/s');
    assert.equal(plan.args[2], '/c');
    assert.match(plan.args[3], /^".*pnpm\.cmd.*quoted ""arg"".*"$/i);
    assert.equal(plan.shell, false);
    assert.equal(plan.windowsVerbatimArguments, true);
  });

  it('does not wrap a missing Windows launcher as a successful command', async () => {
    const { buildSpawnPlan, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit');
    const plan = buildSpawnPlan({
      repoRoot: root,
      name: 'ui-audit',
      command: ['pnpm.cmd', 'dev'],
      platform: 'win32',
      env: { PATH: join(root, 'empty-bin'), PATHEXT: '.CMD;.EXE', OS: 'Windows_NT' },
    }, paths);

    assert.equal(plan.command, 'pnpm.cmd');
    assert.deepEqual(plan.args, ['dev']);
    assert.equal(plan.shell, false);
  });

  it('plans start without launching and reports persisted current-process status', async () => {
    const { runStart, runStatus, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const planned = await runStart({ repoRoot: root, name: 'ui-audit', command: ['npm', 'run', 'dev'], dryRun: true });

    assert.equal(planned.ok, true);
    assert.equal(planned.dryRun, true);
    assert.equal(planned.pid, null);
    assert.equal(planned.spawnPlan.windowsHide, true);

    const paths = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      metadataPath: paths.metadataPath,
    }, null, 2));
    writeFileSync(paths.stdoutPath, 'ready-ish\n');
    const status = runStatus({ repoRoot: root, name: 'ui-audit' });

    assert.equal(status.ok, true);
    assert.equal(status.status, 'running');
    assert.equal(status.metadata.pid, process.pid);
    assert.deepEqual(status.logTail.stdout, ['ready-ish']);
  });

  it('does not treat substring executable names as the expected process', async () => {
    const { runStatus, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: ['go'],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      metadataPath: paths.metadataPath,
    }, null, 2));

    const status = runStatus({ repoRoot: root, name: 'ui-audit' });

    assert.equal(status.ok, true);
    assert.equal(status.status, 'unknown');
  });

  it('rejects file readiness URLs before probing', async () => {
    const { runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    let probed = false;

    const result = await runWait({
      repoRoot: root,
      name: 'ui-audit',
      url: 'file:///tmp/ready',
      fetchImpl: async () => {
        probed = true;
        throw new Error('should not probe');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'request-failed');
    assert.equal(probed, false);
    assert.match(result.error, /Refusing non-local readiness URL/);
  });

  it('fails bounded readiness waits with captured log tails', async () => {
    const { runPaths, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      metadataPath: paths.metadataPath,
    }, null, 2));
    writeFileSync(paths.stderrPath, 'port already in use\n');

    const result = await runWait({
      repoRoot: root,
      name: 'ui-audit',
      url: 'http://127.0.0.1:1',
      timeoutSeconds: 1,
      pollIntervalMs: 100,
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'timeout');
    assert.match(result.error, /connection refused|Timed out/);
    assert.deepEqual(result.logTail.stderr, ['port already in use']);
  });

  it('rejects non-local readiness URLs before probing', async () => {
    const { runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    let probed = false;

    const result = await runWait({
      repoRoot: root,
      name: 'ui-audit',
      url: 'https://example.com/health',
      fetchImpl: async () => {
        probed = true;
        throw new Error('should not probe');
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'request-failed');
    assert.equal(probed, false);
    assert.match(result.error, /Refusing non-local readiness URL/);
  });

  it('plans start against a new attempt log pair without writing files', async () => {
    const { runStart } = await import('../dist/local_app_runner.js');
    const root = repo();
    const planned = await runStart({
      repoRoot: root,
      name: 'ui-audit',
      command: ['npm', 'run', 'dev'],
      dryRun: true,
      now: new Date('2026-06-18T00:00:00.000Z'),
    });

    assert.equal(planned.ok, true);
    assert.equal(planned.attemptId, '20260618T000000000Z');
    assert.equal(planned.paths.stdoutPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'stdout-20260618T000000000Z.log'));
    assert.equal(planned.paths.stderrPath, join(root, '.qube', 'aie', 'runs', 'ui-audit', 'stderr-20260618T000000000Z.log'));
    assert.equal(planned.spawnPlan.stderrPath, planned.paths.stderrPath);
    assert.equal(existsSync(planned.paths.directory), false);
  });

  it('covers fail-then-success sequences: default tail excludes the prior failure', async () => {
    const { runPaths, runStatus, runStop, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const failed = runPaths(root, 'ui-audit', '20260618T000000000Z');
    const succeeded = runPaths(root, 'ui-audit', '20260618T000001000Z');
    mkdirSync(failed.directory, { recursive: true });
    writeFileSync(failed.stderrPath, 'spawn npm ENOENT\n');
    writeFileSync(succeeded.stdoutPath, 'listening on 5173\n');
    writeFileSync(succeeded.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: succeeded.attemptId,
      stdoutPath: succeeded.stdoutPath,
      stderrPath: succeeded.stderrPath,
      startedAt: '2026-06-18T00:00:01.000Z',
    }, null, 2));
    writeFileSync(succeeded.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:01.000Z',
      platform: process.platform,
      attemptId: succeeded.attemptId,
      stdoutPath: succeeded.stdoutPath,
      stderrPath: succeeded.stderrPath,
      metadataPath: succeeded.metadataPath,
    }, null, 2));

    const status = runStatus({ repoRoot: root, name: 'ui-audit' });
    const wait = await runWait({
      repoRoot: root,
      name: 'ui-audit',
      url: 'http://127.0.0.1:1',
      timeoutSeconds: 1,
      pollIntervalMs: 100,
      fetchImpl: async () => ({ status: 200 }),
    });
    const stop = runStop({ repoRoot: root, name: 'ui-audit', dryRun: true });
    const historic = runStatus({ repoRoot: root, name: 'ui-audit', attemptId: failed.attemptId });

    assert.equal(status.attemptId, succeeded.attemptId);
    assert.equal(wait.attemptId, succeeded.attemptId);
    assert.equal(stop.attemptId, succeeded.attemptId);
    assert.deepEqual(status.logTail.stdout, ['listening on 5173']);
    assert.deepEqual(status.logTail.stderr, []);
    assert.deepEqual(wait.logTail.stderr, []);
    assert.deepEqual(stop.logTail.stderr, []);
    assert.ok(!status.logTail.stderr.some(line => /ENOENT/.test(line)));
    assert.deepEqual(historic.logTail.stderr, ['spawn npm ENOENT']);
    assert.ok(status.paths.historicalLogs.some(entry => entry.attemptId === failed.attemptId));
    assert.ok(existsSync(failed.stderrPath));
  });

  it('covers success-then-fail sequences: default tail excludes the prior success', async () => {
    const { runPaths, runStatus, runStop, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const succeeded = runPaths(root, 'ui-audit', '20260618T000000000Z');
    const failed = runPaths(root, 'ui-audit', '20260618T000001000Z');
    mkdirSync(failed.directory, { recursive: true });
    writeFileSync(succeeded.stdoutPath, 'listening on 5173\n');
    writeFileSync(failed.stderrPath, 'spawn npm ENOENT\n');
    writeFileSync(failed.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: failed.attemptId,
      stdoutPath: failed.stdoutPath,
      stderrPath: failed.stderrPath,
      startedAt: '2026-06-18T00:00:01.000Z',
    }, null, 2));

    const status = runStatus({ repoRoot: root, name: 'ui-audit' });
    const wait = await runWait({
      repoRoot: root,
      name: 'ui-audit',
      url: 'http://127.0.0.1:1',
      timeoutSeconds: 1,
      pollIntervalMs: 100,
      fetchImpl: async () => {
        throw new Error('should not matter');
      },
    });
    const stop = runStop({ repoRoot: root, name: 'ui-audit' });
    const historic = runStatus({ repoRoot: root, name: 'ui-audit', attemptId: succeeded.attemptId });

    assert.equal(status.status, 'missing');
    assert.equal(status.attemptId, failed.attemptId);
    assert.equal(wait.attemptId, failed.attemptId);
    assert.equal(stop.attemptId, failed.attemptId);
    assert.deepEqual(status.logTail.stderr, ['spawn npm ENOENT']);
    assert.deepEqual(wait.logTail.stderr, ['spawn npm ENOENT']);
    assert.deepEqual(stop.logTail.stderr, ['spawn npm ENOENT']);
    assert.ok(!status.logTail.stdout.includes('listening on 5173'));
    assert.deepEqual(historic.logTail.stdout, ['listening on 5173']);
  });

  it('returns empty tails for an unknown attempt without changing current process status', async () => {
    const { runPaths, runStatus } = await import('../dist/local_app_runner.js');
    const root = repo();
    const current = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(current.directory, { recursive: true });
    writeFileSync(current.stdoutPath, 'listening on 5173\n');
    writeFileSync(current.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: current.attemptId,
      stdoutPath: current.stdoutPath,
      stderrPath: current.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(current.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: current.attemptId,
      stdoutPath: current.stdoutPath,
      stderrPath: current.stderrPath,
      metadataPath: current.metadataPath,
    }, null, 2));

    const historic = runStatus({ repoRoot: root, name: 'ui-audit', attemptId: 'missing-attempt' });
    const currentStatus = runStatus({ repoRoot: root, name: 'ui-audit' });

    assert.equal(historic.ok, true);
    assert.equal(historic.status, 'running');
    assert.equal(historic.attemptId, 'missing-attempt');
    assert.deepEqual(historic.logTail.stdout, []);
    assert.deepEqual(historic.logTail.stderr, []);
    assert.match(historic.nextAction, /No logs exist for attempt missing-attempt/);
    assert.deepEqual(currentStatus.logTail.stdout, ['listening on 5173']);
  });

  it('rejects traversal attempt ids', async () => {
    const { runStatus } = await import('../dist/local_app_runner.js');
    const root = repo();
    const result = runStatus({ repoRoot: root, name: 'ui-audit', attemptId: '../secret' });
    assert.equal(result.ok, false);
    assert.match(result.error, /run attempt id must contain only letters, numbers, dot, underscore, or dash/);
  });

  it('ignores unversioned logs when the current-attempt pointer is malformed', async () => {
    const { runPaths, runStatus } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, '{not-json');
    writeFileSync(join(paths.directory, 'stderr.log'), 'unversioned noise\n');
    const status = runStatus({ repoRoot: root, name: 'ui-audit' });
    assert.equal(status.ok, true);
    assert.equal(status.attemptId, null);
    assert.deepEqual(status.logTail.stderr, []);
    assert.deepEqual(status.paths.historicalLogs, []);
  });

  it('isolates a live missing-command spawn error from a later successful start', async () => {
    const { runStart, runStatus, runStop } = await import('../dist/local_app_runner.js');
    const root = repo();
    const failed = await runStart({
      repoRoot: root,
      name: 'ui-audit',
      command: ['aie-missing-runner-307'],
      now: new Date('2026-06-18T00:00:00.000Z'),
    });
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? '', /not on PATH/);
    assert.equal(failed.status, 'missing');
    assert.ok(existsSync(failed.paths.stderrPath) && /spawn error/.test(readFileSync(failed.paths.stderrPath, 'utf8')));

    const succeeded = await runStart({
      repoRoot: root,
      name: 'ui-audit',
      command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      now: new Date('2026-06-18T00:00:01.000Z'),
    });

    try {
      const status = runStatus({ repoRoot: root, name: 'ui-audit' });
      const historic = runStatus({ repoRoot: root, name: 'ui-audit', attemptId: failed.attemptId });

      assert.ok(succeeded.ok, succeeded.error);
      assert.equal(status.status, 'running');
      assert.equal(status.attemptId, succeeded.attemptId);
      assert.ok(existsSync(status.metadata.metadataPath));
      assert.equal(status.metadata.attemptId, succeeded.attemptId);
      assert.ok(!status.logTail.stderr.some(line => /ENOENT|spawn error/.test(line)));
      assert.ok(historic.logTail.stderr.some(line => /spawn error|ENOENT/.test(line)));
    } finally {
      runStop({ repoRoot: root, name: 'ui-audit' });
    }
  });

  it('waits for a hostname URL when the server answers on IPv6 localhost', async (t) => {
    const { runPaths, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      metadataPath: paths.metadataPath,
    }, null, 2));
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen({ host: '::1', port: 0 }, resolve);
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT') {
        t.skip('IPv6 localhost is not available in this environment');
        return;
      }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      t.skip('IPv6 localhost did not bind a port');
      return;
    }
    try {
      const result = await runWait({
        repoRoot: root,
        name: 'ui-audit',
        url: `http://localhost:${address.port}`,
        timeoutSeconds: 3,
        pollIntervalMs: 100,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, 'ready');
      assert.equal(result.httpStatus, 200);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('waits for an IPv4 localhost URL when the server answers on 127.0.0.1', async () => {
    const { runPaths, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit', '20260618T000000000Z');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      startedAt: '2026-06-18T00:00:00.000Z',
    }, null, 2));
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
      attemptId: paths.attemptId,
      stdoutPath: paths.stdoutPath,
      stderrPath: paths.stderrPath,
      metadataPath: paths.metadataPath,
    }, null, 2));
    const server = http.createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      const result = await runWait({
        repoRoot: root,
        name: 'ui-audit',
        url: `http://127.0.0.1:${address.port}`,
        timeoutSeconds: 3,
        pollIntervalMs: 100,
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.status, 'ready');
      assert.equal(result.httpStatus, 200);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

describe('local app runner CLI', () => {
  it('accepts the documented -- command separator for dry-run start JSON', () => {
    const root = repo();
    const result = binRun(['run', 'start', '--name', 'ui-audit', '--cwd', '.', '--dry-run', '--json', '--', 'npm', 'run', 'dev'], root);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.command, 'run start');
    assert.equal(parsed.dryRun, true);
    assert.deepEqual(parsed.commandLine, ['npm', 'run', 'dev']);
    assert.equal(parsed.spawnPlan.windowsHide, true);
  });

  it('forwards flags, values, spaces, and nested separators after --', () => {
    const root = repo();
    const result = binRun([
      'run', 'start', '--name', 'ui-audit', '--dry-run', '--json', '--',
      'node', 'Program Files/app.mjs', '--dev', '--host=127.0.0.1', '-p', '3000', '--', '--nested', '-1',
    ], root);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.deepEqual(parsed.commandLine, [
      'node', 'Program Files/app.mjs', '--dev', '--host=127.0.0.1', '-p', '3000', '--', '--nested', '-1',
    ]);
    assert.deepEqual(parsed.spawnPlan.args, parsed.commandLine.slice(1));
  });

  it('forwards an empty application argument after --', () => {
    const root = repo();
    const result = binRun(['run', 'start', '--name', 'ui-audit', '--dry-run', '--json', '--', 'node', 'app.mjs', '', '--dev'], root);
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, 0);
    assert.deepEqual(parsed.commandLine, ['node', 'app.mjs', '', '--dev']);
    assert.deepEqual(parsed.spawnPlan.args, ['app.mjs', '', '--dev']);
  });

  it('still rejects unknown AIE flags before the command separator', () => {
    const root = repo();
    const result = binRun(['run', 'start', '--dev', '--', 'node', 'app.mjs'], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unknown flag: --dev/);
  });

  it('preserves an empty application argument after --', () => {
    const root = repo();
    const result = binRun([
      'run', 'start', '--name', 'ui-audit', '--dry-run', '--json', '--',
      'node', 'app.mjs', '',
    ], root);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parsed.commandLine, ['node', 'app.mjs', '']);
    assert.deepEqual(parsed.spawnPlan.args, ['app.mjs', '']);
  });

  it('still fails when no app command follows the separator', () => {
    const root = repo();
    const result = binRun(['run', 'start', '--name', 'ui-audit', '--dry-run', '--json', '--'], root);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /Missing 1 required arg|missing app command after `--`/);
  });

  it('tails a historical attempt through --attempt and keeps current tails separate', async () => {
    const { runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const failed = runPaths(root, 'ui-audit', '20260618T000000000Z');
    const succeeded = runPaths(root, 'ui-audit', '20260618T000001000Z');
    mkdirSync(failed.directory, { recursive: true });
    writeFileSync(failed.stderrPath, 'spawn npm ENOENT\n');
    writeFileSync(succeeded.stdoutPath, 'listening on 5173\n');
    writeFileSync(succeeded.currentAttemptPath, JSON.stringify({
      version: 1,
      attemptId: succeeded.attemptId,
      stdoutPath: succeeded.stdoutPath,
      stderrPath: succeeded.stderrPath,
      startedAt: '2026-06-18T00:00:01.000Z',
    }, null, 2));

    const historic = binRun(['run', 'status', '--name', 'ui-audit', '--attempt', failed.attemptId, '--json'], root);
    const current = binRun(['run', 'status', '--name', 'ui-audit', '--json'], root);
    const historicParsed = JSON.parse(historic.stdout);
    const currentParsed = JSON.parse(current.stdout);

    assert.equal(historic.status, 0);
    assert.equal(current.status, 0);
    assert.deepEqual(historicParsed.logTail.stderr, ['spawn npm ENOENT']);
    assert.deepEqual(currentParsed.logTail.stdout, ['listening on 5173']);
    assert.ok(!currentParsed.logTail.stderr.some(line => /ENOENT/.test(line)));
  });
});
