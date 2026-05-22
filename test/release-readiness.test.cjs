const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const { runInit } = require('../dist/init/index.js');
const { buildMigrationPlan, runMigration } = require('../dist/migrate/index.js');
const { buildMigrationReadinessDiagnostics } = require('../dist/migration_diagnostics.js');

function makeGitRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'executor@example.invalid'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Executor Test'], { cwd: repo, stdio: 'ignore' });
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'ignore' });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function writeLegacyFixture(repo) {
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, '.opencode', 'commands'), { recursive: true });
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(repo, 'gh-priority-order.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, 'scripts', 'gh-project-report.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(repo, '.opencode', 'commands', 'project.md'), 'Run scripts/gh-issue-start.sh before selecting issue work.\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Use gh-priority-order.sh for issue queue selection.\n');
  writeFileSync(join(repo, 'docs', 'gh-workflow.md'), 'Run gh-issue-complete.sh after the pull request is merged.\n');
}

describe('release readiness repository fixtures', () => {
  it('covers a clean repository by installing managed Executor files without package-manager defaults', async () => {
    const repo = makeGitRepo('aie-release-clean-');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(existsSync(join(repo, 'aie.config.json')), true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'), /Continue repository development/);
    assert.equal(existsSync(join(repo, '.npmrc')), false);
    assert.equal(existsSync(join(repo, '.aie')), false);
  });

  it('covers all supported host projections from one init renderer pass', async () => {
    const repo = makeGitRepo('aie-release-hosts-');

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo, policy: { opencodeCommandAlias: true } });
    assert.equal(result.ok, true);

    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');
    const alias = readFileSync(join(repo, '.opencode', 'commands', 'makeitso.md'), 'utf8');

    assert.deepEqual(result.selectedTools, ['opencode', 'codex', 'claude-code']);
    assert.match(agents, /OpenCode: instructions target `AGENTS\.md`/);
    assert.match(agents, /Codex: instructions target `AGENTS\.md`/);
    assert.match(claude, /Claude Code: instructions target `CLAUDE\.md`/);
    assert.match(agents, /configured work and review provider is GitHub/);
    assert.match(command, /Continue repository development by solving open GitHub issues through Executor/);
    assert.equal(alias, command);
    assert.equal(existsSync(join(repo, '.npmrc')), false);
  });

  it('covers a mixed repository by preserving unrelated files while reporting known legacy helpers', async () => {
    const repo = makeGitRepo('aie-release-mixed-');
    mkdirSync(join(repo, 'scripts', 'lib'), { recursive: true });
    writeFileSync(join(repo, 'scripts', 'deploy.sh'), '#!/bin/sh\necho deploy\n');
    writeFileSync(join(repo, 'scripts', 'gh-workflow.sh'), '#!/bin/sh\n# issue work helper\n');
    writeFileSync(join(repo, 'scripts', 'lib', 'gh-priority-order.sh'), '#!/bin/sh\n# queue helper\n');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });
    const legacyCategories = result.legacy.map(item => item.category).sort();

    assert.equal(result.ok, true);
    assert.deepEqual(legacyCategories, ['lifecycle', 'queue']);
    assert.equal(readFileSync(join(repo, 'scripts', 'deploy.sh'), 'utf8'), '#!/bin/sh\necho deploy\n');
    assert.equal(readFileSync(join(repo, 'scripts', 'gh-workflow.sh'), 'utf8'), '#!/bin/sh\n# issue work helper\n');
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
  });

  it('covers a legacy repository with deterministic migration diagnostics', async () => {
    const repo = makeGitRepo('aie-release-legacy-');
    writeLegacyFixture(repo);

    const plan = await buildMigrationPlan({ cwd: repo, dryRun: true });
    const readiness = buildMigrationReadinessDiagnostics(plan);

    assert.equal(plan.ok, true);
    assert.equal(readiness.legacyState, 'detected');
    assert.equal(readiness.detectedPaths, 6);
    assert.deepEqual(readiness.detectedCategories, ['instruction-block', 'project-command', 'shell-helper', 'workflow-doc']);
    assert.equal(readiness.cleanupStatus, 'blocked');
    assert.equal(readiness.remainingLegacyReferences.count, 3);
    assert.ok(readiness.recommendedCommands.includes('aie migrate legacy --dry-run'));
  });

  it('covers a wrapper repository by installing only compatibility wrappers for known helper paths', async () => {
    const repo = makeGitRepo('aie-release-wrapper-');
    writeLegacyFixture(repo);

    const result = await runMigration({ cwd: repo, apply: true, installWrappers: true });
    const plan = await buildMigrationPlan({ cwd: repo, dryRun: true });
    const readiness = buildMigrationReadinessDiagnostics(plan);

    assert.equal(result.ok, true);
    assert.match(readFileSync(join(repo, 'gh-priority-order.sh'), 'utf8'), /exec 'aie' 'queue' "\$@"/);
    assert.match(readFileSync(join(repo, 'scripts', 'gh-issue-start.sh'), 'utf8'), /exec 'aie' 'start' "\$@"/);
    assert.equal(readiness.wrapperState.installed, 2);
    assert.equal(readiness.wrapperState.stale, 0);
    assert.equal(readiness.wrapperState.paths.includes('scripts/gh-project-report.sh'), false);
  });

  it('covers a conflict repository by blocking unmanaged instruction rewrites until forced', async () => {
    const repo = makeGitRepo('aie-release-conflict-');
    writeFileSync(join(repo, 'AGENTS.md'), 'Use gh-priority-order.sh for issue queue selection.\n');

    const blocked = await buildMigrationPlan({ cwd: repo, apply: true, dryRun: true, instructionPaths: ['AGENTS.md'] });
    const update = blocked.instructionUpdates.find(item => item.path === 'AGENTS.md');

    assert.equal(blocked.ok, false);
    assert.equal(update.status, 'blocked');
    assert.equal(update.forceRequired, true);
    assert.match(update.reason, /--force/);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /gh-priority-order\.sh/);
  });

  it('keeps shipped docs and generated instructions product-generic', async () => {
    const repo = makeGitRepo('aie-release-wording-');
    await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    const contents = [
      readFileSync(join(process.cwd(), 'README.md'), 'utf8'),
      readFileSync(join(process.cwd(), 'docs', 'migration.md'), 'utf8'),
      readFileSync(join(repo, 'AGENTS.md'), 'utf8'),
      readFileSync(join(repo, 'CLAUDE.md'), 'utf8'),
      readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'),
    ].join('\n');

    assert.match(contents, /Do not mention milestone numbers, bootstrap phases, issue implementation history, baseline language/);
    assert.match(contents, /reference repository names, local reference paths, or source-provenance explanations/);

    const forbidden = [
      /references\/workflows/i,
      /source reference/i,
      /copied from/i,
      /memex/i,
      /ai-bootstrap/i,
      /ai-umpire/i,
    ];

    for (const pattern of forbidden) {
      assert.doesNotMatch(contents, pattern);
    }
  });
});
