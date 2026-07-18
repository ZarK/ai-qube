'use strict';

require('./compile_cache.cjs');
const { execFileSync } = require('node:child_process');
const { cpSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

// One pristine repository is built per shape and then cloned with a plain
// filesystem copy for every test, replacing the per-test git subprocess
// ceremony (7 spawns) with a few milliseconds of file copying.
const templates = new Map();

function run(repo, args) {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
}

function buildBareRepo(repo) {
  run(repo, ['init', '-b', 'main']);
}

function buildConfiguredRepo(repo) {
  buildBareRepo(repo);
  run(repo, ['config', 'user.email', 'executor@example.invalid']);
  run(repo, ['config', 'user.name', 'Executor Test']);
}

function buildCommittedRepo(repo) {
  buildConfiguredRepo(repo);
  writeFileSync(join(repo, 'README.md'), 'fixture\n');
  run(repo, ['add', 'README.md']);
  run(repo, ['commit', '-m', 'fixture']);
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  run(repo, ['update-ref', 'refs/remotes/origin/main', head]);
}

const SHAPES = {
  bare: buildBareRepo,
  configured: buildConfiguredRepo,
  committed: buildCommittedRepo,
};

function cloneGitRepo(shape, prefix) {
  const build = SHAPES[shape];
  if (!build) throw new Error(`unknown git fixture shape: ${shape}`);
  let template = templates.get(shape);
  if (!template) {
    template = mkdtempSync(join(tmpdir(), `aie-git-template-${shape}-`));
    build(template);
    templates.set(shape, template);
  }
  const repo = mkdtempSync(join(tmpdir(), prefix));
  cpSync(template, repo, { recursive: true });
  return repo;
}

module.exports = { cloneGitRepo };
