'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  deriveRoundVerdict,
  collectRoundPreconditions,
  partitionRoundFindings,
  rankFindingAnchors,
  suggestionFenceSafety,
  renderSuggestionFence,
  renderInlineCommentBody,
  roundSummaryMarker,
  parseRoundSummaryMarker,
  planRoundSummarySupersession,
  renderRoundSummaryBody,
} = require('../dist/review_round_summary.js');

function finding(overrides = {}) {
  return {
    id: overrides.id ?? 'finding-1',
    severity: overrides.severity ?? 'advisory',
    message: overrides.message ?? 'Fix the thing.',
    ...(overrides.location ? { location: overrides.location } : {}),
    ...(overrides.suggestion ? { suggestion: overrides.suggestion } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

function lane(overrides = {}) {
  return {
    laneId: overrides.laneId ?? 'code-quality',
    status: overrides.status ?? 'passed',
    recommendation: overrides.recommendation ?? 'approve',
    summary: overrides.summary ?? 'Lane summary.',
    findings: overrides.findings ?? [],
    preconditions: overrides.preconditions ?? [],
    evidenceHeadSha: overrides.evidenceHeadSha ?? 'abc1234567890',
    carriedForwardFromHeadSha: overrides.carriedForwardFromHeadSha ?? null,
    origin: overrides.origin ?? 'local',
    withheld: overrides.withheld ?? { duplicates: 0, offDiff: 0, byCap: 0 },
  };
}

function makeDiffIndex(lines) {
  // lines: Array<{path, line, side}>
  return {
    hasLine(path, line, side = 'destination') {
      return lines.some(entry => entry.path === path && entry.line === line && (entry.side ?? 'destination') === side);
    },
  };
}

describe('deriveRoundVerdict', () => {
  it('is request-changes when any lane requests changes, even if others approve', () => {
    const verdict = deriveRoundVerdict([lane({ recommendation: 'approve' }), lane({ recommendation: 'request-changes' })]);
    assert.equal(verdict, 'request-changes');
  });

  it('is approve only when every lane approves', () => {
    const verdict = deriveRoundVerdict([lane({ recommendation: 'approve' }), lane({ recommendation: 'approve' })]);
    assert.equal(verdict, 'approve');
  });

  it('is pending when lanes are empty', () => {
    assert.equal(deriveRoundVerdict([]), 'pending');
  });
});

describe('collectRoundPreconditions', () => {
  it('dedupes identical preconditions across lanes while preserving first-seen order', () => {
    const preconditions = collectRoundPreconditions([
      lane({ preconditions: ['CI is green.', 'Base branch is current.'] }),
      lane({ preconditions: ['Base branch is current.', 'No open blocking PRs.'] }),
    ]);
    assert.deepEqual(preconditions, ['CI is green.', 'Base branch is current.', 'No open blocking PRs.']);
  });
});

describe('partitionRoundFindings', () => {
  it('anchors a finding whose location line is present in the diff index', () => {
    const anchored = finding({ location: { path: 'src/a.ts', line: 10, side: 'destination' } });
    const diffIndex = makeDiffIndex([{ path: 'src/a.ts', line: 10 }]);
    const { inline, unanchored } = partitionRoundFindings([lane({ findings: [anchored] })], diffIndex);
    assert.equal(inline.length, 1);
    assert.equal(unanchored.length, 0);
    assert.equal(inline[0].anchored, true);
  });

  it('marks an off-diff location with a specific reason', () => {
    const offDiff = finding({ location: { path: 'src/a.ts', line: 99, side: 'destination' } });
    const diffIndex = makeDiffIndex([{ path: 'src/a.ts', line: 10 }]);
    const { unanchored } = partitionRoundFindings([lane({ findings: [offDiff] })], diffIndex);
    assert.equal(unanchored.length, 1);
    assert.match(unanchored[0].unanchoredReason, /not part of the current diff/);
  });

  it('marks a location-less finding with a distinct reason', () => {
    const noLocation = finding({ message: 'Gate-level concern.' });
    const diffIndex = makeDiffIndex([]);
    const { unanchored } = partitionRoundFindings([lane({ findings: [noLocation] })], diffIndex);
    assert.equal(unanchored.length, 1);
    assert.match(unanchored[0].unanchoredReason, /no recorded file\/line location/);
  });

  it('treats every finding as unanchored when the provider has no diff index', () => {
    const anchoredShape = finding({ location: { path: 'src/a.ts', line: 10, side: 'destination' } });
    const { inline, unanchored } = partitionRoundFindings([lane({ findings: [anchoredShape] })], null);
    assert.equal(inline.length, 0);
    assert.equal(unanchored.length, 1);
    assert.match(unanchored[0].unanchoredReason, /could not anchor/);
  });
});

describe('rankFindingAnchors', () => {
  it('ranks advisory findings by confidence descending, ties by lane order then message', () => {
    const low = { laneId: 'performance', finding: finding({ id: 'low', message: 'Z low confidence', confidence: 0.2 }), anchored: false, unanchoredReason: 'x' };
    const high = { laneId: 'security', finding: finding({ id: 'high', message: 'A high confidence', confidence: 0.9 }), anchored: false, unanchoredReason: 'x' };
    const { advisory } = rankFindingAnchors([low, high], ['security', 'performance']);
    assert.deepEqual(advisory.map(entry => entry.finding.id), ['high', 'low']);
  });

  it('keeps blocking findings in a separate bucket regardless of confidence', () => {
    const blocking = { laneId: 'security', finding: finding({ id: 'b', severity: 'blocking' }), anchored: false, unanchoredReason: 'x' };
    const advisory = { laneId: 'security', finding: finding({ id: 'a', severity: 'advisory' }), anchored: false, unanchoredReason: 'x' };
    const ranked = rankFindingAnchors([blocking, advisory], ['security']);
    assert.deepEqual(ranked.blocking.map(entry => entry.finding.id), ['b']);
    assert.deepEqual(ranked.advisory.map(entry => entry.finding.id), ['a']);
  });
});

describe('suggestionFenceSafety and renderSuggestionFence', () => {
  it('is safe for a small, single-line, destination-anchored suggestion', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, side: 'destination' }, suggestion: 'const x = 1;' }) };
    const safety = suggestionFenceSafety(anchor);
    assert.equal(safety.safe, true);
    assert.equal(renderSuggestionFence(anchor), '```suggestion\nconst x = 1;\n```');
  });

  it('is unsafe when the finding is not anchored', () => {
    const anchor = { laneId: 'code-quality', anchored: false, unanchoredReason: 'off diff', finding: finding({ suggestion: 'const x = 1;' }) };
    const safety = suggestionFenceSafety(anchor);
    assert.equal(safety.safe, false);
    assert.equal(renderSuggestionFence(anchor), null);
  });

  it('is unsafe when the location is on the source (deleted) side', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, side: 'source' }, suggestion: 'const x = 1;' }) };
    assert.equal(suggestionFenceSafety(anchor).safe, false);
  });

  it('is unsafe when the suggestion text contains a code fence', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, side: 'destination' }, suggestion: 'oops ``` breakout' }) };
    assert.equal(suggestionFenceSafety(anchor).safe, false);
  });

  it('is unsafe when the suggestion spans too many lines', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, endLine: 500, side: 'destination' }, suggestion: 'x' }) };
    assert.equal(suggestionFenceSafety(anchor).safe, false);
  });

  it('is unsafe when there is no suggestion text', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, side: 'destination' } }) };
    assert.equal(suggestionFenceSafety(anchor).safe, false);
  });
});

describe('renderInlineCommentBody', () => {
  it('appends a suggestion fence when the suggestion is safe', () => {
    const anchor = { laneId: 'code-quality', anchored: true, unanchoredReason: null, finding: finding({ location: { path: 'src/a.ts', line: 5, side: 'destination' }, suggestion: 'const x = 1;', message: 'Use const.' }) };
    const body = renderInlineCommentBody(anchor);
    assert.match(body, /\*\*Use const\.\*\*/);
    assert.match(body, /```suggestion\nconst x = 1;\n```/);
  });

  it('omits the fence when the suggestion is unsafe, keeping the finding text', () => {
    const anchor = { laneId: 'code-quality', anchored: false, unanchoredReason: 'off diff', finding: finding({ suggestion: 'const x = 1;', message: 'Use const.' }) };
    const body = renderInlineCommentBody(anchor);
    assert.match(body, /\*\*Use const\.\*\*/);
    assert.doesNotMatch(body, /```suggestion/);
  });
});

describe('round summary marker', () => {
  function metadata(overrides = {}) {
    return {
      version: 1,
      head: overrides.head ?? 'sha1',
      round: overrides.round ?? 'round-1',
      prNumber: overrides.prNumber ?? 42,
      issueNumber: overrides.issueNumber ?? 271,
      verdict: overrides.verdict ?? 'approve',
      expectedLanes: overrides.expectedLanes ?? ['code-quality'],
      inlineCommentCount: overrides.inlineCommentCount ?? 0,
      unanchoredFindingCount: overrides.unanchoredFindingCount ?? 0,
      blockingFindingCount: overrides.blockingFindingCount ?? 0,
      advisoryFindingCount: overrides.advisoryFindingCount ?? 0,
      findingDigest: overrides.findingDigest ?? 'digest123',
      ...(overrides.superseded !== undefined ? { superseded: overrides.superseded } : {}),
    };
  }

  it('round-trips through roundSummaryMarker/parseRoundSummaryMarker', () => {
    const original = metadata();
    const body = `intro text\n${roundSummaryMarker(original)}\nmore text`;
    const parsed = parseRoundSummaryMarker(body);
    assert.deepEqual(parsed, original);
  });

  it('returns null for a body with no marker', () => {
    assert.equal(parseRoundSummaryMarker('just some text'), null);
  });

  it('returns null for a malformed marker payload', () => {
    assert.equal(parseRoundSummaryMarker('<!-- qube-pr-review-summary:{"version":1} -->'), null);
  });

  it('preserves the superseded flag on parse', () => {
    const parsed = parseRoundSummaryMarker(roundSummaryMarker(metadata({ superseded: true })));
    assert.equal(parsed.superseded, true);
  });
});

describe('planRoundSummarySupersession', () => {
  function record(overrides = {}) {
    return {
      id: overrides.id ?? 'r1',
      metadata: {
        version: 1,
        head: overrides.head ?? 'sha1',
        round: overrides.round ?? 'round-1',
        prNumber: overrides.prNumber ?? 42,
        issueNumber: 271,
        verdict: 'approve',
        expectedLanes: ['code-quality'],
        inlineCommentCount: 0,
        unanchoredFindingCount: 0,
        blockingFindingCount: 0,
        advisoryFindingCount: 0,
        findingDigest: 'd',
        ...(overrides.superseded !== undefined ? { superseded: overrides.superseded } : {}),
      },
    };
  }

  it('identifies the same-round record for update-in-place', () => {
    const current = { prNumber: 42, headSha: 'sha1', round: 'round-1' };
    const sameRound = record({ id: 'same', head: 'sha1', round: 'round-1' });
    const plan = planRoundSummarySupersession([sameRound], current);
    assert.equal(plan.sameRoundRecord.id, 'same');
    assert.equal(plan.priorHeadRecords.length, 0);
  });

  it('collects live prior-head records for tombstoning and excludes already-superseded ones', () => {
    const current = { prNumber: 42, headSha: 'sha2', round: 'round-2' };
    const priorLive = record({ id: 'prior-live', head: 'sha1', round: 'round-1' });
    const priorSuperseded = record({ id: 'prior-superseded', head: 'sha0', round: 'round-0', superseded: true });
    const otherPr = record({ id: 'other-pr', head: 'sha1', round: 'round-1', prNumber: 999 });
    const plan = planRoundSummarySupersession([priorLive, priorSuperseded, otherPr], current);
    assert.deepEqual(plan.priorHeadRecords.map(r => r.id), ['prior-live']);
    assert.equal(plan.sameRoundRecord, null);
  });
});

describe('renderRoundSummaryBody', () => {
  function roundInput(overrides = {}) {
    return {
      prNumber: 42,
      issueNumber: 271,
      headSha: 'headsha1234567',
      round: 'round-1',
      expectedLanes: overrides.expectedLanes ?? ['code-quality', 'security'],
      lanes: overrides.lanes ?? [
        lane({ laneId: 'code-quality', recommendation: 'approve' }),
        lane({ laneId: 'security', recommendation: 'approve' }),
      ],
    };
  }

  it('renders a verdict-first body with blocking findings before advisory findings', () => {
    const blocking = finding({ id: 'b', severity: 'blocking', message: 'Blocking issue.' });
    const advisory = finding({ id: 'a', severity: 'advisory', message: 'Advisory issue.' });
    const input = roundInput({
      lanes: [lane({ laneId: 'security', recommendation: 'request-changes', findings: [blocking, advisory] })],
      expectedLanes: ['security'],
    });
    const render = renderRoundSummaryBody(input, { diffIndex: null });
    assert.equal(render.verdict, 'request-changes');
    const blockingIndex = render.body.indexOf('Blocking issue.');
    const advisoryIndex = render.body.indexOf('Advisory issue.');
    assert.ok(blockingIndex > 0 && advisoryIndex > blockingIndex);
    assert.match(render.body, /\[!CAUTION\]/);
    assert.match(render.body, /Request changes: 1 blocking, 1 advisory/);
    assert.match(render.body, /<summary>Lane notes<\/summary>/);
    assert.match(render.body, /<!-- qube-pr-review-summary:/);
  });

  it('separates preconditions from lane findings', () => {
    const input = roundInput({
      lanes: [lane({ laneId: 'code-quality', preconditions: ['CI is green.'] })],
      expectedLanes: ['code-quality'],
    });
    const render = renderRoundSummaryBody(input);
    const conditionsIndex = render.body.indexOf('<summary>Review conditions</summary>');
    const notesIndex = render.body.indexOf('<summary>Lane notes</summary>');
    assert.ok(conditionsIndex > 0 && notesIndex > 0);
    assert.match(render.body, /CI is green\./);
    assert.doesNotMatch(render.body, /Preconditions observed:/);
  });

  it('reports publisher downgrade reason and superseded count in the body', () => {
    const render = renderRoundSummaryBody(roundInput(), { diffIndex: null, publisherDowngradeReason: 'same-author fallback', supersededPriorSummaries: 2 });
    assert.match(render.body, /Publisher downgrade: same-author fallback/);
    assert.match(render.body, /issue-comment transport/);
    assert.doesNotMatch(render.body, /posted inline/);
  });

  it('produces a stable finding digest for identical input and a different digest when a finding changes', () => {
    const withFinding = roundInput({ lanes: [lane({ laneId: 'code-quality', findings: [finding({ message: 'Same finding.' })] })], expectedLanes: ['code-quality'] });
    const renderA = renderRoundSummaryBody(withFinding, { diffIndex: null });
    const renderB = renderRoundSummaryBody(withFinding, { diffIndex: null });
    assert.equal(renderA.findingDigest, renderB.findingDigest);

    const changed = roundInput({ lanes: [lane({ laneId: 'code-quality', findings: [finding({ message: 'Different finding.' })] })], expectedLanes: ['code-quality'] });
    const renderC = renderRoundSummaryBody(changed, { diffIndex: null });
    assert.notEqual(renderA.findingDigest, renderC.findingDigest);
  });

  it('counts inline vs unanchored findings from the diff index', () => {
    const anchored = finding({ id: 'anchored', location: { path: 'src/a.ts', line: 10, side: 'destination' } });
    const offDiff = finding({ id: 'off', location: { path: 'src/a.ts', line: 99, side: 'destination' } });
    const diffIndex = makeDiffIndex([{ path: 'src/a.ts', line: 10 }]);
    const input = roundInput({ lanes: [lane({ laneId: 'code-quality', findings: [anchored, offDiff] })], expectedLanes: ['code-quality'] });
    const render = renderRoundSummaryBody(input, { diffIndex });
    assert.equal(render.inline.length, 1);
    assert.equal(render.unanchored.length, 1);
    assert.match(render.body, /pending/);
    assert.match(render.body, /off-diff, no thread/);
  });

  it('shows a lane as missing in the rollup table when no evidence was provided for an expected lane', () => {
    const input = roundInput({ lanes: [lane({ laneId: 'code-quality' })], expectedLanes: ['code-quality', 'security'] });
    const render = renderRoundSummaryBody(input, { diffIndex: null });
    assert.match(render.body, /security: not run \(no evidence at this head\)/);
  });

  it('renders reused, carried, approved, request-changes, and not-run as distinct chips', () => {
    const input = roundInput({
      expectedLanes: ['code-quality', 'security', 'performance', 'issue-compliance', 'docs'],
      lanes: [
        lane({ laneId: 'code-quality', recommendation: 'approve', origin: 'local' }),
        lane({ laneId: 'security', recommendation: 'request-changes', origin: 'local' }),
        lane({ laneId: 'performance', recommendation: 'approve', origin: 'trusted-provider' }),
        lane({ laneId: 'issue-compliance', recommendation: 'approve', carriedForwardFromHeadSha: 'oldheadbbbbbbbb' }),
      ],
    });
    const render = renderRoundSummaryBody(input, { diffIndex: null });
    assert.match(render.body, /code-quality: approved/);
    assert.match(render.body, /security: request-changes/);
    assert.match(render.body, /performance: reused/);
    assert.doesNotMatch(render.body, /performance: approved/);
    assert.match(render.body, /issue-compliance: carried from oldheadbbbbb/);
    assert.match(render.body, /docs: not run \(no evidence at this head\)/);
  });

  it('keeps the verdict sentence inside a 180-character truncation of visible prose', () => {
    const input = roundInput({
      expectedLanes: ['code-quality'],
      lanes: [lane({ laneId: 'code-quality', recommendation: 'request-changes', findings: [finding({ severity: 'blocking', message: 'Broken parser.' })] })],
    });
    const render = renderRoundSummaryBody(input, { diffIndex: null });
    const visible = render.body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    assert.match(visible, /Request changes/);
    assert.match(visible, /1 blocking/);
  });
});
