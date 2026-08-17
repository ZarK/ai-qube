const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, it } = require('node:test');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const aie = require('../dist/index.js');
const { getDefaults } = require('../dist/config/index.js');
const {
  DEFAULT_MAX_RISK_CARDS,
  REQUIRED_RISK_CARD_IDS,
  formatRiskCardReviewerFragment,
  implementerFaceHasTestObligation,
  loadRiskCardCatalog,
  pathsTouchPatterns,
  selectRiskCards,
  simpleGlobMatch,
  validateRiskCardCatalog,
} = require('../dist/risk_cards/index.js');
const { promptStack } = require('../dist/app/local_review_runner_support.js');
const { runLocalReviewRunner } = require('../dist/app/local_review_runner.js');

function localConfig() {
  const config = structuredClone(getDefaults());
  config.reviewAdapter = 'local';
  config.localReviewAgents = ['codex'];
  config.reviewProfile = 'local-focused';
  config.reviewLanes = [
    { id: 'code-quality', required: 'always', match: ['**/*'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
  ];
  return config;
}

describe('aie risk cards', () => {
  it('validates the shipped catalog against required ids and face standards', () => {
    const validation = validateRiskCardCatalog();
    assert.equal(validation.ok, true, validation.errors.join('; '));
    assert.ok(validation.cardCount >= 10);
    assert.equal(loadRiskCardCatalog().length, validation.cardCount);
    for (const id of REQUIRED_RISK_CARD_IDS) {
      assert.ok(loadRiskCardCatalog().some(card => card.id === id), `missing ${id}`);
    }
    for (const card of loadRiskCardCatalog()) {
      assert.ok(implementerFaceHasTestObligation(card.implementerFace), card.id);
    }
  });

  it('rejects implementer faces without a concrete test obligation', () => {
    assert.equal(implementerFaceHasTestObligation('Handle errors correctly and keep states clean.'), false);
    assert.equal(implementerFaceHasTestObligation('Tests are useful. Handle errors correctly.'), false);
    assert.equal(implementerFaceHasTestObligation('Tests are not required. Ship whatever seems convenient.'), false);
    assert.equal(implementerFaceHasTestObligation('Do not add a fixture. Ship whatever seems convenient.'), false);
    assert.equal(implementerFaceHasTestObligation('Require no tests. Handle errors correctly.'), false);
    assert.equal(implementerFaceHasTestObligation('Add optional tests if time permits. Handle errors correctly.'), false);
    assert.equal(implementerFaceHasTestObligation('Ship whatever seems convenient. Tests are useful.'), false);
    assert.equal(implementerFaceHasTestObligation('Create code first. Tests are not necessary.'), false);
    assert.equal(implementerFaceHasTestObligation('Write APIs that mirror tests.'), false);
    assert.equal(implementerFaceHasTestObligation('Create production code first while documenting existing tests.'), false);
    assert.equal(implementerFaceHasTestObligation('Write production code that tests can call.'), false);
    assert.equal(implementerFaceHasTestObligation('Create a parser used by tests.'), false);
    assert.equal(implementerFaceHasTestObligation('Add runtime logging so test failures are visible.'), false);
    assert.equal(implementerFaceHasTestObligation('Existing negative tests already cover this path.'), false);
    assert.equal(implementerFaceHasTestObligation('Never write a test against private helpers.'), false);
    assert.equal(implementerFaceHasTestObligation('Write a negative test for each false-success path.'), true);
    assert.equal(implementerFaceHasTestObligation('Add a fixture that rejects each unsupported provider combination.'), true);
    assert.equal(implementerFaceHasTestObligation('Cover a pack or asset-resolution test that fails if a new asset is omitted.'), true);
  });

  it('matches issue keywords on token boundaries', () => {
    const falsePositive = selectRiskCards({
      issueText: 'contestant latest errorship providerless pretest',
      paths: ['docs/notes/unrelated.md'],
    });
    assert.deepEqual(falsePositive.map(card => card.id), []);
    const truePositive = selectRiskCards({
      issueText: 'provider matrix and test oracle coverage',
      paths: ['docs/notes/unrelated.md'],
    });
    assert.ok(truePositive.some(card => card.id === 'mode-provider-matrix' || card.id === 'oracle-quality'));
  });

  it('exports the catalog and selector from the package entry point', () => {
    assert.equal(typeof aie.selectRiskCards, 'function');
    assert.equal(typeof aie.loadRiskCardCatalog, 'function');
    assert.equal(typeof aie.validateRiskCardCatalog, 'function');
    assert.ok(Array.isArray(aie.REQUIRED_RISK_CARD_IDS));
    assert.equal(aie.selectRiskCards, selectRiskCards);
  });

  it('matches path globs with the shared simple glob dialect', () => {
    assert.equal(simpleGlobMatch('packages/foo/src/a.ts', '**/src/**'), true);
    assert.equal(simpleGlobMatch('docs/readme.md', '**/src/**'), false);
    assert.equal(pathsTouchPatterns(['adapters/github/src/x.ts'], ['**/adapters/**']), true);
  });

  it('returns zero cards when issue text and paths do not match', () => {
    const selected = selectRiskCards({
      issueText: 'purely unrelated prose about gardening',
      paths: ['docs/notes/unrelated.md'],
    });
    assert.deepEqual(selected, []);
  });

  it('selects exact ordered card ids by rank for a representative fixture', () => {
    const input = {
      issueText: 'provider capability trust marker stale pagination fixture test oracle false success',
      paths: [
        'packages/qube-testkit/src/work-suite.ts',
        'adapters/github/src/github_issue_api.ts',
        'products/aie/src/app/local_review_runner.ts',
        'packages/qube-testkit/test/testkit.test.mjs',
      ],
    };
    const first = selectRiskCards(input);
    const second = selectRiskCards(input);
    assert.deepEqual(first.map(card => card.id), [
      'truthful-state-transitions',
      'oracle-quality',
      'trust-identity-boundaries',
      'filesystem-boundaries',
      'mode-provider-matrix',
    ]);
    assert.deepEqual(first.map(card => card.id), second.map(card => card.id));
    assert.equal(first.length, DEFAULT_MAX_RISK_CARDS);
    assert.ok(first.every((card, index) => index === 0 || first[index - 1].rank <= card.rank));
  });

  it('bounds selection to exactly five cards chosen by rank when more than five match', () => {
    const selected = selectRiskCards({
      issueText: [
        'status success failed skipped unknown error gate check',
        'provider adapter matrix unsupported capability permutation github gitlab jira',
        'trust marker identity auth token untrusted forged reviewer approval',
        'stale fresh head cache carry-forward evidence sha current-head',
        'pagination limit timeout cancel abort budget pageSize cursor',
        'lock concurrency parallel race session atomic mutex',
        'fixture path traversal symlink root absolute relative escape',
        'parse codec normalize encoding json malformed schema',
        'package dist shipped workspace publish files assets',
        'test negative fixture oracle conformance suite assert',
      ].join(' '),
      paths: [
        'packages/foo/src/a.ts',
        'adapters/x/src/y.ts',
        'products/aie/src/app/z.ts',
        'packages/x/test/t.mjs',
        'packages/x/package.json',
        'docs/notes.md',
      ],
    });
    assert.equal(selected.length, DEFAULT_MAX_RISK_CARDS);
    assert.deepEqual(selected.map(card => card.id), [
      'truthful-state-transitions',
      'oracle-quality',
      'trust-identity-boundaries',
      'filesystem-boundaries',
      'mode-provider-matrix',
    ]);
    assert.ok(selected.every((card, index) => index === 0 || selected[index - 1].rank <= card.rank));
  });

  it('includes activated reviewer faces in the prompt stack hash', () => {
    const cards = selectRiskCards({
      issueText: 'provider capability trust marker pagination fixture test',
      paths: ['products/aie/src/app/local_review_runner.ts'],
    });
    assert.ok(cards.length > 0);
    const fragments = cards.map(card => formatRiskCardReviewerFragment(card));
    const without = promptStack('code-quality', ['Run local review lane code-quality.'], []);
    const withCards = promptStack('code-quality', ['Run local review lane code-quality.'], fragments);
    const hashWithout = createHash('sha256').update(without.text).digest('hex');
    const hashWith = createHash('sha256').update(withCards.text).digest('hex');
    assert.notEqual(hashWithout, hashWith);
    assert.ok(withCards.text.includes(cards[0].id));
    assert.ok(withCards.orderedFragmentIds.some(id => id.startsWith('command-supplied:')));
  });

  it('activates risk cards through the real local-review runner planning path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-risk-cards-runner-'));
    const config = localConfig();
    const issueText = 'provider capability trust marker pagination fixture test';
    const paths = ['products/aie/src/app/local_review_runner.ts'];
    const expectedCards = selectRiskCards({ issueText, paths });
    assert.ok(expectedCards.length > 0);

    const withCards = await runLocalReviewRunner(config, {
      repoRoot: repo,
      issueNumbers: [282],
      prNumber: 291,
      headSha: 'head-with-cards',
      required: true,
      shadow: false,
      dryRun: true,
      includePrompts: true,
      changedPaths: paths,
      riskCardIssueText: issueText,
    });
    const zeroCards = await runLocalReviewRunner(config, {
      repoRoot: repo,
      issueNumbers: [282],
      prNumber: 291,
      headSha: 'head-zero-cards',
      required: true,
      shadow: false,
      dryRun: true,
      includePrompts: true,
      changedPaths: ['docs/notes/unrelated.md'],
      riskCardIssueText: 'purely unrelated prose about gardening',
    });

    assert.equal(withCards.lanes.length, 1);
    assert.equal(zeroCards.lanes.length, 1);
    const active = withCards.lanes[0];
    const inactive = zeroCards.lanes[0];
    assert.ok(active.promptText.includes(expectedCards[0].id));
    assert.ok(active.promptFragmentIds.some(id => id.startsWith('command-supplied:')));
    assert.ok(active.promptStackHash);
    assert.notEqual(active.promptStackHash, inactive.promptStackHash);
    assert.equal(inactive.promptText.includes('Risk card '), false);
    assert.equal(inactive.promptFragmentIds.some(id => id.startsWith('command-supplied:')), false);
    for (const card of expectedCards) {
      assert.ok(active.promptText.includes(card.id), `missing activated card ${card.id}`);
    }
  });

  it('keeps local-command terminal hash aligned with card-aware planned hash', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-risk-cards-cmd-'));
    const config = localConfig();
    config.localReviewAgents = ['local-command'];
    config.reviewLanes = [
      {
        id: 'code-quality',
        required: 'always',
        match: ['**/*'],
        severityThreshold: 'high',
        prompt: [],
        tools: [],
        runner: 'local-command',
        command: 'review-fixture',
        rereview: 'delta',
      },
    ];
    const issueText = 'provider capability trust marker pagination fixture test';
    const paths = ['products/aie/src/app/local_review_runner.ts'];
    const planned = await runLocalReviewRunner(config, {
      repoRoot: repo,
      issueNumbers: [282],
      prNumber: 291,
      headSha: 'cmd-hash-head',
      required: true,
      shadow: false,
      dryRun: true,
      includePrompts: true,
      changedPaths: paths,
      riskCardIssueText: issueText,
    });
    assert.equal(planned.lanes.length, 1);
    assert.ok(planned.lanes[0].promptFragmentIds.some(id => id.startsWith('command-supplied:')));
    assert.ok(planned.lanes[0].promptStackHash);
    assert.ok(planned.lanes[0].promptText.includes('Risk card '));
  });

  it('keeps multi-process-concurrency faces free of review-infra nouns', () => {
    const card = loadRiskCardCatalog().find(entry => entry.id === 'multi-process-concurrency');
    assert.ok(card);
    const faces = `${card.implementerFace}\n${card.reviewerFace}`.toLowerCase();
    for (const noun of ['current-head', 'evidence publish', 'review lock', 'label mutation']) {
      assert.equal(faces.includes(noun), false, `face leaked ${noun}`);
    }
    assert.equal(implementerFaceHasTestObligation(card.implementerFace), true);
  });

  it('does not activate multi-process-concurrency for a bounded-worker indexer issue', () => {
    const selected = selectRiskCards({
      issueText: [
        'Index sources with a bounded, resumable worker.',
        'Worker queue with a concurrency bound; each job is a recorded run.',
        'A restart resumes unfinished jobs; the boot sweep marks orphaned jobs interrupted.',
      ].join(' '),
      paths: ['packages/storage/migrations/0001_workspace.sql'],
    });
    assert.equal(selected.some(card => card.id === 'multi-process-concurrency'), false);
    assert.equal(selected.some(card => /current-head artifact/i.test(card.implementerFace)), false);
  });

  it('does not activate multi-process-concurrency from consumer lock or lockfile paths', () => {
    assert.equal(selectRiskCards({ paths: ['apps/gateway/src/workspace-lock.ts'] }).some(card => card.id === 'multi-process-concurrency'), false);
    assert.equal(selectRiskCards({ paths: ['pnpm-lock.yaml'] }).some(card => card.id === 'multi-process-concurrency'), false);
  });

  it('still activates multi-process-concurrency from a session-lock store path', () => {
    const selected = selectRiskCards({ paths: ['products/aie/src/app/session_lock_store.ts'] });
    assert.ok(selected.some(card => card.id === 'multi-process-concurrency'));
  });
});
