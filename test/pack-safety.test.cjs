const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
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
    assert.equal(pkg.bin.aie, './bin/run');
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
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@clack/prompts', '@oclif/core', '@tjalve/qube-cli']);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript']);

    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
    }
  });
});
