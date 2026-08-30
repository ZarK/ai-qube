const assert = require('node:assert/strict');
const { mkdtempSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');
const {
  assertCurrentCompositionIdentity,
  bindCompositionIdentity,
  composeProviderPermutation,
  compositionConfigDigest,
  compositionFixtureDigest,
  compositionUsesSelectedKinds,
  resolveCompositionFixturePath,
} = require('../dist/providers/compose.js');
const { createCiProvider, createMissingCiProvider } = require('../dist/providers/ci_provider_adapters.js');

const WORK_KINDS = ['github', 'gitlab', 'linear', 'jira'];
const REVIEW_KINDS = ['github', 'gitlab'];
const CI_KINDS = ['github', 'gitlab', 'jenkins'];

const ARCHETYPES = [
  { name: 'github-all-in-one', work: 'github', review: 'github', ci: 'github' },
  { name: 'gitlab-all-in-one', work: 'gitlab', review: 'gitlab', ci: 'gitlab' },
  { name: 'enterprise-split', work: 'jira', review: 'gitlab', ci: 'jenkins' },
  { name: 'saas-split', work: 'linear', review: 'github', ci: 'github' },
];

const GITHUB_CHECKS = {
  passed: { name: 'core', status: 'COMPLETED', conclusion: 'SUCCESS', workflowName: 'CI' },
  failed: { name: 'core', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI' },
  pending: { name: 'core', status: 'IN_PROGRESS', conclusion: null, workflowName: 'CI' },
};

const GITLAB_CHECKS = {
  passed: { id: 502, status: 'success', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', web_url: 'https://gitlab.example.com/acme/qube/-/pipelines/502' },
  failed: { id: 503, status: 'failed', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', web_url: 'https://gitlab.example.com/acme/qube/-/pipelines/503' },
  pending: { id: 504, status: 'running', sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', web_url: 'https://gitlab.example.com/acme/qube/-/pipelines/504' },
};

const JENKINS_CHECKS = {
  passed: {
    jobPath: 'folder/app',
    build: 42,
    buildRecord: {
      id: '42',
      number: 42,
      result: 'SUCCESS',
      building: false,
      url: 'https://jenkins.example.com/job/folder/job/app/42/',
      artifacts: [{ fileName: 'report.xml', relativePath: 'reports/report.xml' }],
    },
  },
  failed: {
    jobPath: 'folder/app',
    build: 43,
    buildRecord: {
      id: '43',
      number: 43,
      result: 'FAILURE',
      building: false,
      url: 'https://jenkins.example.com/job/folder/job/app/43/',
    },
  },
  pending: {
    jobPath: 'folder/app',
    build: 44,
    buildRecord: {
      id: '44',
      number: 44,
      result: null,
      building: true,
      url: 'https://jenkins.example.com/job/folder/job/app/44/',
    },
  },
};

function permutationConfig(work, review, ci) {
  const input = configToFileShape(getDefaults());
  input.providers.work = { kind: work };
  input.providers.review = { kind: review };
  input.providers.ci = { kind: ci };
  const result = validateConfig(input);
  assert.equal(result.ok, true, `${work}/${review}/${ci} must validate`);
  return result.config;
}

function fixtureCheck(ci) {
  if (ci === 'gitlab') return GITLAB_CHECKS;
  if (ci === 'jenkins') return JENKINS_CHECKS;
  return GITHUB_CHECKS;
}

describe('provider permutation composition', () => {
  it('composes every supported permutation without inheriting GitHub kinds', async () => {
    for (const work of WORK_KINDS) {
      for (const review of REVIEW_KINDS) {
        for (const ci of CI_KINDS) {
          const config = permutationConfig(work, review, ci);
          const checks = fixtureCheck(ci);
          const composition = await composeProviderPermutation(config, {
            headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            ciCheck: checks.passed,
          });
          assert.equal(compositionUsesSelectedKinds(composition, config), true);
          assert.equal(composition.work.id, work);
          assert.equal(composition.review.id, review);
          assert.equal(composition.ci.id, ci);
          assert.ok(composition.ciCheck);
          assert.equal(composition.ciCheck.result, 'passed');
          assert.ok(composition.missing.every(item => item.support === 'unsupported' || item.support === 'unknown'));
          assert.ok(composition.missing.every(item => item.support !== 'supported'));
        }
      }
    }
  });

  it('observes archetype rows on the production compose path', async () => {
    for (const row of ARCHETYPES) {
      const config = permutationConfig(row.work, row.review, row.ci);
      const composition = await composeProviderPermutation(config, {
        headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ciCheck: fixtureCheck(row.ci).failed,
      });
      assert.equal(composition.work.id, row.work);
      assert.equal(composition.review.id, row.review);
      assert.equal(composition.ci.id, row.ci);
      assert.equal(composition.ciCheck.result, 'failed');
      assert.ok(composition.ciCheck.reasonCode);
      assert.ok(composition.ciCheck.summary);
    }
  });

  it('keeps Linear work mutations and Jenkins trigger unsupported', async () => {
    const config = permutationConfig('linear', 'github', 'jenkins');
    const composition = await composeProviderPermutation(config, {
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ciCheck: JENKINS_CHECKS.pending,
    });
    const workMutations = composition.observations.filter(item => item.role === 'work' && ['planLifecycleMutations', 'applyLifecycleMutations', 'commentMutations'].includes(item.id));
    assert.ok(workMutations.length > 0);
    assert.ok(workMutations.every(item => item.support === 'unsupported'));
    const trigger = composition.observations.find(item => item.role === 'ci' && item.id === 'triggerRun');
    assert.equal(trigger.support, 'unsupported');
    assert.equal(composition.ciCheck.result, 'pending');
    assert.notEqual(composition.work.id, 'github');
    assert.notEqual(composition.ci.id, 'github');
  });

  it('reports missing adapter capabilities as unknown instead of GitHub success', async () => {
    const missing = createMissingCiProvider('jenkins', '@tjalve/qube-adapter-jenkins', ['Install Jenkins']);
    assert.equal(missing.capabilities().readStatus, false);
    assert.equal(missing.capabilities().triggerRun, false);
    assert.throws(() => missing.mapCheck(JENKINS_CHECKS.passed), /qube init --ci-provider jenkins/);
    await assert.rejects(() => missing.triggerRun(), /qube init --ci-provider jenkins/);

    const config = permutationConfig('jira', 'gitlab', 'jenkins');
    const composition = await composeProviderPermutation(config, {
      createCi: async () => {
        throw new Error('ERR_MODULE_NOT_FOUND @tjalve/qube-adapter-jenkins');
      },
    });
    assert.equal(composition.ci.id, 'jenkins');
    assert.ok(composition.observations.filter(item => item.role === 'ci').every(item => item.support === 'unknown'));
    assert.ok(composition.missing.some(item => item.role === 'ci' && item.id === 'readStatus' && item.support === 'unknown'));
  });

  it('rejects CI trigger as unsupported on the production provider path', async () => {
    const provider = await createCiProvider('jenkins');
    assert.equal(provider.capabilities().triggerRun, false);
    await assert.rejects(() => provider.triggerRun(), /unsupported/);
    const github = await createCiProvider('github');
    await assert.rejects(() => github.triggerRun(), /unsupported/);
    const gitlab = await createCiProvider('gitlab');
    await assert.rejects(() => gitlab.triggerRun(), /unsupported/);
  });

  it('rejects absolute, parent-directory, and symlink fixture escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-permutation-'));
    writeFileSync(join(root, 'ok.json'), '{"ok":true}\n');
    assert.match(resolveCompositionFixturePath(root, 'ok.json'), /ok\.json$/);
    assert.throws(() => compositionFixtureDigest(root, 'missing.json'), /missing or not a regular file/);
    assert.throws(() => resolveCompositionFixturePath(root, join(root, 'ok.json')), /must be relative/);
    assert.throws(() => resolveCompositionFixturePath(root, '../secret.json'), /parent-directory/);
    try {
      const outside = mkdtempSync(join(tmpdir(), 'aie-permutation-outside-'));
      writeFileSync(join(outside, 'secret.json'), '{"secret":true}\n');
      symlinkSync(join(outside, 'secret.json'), join(root, 'escape.json'));
      assert.throws(() => resolveCompositionFixturePath(root, 'escape.json'), /symlink/);
      const linkedDir = join(root, 'linked');
      symlinkSync(outside, linkedDir);
      assert.throws(() => resolveCompositionFixturePath(root, join('linked', 'secret.json')), /symlink/);
    } catch (error) {
      if (error.code === 'EPERM' || error.code === 'ENOTSUP') return;
      throw error;
    }
  });

  it('rejects reused composition evidence when fixture contents change at the same path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-permutation-digest-'));
    writeFileSync(join(root, 'checks.json'), JSON.stringify(JENKINS_CHECKS.passed));
    const config = permutationConfig('linear', 'github', 'jenkins');
    const first = await composeProviderPermutation(config, {
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      fixtureRoot: root,
      fixturePath: 'checks.json',
    });
    writeFileSync(join(root, 'checks.json'), JSON.stringify(JENKINS_CHECKS.failed));
    await assert.rejects(
      () => composeProviderPermutation(config, {
        headSha: first.identity.headSha,
        fixtureRoot: root,
        fixturePath: 'checks.json',
        previousIdentity: first.identity,
      }),
      /fixture digest/,
    );
  });

  it('rejects reused composition evidence for a different head or config digest', async () => {
    const config = permutationConfig('linear', 'github', 'jenkins');
    const first = await composeProviderPermutation(config, { headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    await assert.rejects(
      () => composeProviderPermutation(config, {
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        previousIdentity: first.identity,
      }),
      /stale/,
    );
    const other = permutationConfig('github', 'github', 'github');
    await assert.rejects(
      () => composeProviderPermutation(other, {
        headSha: first.identity.headSha,
        previousIdentity: first.identity,
      }),
      /config digest/,
    );
    const same = bindCompositionIdentity({
      headSha: first.identity.headSha,
      configDigest: compositionConfigDigest(config),
      fixtureDigest: first.identity.fixtureDigest,
    });
    assertCurrentCompositionIdentity(first.identity, same);
  });
});
