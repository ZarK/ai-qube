const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'aie-runner-'));
  writeFileSync(join(root, 'aie.config.json'), JSON.stringify({
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
    const plan = buildSpawnPlan({ repoRoot: root, name: 'ui-audit', cwd: 'apps/web', command: ['npm.cmd', 'run', 'dev'] }, paths);

    assert.equal(plan.command, 'npm.cmd');
    assert.deepEqual(plan.args, ['run', 'dev']);
    assert.equal(plan.cwd, resolve(root, 'apps/web'));
    assert.equal(plan.detached, true);
    assert.equal(plan.windowsHide, true);
    assert.equal(paths.metadataPath, join(root, '.aie', 'runs', 'ui-audit', 'metadata.json'));
    assert.equal(paths.stdoutPath, join(root, '.aie', 'runs', 'ui-audit', 'stdout.log'));
    assert.equal(paths.stderrPath, join(root, '.aie', 'runs', 'ui-audit', 'stderr.log'));
  });

  it('plans start without launching and reports persisted current-process status', async () => {
    const { runStart, runStatus, runPaths } = await import('../dist/local_app_runner.js');
    const root = repo();
    const planned = runStart({ repoRoot: root, name: 'ui-audit', command: ['npm', 'run', 'dev'], dryRun: true });

    assert.equal(planned.ok, true);
    assert.equal(planned.dryRun, true);
    assert.equal(planned.pid, null);
    assert.equal(planned.spawnPlan.windowsHide, true);

    const paths = runPaths(root, 'ui-audit');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
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

  it('fails bounded readiness waits with captured log tails', async () => {
    const { runPaths, runWait } = await import('../dist/local_app_runner.js');
    const root = repo();
    const paths = runPaths(root, 'ui-audit');
    mkdirSync(paths.directory, { recursive: true });
    writeFileSync(paths.metadataPath, JSON.stringify({
      version: 1,
      name: 'ui-audit',
      pid: process.pid,
      command: [process.execPath],
      cwd: root,
      startedAt: '2026-06-18T00:00:00.000Z',
      platform: process.platform,
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
});
