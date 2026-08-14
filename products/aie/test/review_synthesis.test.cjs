'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { planFindingPublication } = require('../dist/review_synthesis.js');

function finding(overrides = {}) {
  return {
    id: overrides.id ?? 'finding-1',
    severity: overrides.severity ?? 'advisory',
    message: overrides.message ?? 'Fix the thing.',
    ...(overrides.location ? { location: overrides.location } : {}),
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

describe('cross-lane finding synthesis', () => {
  it('publishes a cross-lane duplicate only once, from the earlier canonical lane', () => {
    const duplicate = finding({ message: 'Duplicate blocker.', severity: 'blocking', location: { path: 'src/a.ts' } });
    const plans = planFindingPublication(
      [
        { laneId: 'code-quality', findings: [duplicate] },
        { laneId: 'security', findings: [duplicate] },
      ],
      { nitCap: 10 },
    );
    const codeQuality = plans.find(plan => plan.laneId === 'code-quality');
    const security = plans.find(plan => plan.laneId === 'security');

    assert.equal(codeQuality.published.length, 1);
    assert.equal(codeQuality.withheldDuplicates, 0);
    assert.equal(security.published.length, 0);
    assert.equal(security.withheldDuplicates, 1);
  });

  it('never lets final-gate win a dedupe, even when it appears first in the input', () => {
    const repeated = finding({ message: 'Security blocker restated by final-gate.', severity: 'blocking', location: { path: 'src/auth.ts' } });
    const plans = planFindingPublication(
      [
        { laneId: 'final-gate', findings: [repeated] },
        { laneId: 'security', findings: [repeated] },
      ],
      { nitCap: 10 },
    );
    const finalGate = plans.find(plan => plan.laneId === 'final-gate');
    const security = plans.find(plan => plan.laneId === 'security');

    assert.equal(security.published.length, 1);
    assert.equal(finalGate.published.length, 0);
    assert.equal(finalGate.withheldDuplicates, 1);
  });

  it('withholds an advisory finding anchored outside the changed paths', () => {
    const offDiff = finding({ severity: 'advisory', location: { path: 'src/untouched.ts' } });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [offDiff] }],
      { changedPaths: ['src/touched.ts'], nitCap: 10 },
    );

    assert.equal(plans[0].published.length, 0);
    assert.equal(plans[0].withheldOffDiff, 1);
    assert.equal(plans[0].withheldFindings.length, 1);
    assert.match(plans[0].withheldFindings[0].disposition, /off the current diff/);
  });

  it('always publishes a blocking finding regardless of diff location', () => {
    const offDiffBlocking = finding({ severity: 'blocking', location: { path: 'src/untouched.ts' } });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [offDiffBlocking] }],
      { changedPaths: ['src/touched.ts'], nitCap: 10 },
    );

    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].withheldOffDiff, 0);
  });

  it('withholds a location-less advisory when the diff filter is active, keeping location-less blockers', () => {
    const noLocationAdvisory = finding({ severity: 'advisory', message: 'Unanchored advisory.' });
    const noLocationBlocking = finding({ severity: 'blocking', message: 'Gate-level blocking condition.' });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [noLocationAdvisory, noLocationBlocking] }],
      { changedPaths: ['src/touched.ts'], nitCap: 10 },
    );

    assert.deepEqual(plans[0].published.map(item => item.message), ['Gate-level blocking condition.'], 'an anchor-less advisory cannot be re-confirmed against an observed diff');
    assert.equal(plans[0].withheldOffDiff, 1);
  });

  it('keeps a location-less advisory when no changed-path set was observed', () => {
    const noLocation = finding({ severity: 'advisory', message: 'Unanchored advisory.' });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [noLocation] }],
      { nitCap: 10 },
    );

    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].withheldOffDiff, 0);
  });

  it('withholds an anchored advisory against an observed empty diff, keeping blockers', () => {
    const anchoredAdvisory = finding({ severity: 'advisory', message: 'Anchored advisory.', location: { path: 'src/parser.ts', line: 3 } });
    const anchoredBlocking = finding({ severity: 'blocking', message: 'Anchored blocker.', location: { path: 'src/parser.ts', line: 8 } });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [anchoredAdvisory, anchoredBlocking] }],
      { changedPaths: [], nitCap: 10 },
    );

    assert.deepEqual(plans[0].published.map(item => item.message), ['Anchored blocker.'], 'an observed empty diff cannot re-confirm any anchored advisory');
    assert.equal(plans[0].withheldOffDiff, 1);
  });

  it('promotes the highest reported confidence onto the owning lane before cap ranking', () => {
    const ownerLowConfidence = finding({ id: 'owner', message: 'Harden the parser bounds.', location: { path: 'src/parser.ts', line: 7 }, confidence: 0.1 });
    const restatedHighConfidence = finding({ id: 'restated', message: 'Harden the parser bounds.', location: { path: 'src/parser.ts', line: 7 }, confidence: 0.95 });
    const competing = finding({ id: 'competing', message: 'Rename the ambiguous flag.', location: { path: 'src/parser.ts', line: 20 }, confidence: 0.5 });
    const plans = planFindingPublication(
      [
        { laneId: 'code-quality', findings: [ownerLowConfidence] },
        { laneId: 'security', findings: [restatedHighConfidence, competing] },
      ],
      { changedPaths: ['src/parser.ts'], nitCap: 1 },
    );
    const codeQuality = plans.find(plan => plan.laneId === 'code-quality');
    const security = plans.find(plan => plan.laneId === 'security');

    assert.deepEqual(codeQuality.published.map(item => item.message), ['Harden the parser bounds.'], 'the strongest observed confidence must win the cap slot for the owner');
    assert.equal(codeQuality.published[0].confidence, 0.95);
    assert.equal(security.withheldDuplicates, 1);
    assert.deepEqual(security.published, []);
    assert.equal(security.withheldByCap, 1);
  });

  it('keeps same-message findings at different lines distinct across lanes', () => {
    const earlyLine = finding({ id: 'early', severity: 'blocking', message: 'Validate the header before use.', location: { path: 'src/parser.ts', line: 4 } });
    const lateLine = finding({ id: 'late', severity: 'blocking', message: 'Validate the header before use.', location: { path: 'src/parser.ts', line: 42 } });
    const plans = planFindingPublication(
      [
        { laneId: 'code-quality', findings: [earlyLine] },
        { laneId: 'security', findings: [lateLine] },
      ],
      { nitCap: 10 },
    );
    const codeQuality = plans.find(plan => plan.laneId === 'code-quality');
    const security = plans.find(plan => plan.laneId === 'security');

    assert.equal(codeQuality.published.length, 1);
    assert.equal(security.published.length, 1, 'a distinct line anchor must never be withheld as a duplicate');
    assert.equal(security.withheldDuplicates, 0);
  });

  it('ranks advisory findings by confidence descending, ranking missing confidence last', () => {
    const high = finding({ id: 'high', message: 'High confidence finding.', confidence: 0.9 });
    const low = finding({ id: 'low', message: 'Low confidence finding.', confidence: 0.1 });
    const missing = finding({ id: 'missing', message: 'No confidence finding.' });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [missing, low, high] }],
      { nitCap: 2 },
    );

    const publishedMessages = plans[0].published.map(item => item.message);
    assert.deepEqual(publishedMessages, ['High confidence finding.', 'Low confidence finding.']);
    assert.equal(plans[0].withheldByCap, 1);
  });

  it('breaks confidence ties by canonical lane order first, then by message ascending within a lane', () => {
    // Alphabetically last, but code-quality precedes security in canonical
    // order, so this finding must still outrank both tied security findings.
    const codeQualityFinding = finding({ id: 'code-quality-finding', message: 'Z code-quality finding.', confidence: 0.5 });
    const securityFirst = finding({ id: 'security-a', message: 'A security finding.', confidence: 0.5 });
    const securitySecond = finding({ id: 'security-b', message: 'B security finding.', confidence: 0.5 });

    const plans = planFindingPublication(
      [
        { laneId: 'security', findings: [securitySecond, securityFirst] },
        { laneId: 'code-quality', findings: [codeQualityFinding] },
      ],
      { nitCap: 2 },
    );
    const security = plans.find(plan => plan.laneId === 'security');
    const codeQuality = plans.find(plan => plan.laneId === 'code-quality');

    assert.deepEqual(codeQuality.published.map(item => item.message), ['Z code-quality finding.']);
    // Only one cap slot remains for security; message-ascending tie-break keeps "A" over "B".
    assert.deepEqual(security.published.map(item => item.message), ['A security finding.']);
    assert.equal(security.withheldByCap, 1);
  });

  it('exempts blocking findings from the nit cap entirely', () => {
    const blockingA = finding({ id: 'blocking-a', severity: 'blocking', message: 'Blocking A.' });
    const blockingB = finding({ id: 'blocking-b', severity: 'blocking', message: 'Blocking B.' });
    const advisoryKept = finding({ id: 'advisory-kept', severity: 'advisory', message: 'Advisory kept.', confidence: 0.8 });
    const advisoryDropped = finding({ id: 'advisory-dropped', severity: 'advisory', message: 'Advisory dropped.', confidence: 0.2 });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [blockingA, blockingB, advisoryKept, advisoryDropped] }],
      { nitCap: 1 },
    );

    const publishedMessages = plans[0].published.map(item => item.message);
    assert.ok(publishedMessages.includes('Blocking A.'));
    assert.ok(publishedMessages.includes('Blocking B.'));
    assert.ok(publishedMessages.includes('Advisory kept.'));
    assert.ok(!publishedMessages.includes('Advisory dropped.'));
    assert.equal(plans[0].withheldByCap, 1);
  });

  it('disables only the off-diff filter when changedPaths is undefined', () => {
    const wouldBeOffDiff = finding({ severity: 'advisory', location: { path: 'src/anywhere.ts' } });
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [wouldBeOffDiff] }],
      { nitCap: 10 },
    );

    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].withheldOffDiff, 0);
  });

  it('reports no visible obligation when the owner drops a duplicate off-diff', () => {
    const shared = finding({ severity: 'advisory', message: 'Shared advisory.', location: { path: 'src/untouched.ts', line: 4 } });
    const plans = planFindingPublication(
      [
        { laneId: 'issue-compliance', findings: [shared] },
        { laneId: 'code-quality', findings: [shared] },
      ],
      { changedPaths: ['src/parser.ts'], nitCap: 10 },
    );
    const owner = plans.find(plan => plan.laneId === 'issue-compliance');
    const later = plans.find(plan => plan.laneId === 'code-quality');

    assert.equal(owner.published.length, 0, 'the owner withholds it off-diff');
    assert.equal(later.published.length, 0, 'the later lane withholds it as a duplicate');
    assert.equal(owner.hasVisibleObligation, false);
    assert.equal(later.hasVisibleObligation, false, 'the shared identity survived onto no marker');
  });

  it('reports a visible obligation for a withheld duplicate the owner still publishes', () => {
    const shared = finding({ severity: 'blocking', message: 'Shared blocker.', location: { path: 'src/anywhere.ts', line: 2 } });
    const plans = planFindingPublication(
      [
        { laneId: 'code-quality', findings: [shared] },
        { laneId: 'final-gate', findings: [shared] },
      ],
      { changedPaths: ['src/other.ts'], nitCap: 10 },
    );
    const owner = plans.find(plan => plan.laneId === 'code-quality');
    const later = plans.find(plan => plan.laneId === 'final-gate');

    assert.equal(owner.published.length, 1, 'a blocking finding always publishes at the owner');
    assert.equal(later.published.length, 0);
    assert.equal(later.hasVisibleObligation, true, 'the identity is visible on the owner marker');
  });

  it('withholds advisories whose path matches a lane suppress glob', () => {
    const plans = planFindingPublication(
      [{ laneId: 'code-quality', findings: [finding({ location: { path: 'vendor/lib.js' } }), finding({ id: 'keep', message: 'Keep me.', location: { path: 'src/app.ts' } })] }],
      { nitCap: 10, laneSuppress: { 'code-quality': ['vendor/**'] } },
    );
    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].published[0].id, 'keep');
    assert.equal(plans[0].withheldBySuppress, 1);
  });

  it('does not suppress blocking findings that match a lane suppress glob', () => {
    const plans = planFindingPublication(
      [{
        laneId: 'code-quality',
        findings: [finding({ id: 'block', severity: 'blocking', message: 'Vendor crash.', location: { path: 'vendor/lib.js' } })],
      }],
      { nitCap: 10, laneSuppress: { 'code-quality': ['vendor/**'] } },
    );
    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].published[0].id, 'block');
    assert.equal(plans[0].withheldBySuppress, 0);
  });

  it('applies a per-lane advisory cap before the global nit cap', () => {
    const plans = planFindingPublication(
      [{
        laneId: 'code-quality',
        findings: [
          finding({ id: 'a', message: 'A', confidence: 0.9, location: { path: 'src/a.ts' } }),
          finding({ id: 'b', message: 'B', confidence: 0.8, location: { path: 'src/b.ts' } }),
        ],
      }],
      { nitCap: 10, laneAdvisoryCaps: { 'code-quality': 1 } },
    );
    assert.equal(plans[0].published.length, 1);
    assert.equal(plans[0].published[0].id, 'a');
    assert.equal(plans[0].withheldByLaneCap, 1);
  });

  it('throws a plain Error for an invalid nitCap', () => {
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => planFindingPublication([{ laneId: 'code-quality', findings: [] }], { nitCap: invalid }),
        Error,
        `nitCap ${invalid} must throw`,
      );
    }
  });
});
