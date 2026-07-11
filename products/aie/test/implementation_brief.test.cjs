const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { buildImplementationBrief, extractExpectedPaths, formatBriefLines } = require('../dist/brief/index.js');
const { getDefaults } = require('../dist/config/index.js');
const { loadRiskCardCatalog } = require('../dist/risk_cards/index.js');

function briefConfig() {
  const config = structuredClone(getDefaults());
  config.reviewProfile = 'local-focused';
  config.reviewLanes = [
    { id: 'issue-compliance', required: 'always', match: ['**/*'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
    { id: 'security', required: 'when-matched', match: ['**/*.ts'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta' },
  ];
  return config;
}

const MULTI_MODE_BODY = [
  '## Context',
  '',
  'Support the GitHub and GitLab providers with OAuth and API key auth modes across `products/aie/src/app/start_work.ts`.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Integration test covers each provider and auth-mode combination.',
  '- [ ] Malformed provider payloads fail loudly with an error message and a unit test asserts the rejection.',
].join('\n');

const SINGLE_MODE_BODY = [
  '## Context',
  '',
  'Improve the GitHub start flow.',
  '',
  '## Acceptance Criteria',
  '',
  '- [ ] Unit test asserts the start flow output for a ready issue.',
].join('\n');

function sectionOrder(lines) {
  const joined = lines.join('\n');
  return [
    joined.indexOf('Obligations:'),
    joined.indexOf('Behavior matrix'),
    joined.indexOf('Risk cards'),
    joined.indexOf('Expected review lanes'),
    joined.indexOf('Negative cases'),
    joined.indexOf('Open ambiguities'),
  ];
}

describe('implementation brief builder', () => {
  it('renders all six sections in order for a multi-mode issue', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    for (const key of ['obligations', 'matrix', 'riskCards', 'expectedLanes', 'negativeCases', 'ambiguities']) {
      assert.ok(key in brief, `missing ${key}`);
    }
    const order = sectionOrder(formatBriefLines(brief));
    for (let index = 0; index < order.length; index += 1) {
      assert.ok(order[index] >= 0, `section ${index} missing`);
      if (index > 0) assert.ok(order[index] > order[index - 1], `section ${index} out of order`);
    }
  });

  it('classifies verification kinds from stated criteria', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.equal(brief.obligations.length, 2);
    assert.equal(brief.obligations[0].kind, 'integration');
    assert.equal(brief.obligations[1].kind, 'unit');
  });

  it('enumerates matrix rows for selected dimensions only', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.ok(brief.matrix, 'expected a matrix');
    assert.deepEqual(brief.matrix.dimensions.map(dimension => dimension.name), ['provider', 'auth mode']);
    assert.deepEqual(brief.matrix.dimensions[0].values, ['github', 'gitlab']);
    assert.deepEqual(brief.matrix.dimensions[1].values, ['oauth', 'api key']);
    assert.equal(brief.matrix.rows.length, 4);
    assert.equal(brief.matrix.omittedRows, 0);
    const names = brief.matrix.dimensions.map(dimension => dimension.name);
    assert.ok(!names.includes('host'));
    assert.ok(!names.includes('platform'));
    assert.ok(!names.includes('lifecycle state'));
  });

  it('renders no matrix for a single-mode issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.equal(brief.matrix, null);
    assert.ok(formatBriefLines(brief).join('\n').includes('Behavior matrix: none'));
  });

  it('reports no ambiguities for a fully specified issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.deepEqual(brief.ambiguities, []);
    assert.ok(formatBriefLines(brief).join('\n').includes('Open ambiguities: none detected.'));
  });

  it('reports unspecified verification kinds and unspecified failure behavior as ambiguities', () => {
    const body = [
      '- [ ] The command exposes the new output.',
      '- [ ] Malformed payloads are rejected.',
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Ambiguous work', body, config: briefConfig() });
    assert.equal(brief.obligations[0].kind, 'unspecified');
    assert.ok(brief.ambiguities.some(entry => entry.includes('No stated verification kind') && entry.includes('exposes the new output')));
    assert.ok(brief.ambiguities.some(entry => entry.includes('Failure behavior is not specified') && entry.includes('Malformed payloads')));
  });

  it('flags dimensions mentioned but not bounded', () => {
    const body = 'Handle every provider consistently.\n\n- [ ] Unit test asserts consistent handling.';
    const brief = buildImplementationBrief({ title: 'Unbounded providers', body, config: briefConfig() });
    assert.equal(brief.matrix, null);
    assert.ok(brief.ambiguities.some(entry => entry.includes('mentions providers without bounding them')));
  });

  it('is deterministic across runs', () => {
    const first = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    const second = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.deepEqual(first, second);
    assert.equal(formatBriefLines(first).join('\n'), formatBriefLines(second).join('\n'));
  });

  it('bounds a maximum-size issue with explicit omission markers', () => {
    const criteria = [];
    for (let index = 0; index < 40; index += 1) {
      criteria.push(`- [ ] Criterion ${index} ${'detail '.repeat(60)}ends here.`);
    }
    const body = [
      'Cover github gitlab linear jira providers with oauth, api key, ssh, and device code auth modes on windows, macos, and linux platforms.',
      '',
      ...criteria,
    ].join('\n');
    const brief = buildImplementationBrief({ title: 'Maximum size', body, config: briefConfig() });
    assert.equal(brief.obligations.length, 30);
    assert.equal(brief.omittedObligations, 10);
    for (const obligation of brief.obligations) {
      assert.ok(obligation.criterion.length <= 240 + ' [truncated]'.length);
      assert.ok(obligation.criterion.endsWith('[truncated]'));
    }
    assert.ok(brief.matrix);
    assert.equal(brief.matrix.rows.length, 24);
    assert.equal(brief.matrix.omittedRows, 24);
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(joined.includes('(+10 obligations omitted)'));
    assert.ok(joined.includes('(+24 rows omitted)'));
  });

  it('renders no omission markers for a small issue', () => {
    const brief = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(!joined.includes('omitted)'));
    assert.ok(!joined.includes('[truncated]'));
  });

  it('degrades cleanly to a minimal brief without fabricating obligations', () => {
    const brief = buildImplementationBrief({ title: 'Wording pass', body: 'contestant latest errorship pretest wording improvements.', config: briefConfig() });
    assert.equal(brief.minimal, true);
    assert.deepEqual(brief.obligations, []);
    assert.equal(brief.matrix, null);
    assert.deepEqual(brief.riskCards, []);
    const joined = formatBriefLines(brief).join('\n');
    assert.ok(joined.includes('Minimal brief:'));
    assert.ok(joined.includes('(none stated in the issue checklist)'));
  });

  it('activates zero risk cards when nothing matches', () => {
    const brief = buildImplementationBrief({ title: 'Wording pass', body: 'contestant latest errorship pretest\n\n- [ ] The introduction wording reads clearly for newcomers.', config: briefConfig() });
    assert.deepEqual(brief.riskCards, []);
    assert.ok(formatBriefLines(brief).join('\n').includes('Risk cards: none activated.'));
  });

  it('caps activated risk cards at five by rank and renders implementer faces only', () => {
    const body = 'status error provider auth stale cache timeout lock path malformed package test\n\n- [ ] Unit test asserts behavior.';
    const brief = buildImplementationBrief({ title: 'Keyword soup', body, config: briefConfig() });
    assert.equal(brief.riskCards.length, 5);
    assert.deepEqual(brief.riskCards.map(card => card.id), [
      'truthful-state-transitions',
      'oracle-quality',
      'trust-identity-boundaries',
      'filesystem-boundaries',
      'mode-provider-matrix',
    ]);
    const catalog = loadRiskCardCatalog();
    const joined = formatBriefLines(brief).join('\n');
    for (const rendered of brief.riskCards) {
      const card = catalog.find(candidate => candidate.id === rendered.id);
      assert.equal(rendered.implementerFace, card.implementerFace.trim());
      const reviewerOpening = card.reviewerFace.trim().slice(0, 40);
      assert.ok(!joined.includes(reviewerOpening), `reviewer face leaked for ${rendered.id}`);
    }
  });

  it('predicts review lanes from expected paths using lane policy', () => {
    const multiMode = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.deepEqual(multiMode.expectedLanes.map(lane => lane.lane), ['issue-compliance', 'security']);
    const singleMode = buildImplementationBrief({ title: 'Single mode', body: SINGLE_MODE_BODY, config: briefConfig() });
    assert.deepEqual(singleMode.expectedLanes.map(lane => lane.lane), ['issue-compliance']);
    for (const lane of multiMode.expectedLanes) {
      assert.ok(lane.heuristic.length > 0);
    }
    assert.ok(formatBriefLines(multiMode).join('\n').includes('design for them now'));
  });

  it('derives negative cases from cards and failure-bearing obligations', () => {
    const brief = buildImplementationBrief({ title: 'Multi-mode work', body: MULTI_MODE_BODY, config: briefConfig() });
    assert.ok(brief.negativeCases.some(entry => entry.startsWith('Write a negative test for: "Malformed provider payloads')));
    assert.ok(brief.negativeCases.length > 0);
  });

  it('extracts expected paths from backticked and bare path tokens', () => {
    const paths = extractExpectedPaths('Edit `products/aie/src/view.ts` and products/aie/test/view.test.cjs but not `a spaced token`, `prompts/**/*.md`, or plain words.');
    assert.ok(paths.includes('products/aie/src/view.ts'));
    assert.ok(paths.includes('products/aie/test/view.test.cjs'));
    assert.ok(!paths.some(path => path.includes(' ')));
    assert.ok(!paths.some(path => path.includes('*')));
  });
});
