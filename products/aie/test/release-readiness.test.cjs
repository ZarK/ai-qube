const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');

const { runInit } = require('../dist/init/index.js');

function makeGitRepo(prefix) {
  return cloneGitRepo('committed', prefix);
}

describe('release readiness repository fixtures', () => {
  it('covers a clean repository by installing managed Executor files without package-manager defaults', async () => {
    const repo = makeGitRepo('aie-release-clean-');

    const result = await runInit({ target: '.', tool: 'opencode', dryRun: false, force: false, cwd: repo });

    assert.equal(result.ok, true);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'config.json')), true);
    assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /BEGIN EXECUTOR MANAGED SECTION/);
    assert.match(readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8'), /Continue repository development/);
    assert.equal(existsSync(join(repo, '.npmrc')), false);
    assert.equal(existsSync(join(repo, '.gitignore')), true);
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /\.qube\/aie\/reviews\//);
    assert.equal(existsSync(join(repo, '.qube', 'aie', 'runs')), false);
  });

  it('covers all supported host projections from one init renderer pass', async () => {
    const repo = makeGitRepo('aie-release-hosts-');

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    assert.equal(result.ok, true);

    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
    const command = readFileSync(join(repo, '.opencode', 'commands', 'make-it-so.md'), 'utf8');

    assert.deepEqual(result.selectedTools, ['opencode', 'codex', 'claude-code', 'grok-build', 'cursor']);
    assert.match(agents, /OpenCode: instructions `AGENTS\.md`/);
    assert.match(agents, /Codex: instructions `AGENTS\.md`/);
    assert.match(agents, /Grok Build: instructions `AGENTS\.md`/);
    assert.match(agents, /Cursor: instructions `AGENTS\.md`/);
    assert.match(claude, /Claude Code: instructions `CLAUDE\.md`/);
    assert.match(agents, /configured work and review provider is GitHub/);
    assert.match(command, /Continue repository development by completing the current issue, shipping it, and selecting the next ready issue/);
    assert.equal(existsSync(join(repo, '.agents', 'skills', 'make-it-so', 'SKILL.md')), true);
    assert.equal(existsSync(join(repo, '.claude', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.grok', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.cursor', 'commands', 'make-it-so.md')), true);
    assert.equal(existsSync(join(repo, '.opencode', 'commands', 'makeitso.md')), false);
    assert.equal(existsSync(join(repo, '.npmrc')), false);
  });

  it('writes installed qube aie commands even when a workspace runner exists', async () => {
    const repo = makeGitRepo('aie-release-installed-runner-');
    mkdirSync(join(repo, 'products', 'aie', 'bin'), { recursive: true });
    writeFileSync(join(repo, 'products', 'aie', 'bin', 'run'), '#!/usr/bin/env node\n');

    const result = await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    const agents = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
    const claude = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');

    assert.equal(result.ok, true);
    assert.match(agents, /`qube aie start`/);
    assert.match(claude, /`qube aie complete <issue>`/);
    assert.doesNotMatch(agents, /products\/aie\/bin\/run/);
    assert.doesNotMatch(claude, /node products\/aie\/bin\/run/);
    assert.doesNotMatch(`${agents}\n${claude}`, /source checkout path/);
  });

  it('keeps shipped docs and generated instructions product-generic', async () => {
    const repo = makeGitRepo('aie-release-wording-');
    await runInit({ target: '.', tool: 'all', dryRun: false, force: false, cwd: repo });
    const contents = [
      readFileSync(join(process.cwd(), 'README.md'), 'utf8'),
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
