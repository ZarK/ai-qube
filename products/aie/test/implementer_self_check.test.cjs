const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildImplementerSelfCheck, formatImplementerSelfCheck, SELF_CHECK_INSTRUCTION } = require('../dist/app/implementer_self_check.js');
const { getDefaults } = require('../dist/config/index.js');
const { loadRiskCardCatalog } = require('../dist/risk_cards/index.js');

function lanePolicy(id, required, match) {
  return { id, required, match, severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' };
}

function configWith(lanes) {
  const config = structuredClone(getDefaults());
  config.reviewProfile = 'local-focused';
  config.reviewLanes = lanes;
  return config;
}

function missingLearnings() {
  return {
    status: 'missing',
    summary: 'No Executor learnings file was found; no repo-configured implementer guidance is available.',
    trust: 'repo-doc',
    source: 'repo-configured',
    fragmentId: 'repo-configured/review-learnings',
    sha256: null,
    entries: [],
    omitted: 0,
  };
}

describe('implementer self-check', () => {
  it('renders a single-lane plan snapshot', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: ['docs/notes.md'],
    });
    assert.deepEqual(selfCheck, {
      instruction: SELF_CHECK_INSTRUCTION,
      requirements: [],
      lanes: [{
        lane: 'code-quality',
        digest: 'Correct, maintainable code with no dead, duplicated, or speculative logic.',
        activated: true,
        reason: 'required for every head',
      }],
      riskCards: [],
      repoLearnings: missingLearnings(),
    });
    assert.deepEqual(formatImplementerSelfCheck(selfCheck), [
      'Implementer self-check (before spawning reviewers):',
      `  ${SELF_CHECK_INSTRUCTION}`,
      '  Planned lanes:',
      '  - code-quality (activated; required for every head): Correct, maintainable code with no dead, duplicated, or speculative logic.',
      '  Changed-path risk cards: none activated.',
      '  Repo-configured learnings (repo-doc; not built-in policy): none matching.',
    ]);
  });

  it('renders a max-lane plan snapshot with a displaced matched lane', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([
        lanePolicy('code-quality', 'always', ['**/*']),
        lanePolicy('security', 'when-matched', ['**/*']),
        lanePolicy('performance', 'when-matched', ['**/*']),
        lanePolicy('tests-quality', 'when-matched', ['**/*']),
        lanePolicy('error-observability', 'when-matched', ['**/*']),
        lanePolicy('concurrency-resource', 'when-matched', ['**/*']),
        lanePolicy('data-database', 'when-matched', ['**/*']),
      ]),
      changedPaths: ['docs/notes.md'],
    });
    assert.deepEqual(selfCheck, {
      instruction: SELF_CHECK_INSTRUCTION,
      requirements: [],
      lanes: [
        { lane: 'code-quality', digest: 'Correct, maintainable code with no dead, duplicated, or speculative logic.', activated: true, reason: 'required for every head' },
        { lane: 'security', digest: 'Untrusted input handling, path traversal, injection, and trust-boundary violations.', activated: true, reason: 'changed paths matched its patterns' },
        { lane: 'performance', digest: 'Unbounded work, needless recomputation, and scaling hazards.', activated: true, reason: 'changed paths matched its patterns' },
        { lane: 'tests-quality', digest: 'Tests validate the production contract, not the implementation mirror.', activated: true, reason: 'changed paths matched its patterns' },
        { lane: 'error-observability', digest: 'Loud failures with actionable messages and no swallowed errors.', activated: true, reason: 'changed paths matched its patterns' },
        { lane: 'concurrency-resource', digest: 'Races, deadlocks, leaked resources, and cross-process interference.', activated: true, reason: 'changed paths matched its patterns' },
        { lane: 'data-database', digest: 'Schema, migration, and data-integrity correctness.', activated: false, reason: 'did not activate: matched changed paths but was displaced by the active-focus cap' },
      ],
      riskCards: [],
      repoLearnings: missingLearnings(),
    });
    assert.deepEqual(formatImplementerSelfCheck(selfCheck), [
      'Implementer self-check (before spawning reviewers):',
      `  ${SELF_CHECK_INSTRUCTION}`,
      '  Planned lanes:',
      '  - code-quality (activated; required for every head): Correct, maintainable code with no dead, duplicated, or speculative logic.',
      '  - security (activated; changed paths matched its patterns): Untrusted input handling, path traversal, injection, and trust-boundary violations.',
      '  - performance (activated; changed paths matched its patterns): Unbounded work, needless recomputation, and scaling hazards.',
      '  - tests-quality (activated; changed paths matched its patterns): Tests validate the production contract, not the implementation mirror.',
      '  - error-observability (activated; changed paths matched its patterns): Loud failures with actionable messages and no swallowed errors.',
      '  - concurrency-resource (activated; changed paths matched its patterns): Races, deadlocks, leaked resources, and cross-process interference.',
      '  - data-database (inactive; did not activate: matched changed paths but was displaced by the active-focus cap): Schema, migration, and data-integrity correctness.',
      '  Changed-path risk cards: none activated.',
      '  Repo-configured learnings (repo-doc; not built-in policy): none matching.',
    ]);
  });

  it('renders a snapshot for a when-matched lane that did not activate', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([
        lanePolicy('code-quality', 'always', ['**/*']),
        lanePolicy('ui-ux-accessibility', 'when-matched', ['**/*.css']),
      ]),
      changedPaths: ['products/aie/src/app/pr_gate.ts'],
    });
    assert.deepEqual(selfCheck.lanes, [
      { lane: 'code-quality', digest: 'Correct, maintainable code with no dead, duplicated, or speculative logic.', activated: true, reason: 'required for every head' },
      { lane: 'ui-ux-accessibility', digest: 'Visual correctness, usability, and accessibility of user-facing UI.', activated: false, reason: 'did not activate: no changed paths matched its patterns' },
    ]);
    assert.deepEqual(formatImplementerSelfCheck(selfCheck).slice(0, 5), [
      'Implementer self-check (before spawning reviewers):',
      `  ${SELF_CHECK_INSTRUCTION}`,
      '  Planned lanes:',
      '  - code-quality (activated; required for every head): Correct, maintainable code with no dead, duplicated, or speculative logic.',
      '  - ui-ux-accessibility (inactive; did not activate: no changed paths matched its patterns): Visual correctness, usability, and accessibility of user-facing UI.',
    ]);
  });

  it('activates cards from actual diff paths outside issue-predicted surfaces', () => {
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: ['products/aie/src/app/session_lock_store.ts'],
    });
    const card = selfCheck.riskCards.find(entry => entry.id === 'multi-process-concurrency');
    assert.ok(card, 'expected the concurrency card from the lock/session path');
    const catalogCard = loadRiskCardCatalog().find(entry => entry.id === 'multi-process-concurrency');
    assert.equal(card.implementerFace, catalogCard.implementerFace.trim());
    const rendered = formatImplementerSelfCheck(selfCheck).join('\n');
    assert.ok(!rendered.includes(catalogCard.reviewerFace.trim().slice(0, 40)), 'reviewer face leaked');
  });

  it('selects cards from paths alone so keyword-bearing text has no input surface', () => {
    // The builder accepts no issue or PR text: a path list whose files match no card
    // globs yields zero cards regardless of what any surrounding text mentions.
    const selfCheck = buildImplementerSelfCheck({
      config: configWith([lanePolicy('code-quality', 'always', ['**/*'])]),
      changedPaths: ['docs/notes.md'],
    });
    assert.deepEqual(selfCheck.riskCards, []);
    const catalog = loadRiskCardCatalog();
    for (const card of catalog) {
      assert.ok(card.issueKeywords.length > 0, `card ${card.id} has keywords that must not activate the self-check`);
    }
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
    };
    const first = buildImplementerSelfCheck(input);
    const second = buildImplementerSelfCheck(input);
    assert.deepEqual(first, second);
    assert.equal(formatImplementerSelfCheck(first).join('\n'), formatImplementerSelfCheck(second).join('\n'));
  });
});

const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildRequirementSelfCheck } = require('../dist/app/implementer_self_check.js');

function checklistSummary(items) {
  return {
    issue: { number: 93, title: 'Issue 93', state: 'OPEN', url: 'https://github.com/example/repo/issues/93' },
    checklist: { total: items.length, checked: items.filter(item => item.checked).length, unchecked: items.filter(item => !item.checked).length, items },
  };
}

function prBodyWith(criterionText, provenBy) {
  return [
    '## Criterion-to-proof map',
    '',
    `### Criterion 1: ${criterionText}`,
    '- Implemented at: `src/app/widget.ts`',
    `- Proven by: ${provenBy}`,
    '- Negative case: covered.',
  ].join('\n');
}

describe('requirement self-check', () => {
  const criterion = 'Stale provider metadata is rejected with an actionable reason.';

  function makeProofRepo({ testContent = 'assert stale metadata rejected with actionable reason', testName = 'test/widget.test.cjs' } = {}) {
    const repo = mkdtempSync(join(tmpdir(), 'aie-selfcheck-'));
    mkdirSync(join(repo, 'src', 'app'), { recursive: true });
    writeFileSync(join(repo, 'src', 'app', 'widget.ts'), 'export const widget = 1;\n');
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, testName), `${testContent}\n`);
    return repo;
  }

  it('marks a requirement proven when cited files exist and the test matches behavior terms', () => {
    const repo = makeProofRepo();
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      prBody: prBodyWith(criterion, '`test/widget.test.cjs`'),
      repoRoot: repo,
    });
    assert.equal(requirements.length, 1);
    assert.equal(requirements[0].proof.status, 'proven');
  });

  it('flags a nonexistent cited proof file as unproven', () => {
    const repo = makeProofRepo();
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      prBody: prBodyWith(criterion, '`test/missing.test.cjs`'),
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unproven');
    assert.match(requirements[0].proof.reason, /do not exist/);
  });

  it('flags a cited test without matching behavior terms as unproven', () => {
    const repo = makeProofRepo({ testContent: 'assert something entirely unrelated' });
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      prBody: prBodyWith(criterion, '`test/widget.test.cjs`'),
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unproven');
    assert.match(requirements[0].proof.reason, /key behavior terms/);
  });

  it('marks requirements without a criterion map entry as unmapped and sorts unproven first', () => {
    const repo = makeProofRepo();
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([
        { index: 1, text: criterion, checked: false },
        { index: 2, text: 'Another requirement with no map entry at all.', checked: false },
      ])],
      prBody: prBodyWith(criterion, '`test/widget.test.cjs`'),
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unmapped');
    assert.equal(requirements[1].proof.status, 'proven');
  });

  it('reports unmapped guidance when no pull request body exists', () => {
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      repoRoot: makeProofRepo(),
    });
    assert.equal(requirements[0].proof.status, 'unmapped');
    assert.match(requirements[0].proof.reason, /No pull request body/);
  });

  it('requires a cited test file, not only source citations', () => {
    const repo = makeProofRepo();
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      prBody: prBodyWith(criterion, '`src/app/widget.ts`'),
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unproven');
    assert.match(requirements[0].proof.reason, /cites no test file/);
  });
});

describe('requirement self-check hardening', () => {
  const criterion = 'Stale provider metadata is rejected with an actionable reason.';

  it('rejects absolute and parent-escaping cited paths as non-repository-relative', () => {
    const { mkdtempSync: tempDir } = require('node:fs');
    const repo = tempDir(join(tmpdir(), 'aie-selfcheck-'));
    const body = [
      `### Criterion 1: ${criterion}`,
      '- Proven by: `C:/somewhere/else.test.cjs` and `../outside/escape.test.cjs`',
    ].join('\n');
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: criterion, checked: false }])],
      prBody: body.replace('C:/somewhere/else.test.cjs', '/somewhere/else.test.cjs'),
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unproven');
    assert.match(requirements[0].proof.reason, /not repository-relative/);
  });

  it('never proves a requirement without distinctive behavior terms', () => {
    const { mkdirSync: makeDir, writeFileSync: writeFile, mkdtempSync: tempDir } = require('node:fs');
    const repo = tempDir(join(tmpdir(), 'aie-selfcheck-'));
    makeDir(join(repo, 'test'), { recursive: true });
    writeFile(join(repo, 'test', 'probe.test.cjs'), 'anything at all\n');
    const shortCriterion = 'Do it all now.';
    const body = [
      `### Criterion 1: ${shortCriterion}`,
      '- Proven by: `test/probe.test.cjs`',
    ].join('\n');
    const requirements = buildRequirementSelfCheck({
      issueChecklists: [checklistSummary([{ index: 1, text: shortCriterion, checked: false }])],
      prBody: body,
      repoRoot: repo,
    });
    assert.equal(requirements[0].proof.status, 'unproven');
    assert.match(requirements[0].proof.reason, /no distinctive behavior terms/);
  });
});
