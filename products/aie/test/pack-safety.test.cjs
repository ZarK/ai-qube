const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const { normalizeHelpArgs } = require('../dist/bin/run.js');
const pkg = require('../package.json');
const tsconfig = require('../tsconfig.json');

describe('package publish surface safety', () => {
  it('does not declare any install lifecycle scripts', () => {
    const scripts = pkg.scripts || {};
    const forbidden = ['preinstall', 'install', 'postinstall'];

    for (const key of forbidden) {
      assert.ok(
        !(key in scripts),
        `Lifecycle script "${key}" must not be present (supply-chain policy violation)`
      );
    }
  });

  it('declares the intended package surface and dry-run pack check', () => {
    assert.deepEqual(pkg.files, ['bin/', 'dist/', 'docs/migration.md', 'README.md']);
    assert.equal(pkg.bin.aie, 'bin/run');
    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.match(pkg.scripts['pack:check'], /^pnpm run build && pnpm pack --dry-run(?:\s|$)/);
    assert.match(pkg.scripts['pack:check'], /--json/);

    const forbiddenPublishRoots = ['src/', 'test/', 'references/', 'scripts/', '.github/', '.umpire/', '.aie/'];
    for (const entry of pkg.files) {
      assert.equal(
        forbiddenPublishRoots.some(root => entry === root || entry.startsWith(root)),
        false,
        `Package files must not expose repository-only path ${entry}`
      );
    }
  });

  it('preserves public help normalization forms', () => {
    assert.deepEqual(normalizeHelpArgs(['help']), ['--help']);
    assert.deepEqual(normalizeHelpArgs(['help', 'init']), ['init', '--help']);
    assert.deepEqual(normalizeHelpArgs(['init', 'help']), ['init', '--help']);
    assert.deepEqual(normalizeHelpArgs(['init', '.', 'help']), ['init', '.', 'help']);
    assert.deepEqual(normalizeHelpArgs(['unknown', 'help']), ['unknown', 'help']);
    assert.deepEqual(normalizeHelpArgs(['init', '.']), ['init', '.']);
    assert.deepEqual(normalizeHelpArgs(['init', '--json', '--help']), ['init', '--help', '--json']);
    assert.deepEqual(normalizeHelpArgs(['init', '-j', '-h', '-j']), ['init', '--help', '-j']);
  });

  it('uses the final ESM runtime shape', () => {
    const bin = readFileSync(join(__dirname, '..', 'bin', 'run'), 'utf8');

    assert.equal(pkg.type, 'module');
    assert.equal(tsconfig.compilerOptions.module, 'NodeNext');
    assert.equal(tsconfig.compilerOptions.moduleResolution, 'NodeNext');
    assert.match(bin, /dist\/bin\/run\.js/);
    assert.doesNotMatch(bin, /@oclif\/core/);
    assert.doesNotMatch(bin, /require\(/);
  });

  it('keeps dependencies minimal and exact', () => {
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@tjalve/qube-cli']);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript']);
    assert.equal(pkg.oclif, undefined);

    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
    }
  });

  it('keeps trusted publishing staged, tokenless, and pinned', () => {
    const workflowPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'publish.yml');
    assert.equal(existsSync(workflowPath), true);

    const workflow = readFileSync(workflowPath, 'utf8');
    const actionPins = [...workflow.matchAll(/uses: ([^@\s]+)@([0-9a-f]{40})/g)];

    assert.equal(pkg.publishConfig.access, 'public');
    assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
    assert.equal(pkg.publishConfig.provenance, true);
    assert.equal(pkg.scripts.verify, 'pnpm run lint && pnpm run test && pnpm run pack:check');
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /permissions:\n\s+contents: read\n\s+id-token: write/);
    assert.match(workflow, /environment: npm-publish/);
    assert.match(workflow, /runs-on: ubuntu-latest/);
    assert.match(workflow, /node-version: 24/);
    assert.match(workflow, /package-manager-cache: false/);
    assert.match(workflow, /corepack prepare pnpm@11\.0\.4 --activate/);
    assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
    assert.match(workflow, /git merge-base --is-ancestor "\$tag_commit" origin\/main/);
    assert.match(workflow, /steps\.plan\.outputs\.verify/);
    assert.match(workflow, /npm install -g npm@11\.15\.0 --ignore-scripts/);
    assert.match(workflow, /npm stage publish \. --access public --ignore-scripts/);
    assert.doesNotMatch(workflow, /npm publish(?:\s|$)/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
    assert.deepEqual(actionPins.map(match => match[1]).sort(), ['actions/checkout', 'actions/setup-node']);
  });
});
