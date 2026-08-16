const assert = require('node:assert/strict');
const { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
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
    assert.deepEqual(pkg.files, ['bin/', 'dist/', 'assets/', 'docs/migration.md', 'docs/review-modes.md', 'prompts/', 'README.md']);
    assert.equal(pkg.bin.aie, 'bin/run');
    assert.equal(pkg.main, './dist/index.js');
    assert.equal(pkg.types, './dist/index.d.ts');
    assert.match(pkg.scripts['pack:check'], /^pnpm run build:deps && pnpm run build && pnpm pack --dry-run(?:\s|$)/);
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

  it('resolves the routed review runtime from a staged package surface outside the checkout', async () => {
    const packageRoot = join(__dirname, '..');
    const stagedRoot = mkdtempSync(join(tmpdir(), 'aie-packed-route-'));
    assert.ok(pkg.files.includes('dist/'));
    cpSync(join(packageRoot, 'dist'), join(stagedRoot, 'dist'), { recursive: true });
    copyFileSync(join(packageRoot, 'package.json'), join(stagedRoot, 'package.json'));
    const stagedCore = join(stagedRoot, 'node_modules', '@tjalve', 'qube-core');
    mkdirSync(join(stagedRoot, 'node_modules', '@tjalve'), { recursive: true });
    cpSync(join(packageRoot, '..', '..', 'packages', 'qube-core'), stagedCore, { recursive: true });

    const routedRuntime = await import(pathToFileURL(join(stagedRoot, 'dist', 'app', 'model_review_runner.js')).href);
    assert.equal(typeof routedRuntime.runModelReview, 'function');
    assert.equal(typeof routedRuntime.buildModelRouteInvocation, 'function');
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
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@tjalve/qube-cli', '@tjalve/qube-core']);
    assert.equal(pkg.optionalDependencies, undefined);
    const devNames = Object.keys(pkg.devDependencies).sort();
    const adapterDevs = devNames.filter(name => name.startsWith('@tjalve/qube-adapter-'));
    const toolDevs = devNames.filter(name => !name.startsWith('@tjalve/qube-adapter-'));
    assert.deepEqual(toolDevs, ['@types/node', 'typescript']);
    assert.ok(adapterDevs.length > 0);
    assert.equal(pkg.oclif, undefined);

    for (const [name, version] of Object.entries(pkg.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
    }
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      if (name.startsWith('@tjalve/qube-adapter-')) {
        assert.equal(version, 'workspace:*', `${name} stays a workspace-only test dependency`);
        continue;
      }
      assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must use an exact version`);
    }
  });

  it('resolves workspace protocol dependencies before publish', () => {
    assert.match(pkg.scripts.prepack, /resolve-publish-dependencies\.mjs/);
    assert.match(pkg.scripts.prepack, /check-publish-manifest\.mjs/);
    assert.match(pkg.scripts.postpack, /restore-publish-dependencies\.mjs/);
  });

  it('keeps trusted publishing staged, tokenless, and pinned', () => {
    const workflowPath = join(__dirname, '..', '..', '..', '.github', 'workflows', 'publish.yml');
    assert.equal(existsSync(workflowPath), true);

    const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
    const stageScript = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'run-publish-plan.mjs'), 'utf8');
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
    assert.match(workflow, /id: plan/);
    assert.match(workflow, /console\.log\('verify=' \+ p\.verify\)/);
    assert.match(workflow, /run-publish-plan\.mjs verify publish-plan\.json/);
    assert.match(workflow, /npm install -g npm@11\.15\.0 --ignore-scripts/);
    assert.match(stageScript, /\["stage", "publish", "\.", "--access", "public", "--ignore-scripts"\]/);
    assert.match(workflow, /verify-installed-commands\.mjs --plan publish-plan\.json --json/);
    assert.match(workflow, /run-publish-plan\.mjs stage publish-plan\.json/);
    assert.doesNotMatch(workflow, /npm publish(?:\s|$)/);
    assert.doesNotMatch(stageScript, /npm publish(?:\s|$)/);
    assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
    assert.deepEqual(actionPins.map(match => match[1]).sort(), ['actions/checkout', 'actions/setup-node']);
  });
});
