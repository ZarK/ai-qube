const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync } = require('node:child_process');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { getDefaults } = require('../dist/config/index.js');
const { configToExecutorPolicy } = require('../dist/config_policy.js');
const { runInit } = require('../dist/init/index.js');
const {
  LOCAL_RUNTIME_GITIGNORE_HEADER,
  LOCAL_RUNTIME_GITIGNORE_RULES,
  TRACKED_QUBE_CONFIG_PATHS,
  lineCoversRule,
  missingLocalRuntimeGitignoreRules,
  planLocalRuntimeGitignoreUpdate,
  writtenRulesCoverTrackedConfig,
} = require('../dist/init/local_runtime_gitignore.js');
const { createLocalGitRepositoryProvider } = require('../dist/providers/local/local_git_provider.js');

function makeGitRepo() {
  return cloneGitRepo('committed', 'aie-gitignore-');
}

function porcelain(repo) {
  return execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
}

async function inspectDirty(repo) {
  const state = await createLocalGitRepositoryProvider({ cwd: repo }).inspect(configToExecutorPolicy(getDefaults()));
  return state.dirty;
}

function commitFile(repo, relativePath, content) {
  const absolute = join(repo, relativePath);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
  execFileSync('git', ['add', relativePath], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', `add ${relativePath}`], { cwd: repo, stdio: 'ignore' });
}

describe('local runtime gitignore merge', () => {
  it('creates a gitignore with only the local runtime rules', () => {
    const planned = planLocalRuntimeGitignoreUpdate(null);
    assert.equal(planned.operation, 'create');
    assert.ok(planned.content.startsWith(`${LOCAL_RUNTIME_GITIGNORE_HEADER}\n`));
    for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
      assert.match(planned.content, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
    assert.equal(writtenRulesCoverTrackedConfig(), false);
  });

  it('appends missing rules and keeps existing lines', () => {
    const existing = 'node_modules/\n*.log\n';
    const planned = planLocalRuntimeGitignoreUpdate(existing);
    assert.equal(planned.operation, 'append');
    assert.ok(planned.content.startsWith('node_modules/\n*.log\n'));
    assert.match(planned.content, /node_modules\//);
    assert.match(planned.content, /\*\.log/);
    for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
      assert.equal(planned.missing.includes(rule), true);
      assert.match(planned.content, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
  });

  it('is unchanged when every local runtime rule is already present', () => {
    const existing = `${LOCAL_RUNTIME_GITIGNORE_HEADER}\n${LOCAL_RUNTIME_GITIGNORE_RULES.join('\n')}\n`;
    const planned = planLocalRuntimeGitignoreUpdate(existing);
    assert.equal(planned.operation, 'unchanged');
    assert.equal(planned.content, existing);
    assert.deepEqual(planned.missing, []);
  });

  it('treats a parent .qube/ rule as coverage and does not append children', () => {
    const existing = 'dist/\n.qube/\n';
    const planned = planLocalRuntimeGitignoreUpdate(existing);
    assert.equal(planned.operation, 'unchanged');
    assert.equal(planned.content, existing);
    assert.deepEqual(planned.missing, []);
  });

  it('treats empty and comment-only gitignore as missing rules', () => {
    const planned = planLocalRuntimeGitignoreUpdate('# keep this comment\n\n');
    assert.equal(planned.operation, 'append');
    assert.match(planned.content, /^# keep this comment$/m);
    assert.equal(planned.missing.length, LOCAL_RUNTIME_GITIGNORE_RULES.length);
  });

  it('does not throw on malformed gitignore content', () => {
    const planned = planLocalRuntimeGitignoreUpdate('\0\n\\\n[');
    assert.equal(planned.operation, 'append');
    assert.equal(planned.missing.length, LOCAL_RUNTIME_GITIGNORE_RULES.length);
    assert.ok(planned.content.includes('\0'));
  });

  it('does not treat committed config paths as ignored by the written rules', () => {
    assert.equal(writtenRulesCoverTrackedConfig(), false);
    for (const path of TRACKED_QUBE_CONFIG_PATHS) {
      for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
        assert.equal(lineCoversRule(rule, path), false, `${rule} must not cover ${path}`);
      }
    }
  });

  it('does not write a blanket .qube/ rule', () => {
    const planned = planLocalRuntimeGitignoreUpdate(null);
    const lines = planned.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.equal(lines.includes('.qube/'), false);
    assert.equal(lines.includes('.qube'), false);
    assert.equal(missingLocalRuntimeGitignoreRules(planned.content).length, 0);
  });
});

describe('local runtime gitignore init and dirty checkout', () => {
  it('writes a gitignore on fresh init', async () => {
    const repo = makeGitRepo();
    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const action = result.actions.find((item) => item.id === 'local-runtime-gitignore');
    assert.equal(action.operation, 'create');
    assert.equal(action.status, 'completed');
    const content = require('node:fs').readFileSync(join(repo, '.gitignore'), 'utf8');
    for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
      assert.match(content, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
  });

  it('keeps existing gitignore lines and appends only missing rules', async () => {
    const repo = makeGitRepo();
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const content = require('node:fs').readFileSync(join(repo, '.gitignore'), 'utf8');
    assert.ok(content.startsWith('node_modules/\n'));
    for (const rule of LOCAL_RUNTIME_GITIGNORE_RULES) {
      assert.match(content, new RegExp(`^${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
  });

  it('leaves a complete gitignore unchanged', async () => {
    const repo = makeGitRepo();
    const existing = `${LOCAL_RUNTIME_GITIGNORE_HEADER}\n${LOCAL_RUNTIME_GITIGNORE_RULES.join('\n')}\n`;
    writeFileSync(join(repo, '.gitignore'), existing);
    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);
    const action = result.actions.find((item) => item.id === 'local-runtime-gitignore');
    assert.equal(action.status, 'skipped');
    assert.equal(require('node:fs').readFileSync(join(repo, '.gitignore'), 'utf8'), existing);
  });

  it('does not list review evidence after the ignore rules exist', async () => {
    const repo = makeGitRepo();
    commitFile(repo, '.gitignore', planLocalRuntimeGitignoreUpdate(null).content);
    mkdirSync(join(repo, '.qube', 'aie', 'reviews', '565', '1', 'abc'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'reviews', '565', '1', 'abc', 'issue-compliance.json'), '{}\n');
    assert.equal(porcelain(repo), '');
    const dirty = await inspectDirty(repo);
    assert.equal(dirty.dirty, false);
    assert.deepEqual(dirty.paths, []);
  });

  it('still reports a dirty checkout when committed config changes', async () => {
    const repo = makeGitRepo();
    commitFile(repo, '.gitignore', planLocalRuntimeGitignoreUpdate(null).content);
    commitFile(repo, '.qube/aie/config.json', `${JSON.stringify({ policy: {} }, null, 2)}\n`);
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify({ policy: { autonomousMode: true } }, null, 2)}\n`);
    const status = porcelain(repo);
    assert.match(status, /\.qube\/aie\/config\.json/);
    const dirty = await inspectDirty(repo);
    assert.equal(dirty.dirty, true);
    assert.equal(dirty.paths.some((entry) => entry.includes('.qube/aie/config.json') || entry.includes('.qube\\aie\\config.json')), true);
  });
});
