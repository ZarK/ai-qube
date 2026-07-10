const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, it } = require('node:test');

const {
  DEFAULT_MAX_RISK_CARDS,
  formatRiskCardReviewerFragment,
  loadRiskCardCatalog,
  pathsTouchPatterns,
  selectRiskCards,
  simpleGlobMatch,
  validateRiskCardCatalog,
} = require('../dist/risk_cards/index.js');
const { promptStack } = require('../dist/app/local_review_runner_support.js');

describe('aie risk cards', () => {
  it('validates the shipped catalog', () => {
    const validation = validateRiskCardCatalog();
    assert.equal(validation.ok, true, validation.errors.join('; '));
    assert.ok(validation.cardCount >= 10);
    assert.equal(loadRiskCardCatalog().length, validation.cardCount);
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

  it('selects deterministically and bounds to at most five cards', () => {
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
    assert.deepEqual(first.map(card => card.id), second.map(card => card.id));
    assert.ok(first.length > 0);
    assert.ok(first.length <= DEFAULT_MAX_RISK_CARDS);
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
});
