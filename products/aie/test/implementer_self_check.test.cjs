const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildImplementerSelfCheck, formatImplementerSelfCheck, SELF_CHECK_INSTRUCTION } = require('../dist/app/implementer_self_check.js');
const { getDefaults } = require('../dist/config/index.js');
const { loadRiskCardCatalog } = require('../dist/risk_cards/index.js');

const INERT_ISSUE_TEXT = 'contestant latest errorship pretest';

function lanePolicy(id, required, match) {
  return { id, required, match, severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' };
}

function configWith(lanes) {
  const config = structuredClone(getDefaults());
  config.reviewProfile = 'local-focused';
  config.reviewLanes = lanes;
  return config;
}

describe('implementer self-check', () => {
  it('renders a single-lane plan snapshot', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: ['docs/notes.md'],
      issueText: INERT_ISSUE_TEXT,
    });
    assert.deepEqual(selfCheck, {
      instruction: SELF_CHECK_INSTRUCTION,
      lanes: [{
        lane: 'code-quality',
        digest: 'Correct, maintainable code with no dead, duplicated, or speculative logic.',
        activated: true,
        reason: 'required for every head',
      }],
      riskCards: [],
    });
    assert.deepEqual(formatImplementerSelfCheck(selfCheck), [
      'Implementer self-check (before spawning reviewers):',
      `  ${SELF_CHECK_INSTRUCTION}`,
      '  Planned lanes:',
      '  - code-quality (activated; required for every head): Correct, maintainable code with no dead, duplicated, or speculative logic.',
      '  Changed-path risk cards: none activated.',
    ]);
  });

  it('reports a max-lane plan with a displaced matched lane', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([
        lanePolicy('code-quality', 'always', ['**/*']),
        lanePolicy('security', 'when-matched', ['**/*']),
        lanePolicy('performance', 'when-matched', ['**/*']),
        lanePolicy('tests-quality', 'when-matched', ['**/*']),
        lanePolicy('error-observability', 'when-matched', ['**/*']),
        lanePolicy('concurrency-resource', 'when-matched', ['**/*']),
      ]),
      changedPaths: ['docs/notes.md'],
      issueText: INERT_ISSUE_TEXT,
    });
    assert.equal(selfCheck.lanes.length, 6);
    assert.equal(selfCheck.lanes.filter(lane => lane.activated).length, 5);
    const displaced = selfCheck.lanes.find(lane => lane.lane === 'concurrency-resource');
    assert.equal(displaced.activated, false);
    assert.equal(displaced.reason, 'did not activate: matched changed paths but was displaced by the active-focus cap');
  });

  it('explains a when-matched lane that did not activate', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([
        lanePolicy('code-quality', 'always', ['**/*']),
        lanePolicy('ui-ux-accessibility', 'when-matched', ['**/*.css']),
      ]),
      changedPaths: ['products/aie/src/app/pr_gate.ts'],
      issueText: INERT_ISSUE_TEXT,
    });
    const inactive = selfCheck.lanes.find(lane => lane.lane === 'ui-ux-accessibility');
    assert.equal(inactive.activated, false);
    assert.equal(inactive.reason, 'did not activate: no changed paths matched its patterns');
    const active = selfCheck.lanes.find(lane => lane.lane === 'code-quality');
    assert.equal(active.activated, true);
  });

  it('activates cards from actual diff paths outside issue-predicted surfaces', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: ['products/aie/src/app/session_lock_store.ts'],
      issueText: INERT_ISSUE_TEXT,
    });
    const card = selfCheck.riskCards.find(entry => entry.id === 'multi-process-concurrency');
    assert.ok(card, 'expected the concurrency card from the lock/session path');
    const catalogCard = loadRiskCardCatalog().find(entry => entry.id === 'multi-process-concurrency');
    assert.equal(card.implementerFace, catalogCard.implementerFace.trim());
    const rendered = formatImplementerSelfCheck(selfCheck).join('\n');
    assert.ok(!rendered.includes(catalogCard.reviewerFace.trim().slice(0, 40)), 'reviewer face leaked');
  });

  it('caps changed-path cards at five by rank', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: [
        'a/status_result.ts',
        'b/provider_adapter.ts',
        'c/auth_token.ts',
        'd/cache_head.ts',
        'e/page_limit.ts',
        'f/lock_session.ts',
      ],
      issueText: INERT_ISSUE_TEXT,
    });
    assert.deepEqual(selfCheck.riskCards.map(card => card.id), [
      'truthful-state-transitions',
      'trust-identity-boundaries',
      'mode-provider-matrix',
      'freshness-cache-identity',
      'bounds-cancellation',
    ]);
  });

  it('falls back to profile lanes when no lanes are configured', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([]),
      changedPaths: ['docs/notes.md'],
      issueText: INERT_ISSUE_TEXT,
    });
    assert.ok(selfCheck.lanes.length > 0);
    for (const lane of selfCheck.lanes) {
      assert.equal(lane.activated, true);
      assert.equal(lane.reason, 'required by the review profile');
      assert.ok(lane.digest.length > 0);
    }
  });

  it('is deterministic across runs', () => {
    const input = {
      config: configWith([lanePolicy('code-quality', 'always', ['**/*']), lanePolicy('security', 'when-matched', ['**/*.ts'])]),
      changedPaths: ['products/aie/src/app/pr_gate.ts'],
      issueText: 'gate self-check',
    };
    const first = buildImplementerSelfCheck(input);
    const second = buildImplementerSelfCheck(input);
    assert.deepEqual(first, second);
    assert.equal(formatImplementerSelfCheck(first).join('\n'), formatImplementerSelfCheck(second).join('\n'));
  });
});
