import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkCiPack } from '../scripts/check-ci-pack.mjs';
import { planCoreCi } from '../scripts/ci-core-plan.mjs';

test('AIE-only changes select AIE consumers without unrelated adapter tests', () => {
  const plan = planCoreCi(['products/aie/src/app/pr_gate.ts']);
  assert.equal(plan.core, true);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.changedPackages, ['@tjalve/aie']);
  assert.deepEqual(plan.testTargets, ['@tjalve/aie', '@tjalve/aib', '@tjalve/qube']);
  assert.ok(plan.buildTargets.includes('@tjalve/qube-adapter-github'));
  assert.ok(!plan.testTargets.includes('@tjalve/qube-adapter-github'));
  assert.deepEqual(plan.packTargets, [
    { name: '@tjalve/aie', script: 'pack:check' },
    { name: '@tjalve/aib', script: 'pack:check' },
    { name: '@tjalve/qube', script: 'pack:check' },
  ]);
});

test('adapter-only changes select the adapter and shipped consumers', () => {
  const plan = planCoreCi(['adapters/github/src/github_review_forge.ts']);
  assert.equal(plan.full, false);
  assert.deepEqual(plan.changedPackages, ['@tjalve/qube-adapter-github']);
  assert.ok(plan.testTargets.includes('@tjalve/qube-adapter-github'));
  assert.ok(plan.testTargets.includes('@tjalve/aie'));
  assert.ok(plan.testTargets.includes('@tjalve/qube'));
  assert.ok(!plan.testTargets.includes('@tjalve/qube-adapter-gitlab'));
});

test('QUBE changes build the public Quality Control dependency before the composer', () => {
  const plan = planCoreCi(['products/qube/src/runtime.ts']);
  assert.equal(plan.aiq, false);
  assert.deepEqual(plan.changedPackages, ['@tjalve/qube']);
  assert.ok(plan.buildTargets.indexOf('@tjalve/aiq') >= 0);
  assert.ok(plan.buildTargets.indexOf('@tjalve/aiq') < plan.buildTargets.indexOf('@tjalve/qube'));
  assert.ok(!plan.typecheckTargets.includes('@tjalve/aiq'));
  assert.ok(!plan.testTargets.includes('@tjalve/aiq'));
  assert.ok(!plan.packTargets.some(target => target.name === '@tjalve/aiq'));
});

test('release and workflow paths select the complete core plan', () => {
  for (const changedPath of ['products/aie/package.json', 'products/aiq/package.json', 'scripts/publish-packages.mjs', '.github/workflows/ci.yml', 'pnpm-lock.yaml']) {
    const plan = planCoreCi([changedPath]);
    assert.equal(plan.full, true, changedPath);
    assert.equal(plan.rootTests, true, changedPath);
    assert.ok(plan.testTargets.includes('@tjalve/qube-adapter-cursor'), changedPath);
    assert.ok(plan.testTargets.includes('@tjalve/qube-adapter-grok-build'), changedPath);
    assert.ok(plan.testTargets.includes('@tjalve/qube-adapter-jenkins'), changedPath);
    assert.ok(!plan.testTargets.includes('@tjalve/aiu'), changedPath);
    assert.ok(plan.packTargets.some(target => target.name === '@tjalve/aiu' && target.script === 'release:check'), changedPath);
    if (changedPath === 'products/aiq/package.json') assert.equal(plan.aiq, true, changedPath);
  }
});

test('unmapped paths fail closed while known documentation and AIQ paths stay routed', () => {
  const unmapped = planCoreCi(['config/new-policy.json']);
  assert.equal(unmapped.full, true);
  assert.match(unmapped.reason, /^unmapped-path:/);

  const documentation = planCoreCi(['docs/review.md']);
  assert.equal(documentation.core, false);
  assert.equal(documentation.aiq, false);

  const aiq = planCoreCi(['products/aiq/packages/cli/src/index.ts']);
  assert.equal(aiq.core, false);
  assert.equal(aiq.aiq, true);
});

test('malformed or missing changed paths fail before producing a plan', () => {
  assert.throws(() => planCoreCi([]), /At least one changed path/);
  assert.throws(() => planCoreCi(['../outside']), /stay relative/);
  assert.throws(() => planCoreCi(['C:\\outside']), /stay relative/);
});

test('production workflow preserves supply-chain controls and separates test and pack progress', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(workflow, /pnpm run version:audit/);
  assert.match(workflow, /pnpm run verify:manifests/);
  assert.match(workflow, /name: Test selected core packages/);
  assert.match(workflow, /name: Pack-check selected core packages/);
  assert.match(workflow, /name: Verify required CI outcomes/);
  assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@(?![a-f0-9]{40}\b)/);
});

test('CI product scripts reuse the dedicated build stage without weakening standalone scripts', () => {
  for (const packagePath of ['products/aie/package.json', 'products/aib/package.json', 'products/qube/package.json']) {
    const manifest = JSON.parse(readFileSync(new URL(`../${packagePath}`, import.meta.url), 'utf8'));
    assert.match(manifest.scripts.test, /build/, packagePath);
    assert.doesNotMatch(manifest.scripts['ci:test'], /build/, packagePath);
    assert.equal(manifest.scripts['ci:pack'], 'node ../../scripts/check-ci-pack.mjs', packagePath);
  }
  const rootManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(
    rootManifest.scripts.build.indexOf('pnpm --filter @tjalve/aiq-workspace run build')
      < rootManifest.scripts.build.indexOf('pnpm --filter @tjalve/qube run build'),
    'The clean root build must assemble Quality Control before compiling QUBE',
  );
  const packHelper = readFileSync(new URL('../scripts/check-ci-pack.mjs', import.meta.url), 'utf8');
  assert.match(packHelper, /check-publish-manifest\.mjs/);
  assert.match(packHelper, /--config\.ignore-scripts=true/);
  assert.match(packHelper, /restore-publish-dependencies\.mjs/);
  assert.match(packHelper, /if \(primaryFailure\) throw primaryFailure/);
});

test('CI pack failure still restores the publish manifest', () => {
  const calls = [];
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'products', 'aib');
  const commands = {
    runCommand(command, args) {
      calls.push([command, ...args]);
    },
    runPnpm(args) {
      calls.push(['pnpm', ...args]);
      if (args.includes('pack')) throw new Error('simulated pack failure');
    },
  };

  assert.throws(() => checkCiPack(packageRoot, commands), /simulated pack failure/);
  assert.match(calls.at(-1).join(' '), /restore-publish-dependencies\.mjs/);
});
