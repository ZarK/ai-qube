const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const pkg = require('../package.json');

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

  it('keeps dependencies minimal and exact', () => {
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@clack/prompts', '@oclif/core']);
    assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['@types/node', 'typescript']);

    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
    }
  });
});
