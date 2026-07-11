const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { computeReviewStats, formatReviewStats, laneRecordsFromTrustedMetadata, DEFAULT_STATS_WINDOW, MAX_STATS_WINDOW } = require('../dist/app/review_stats.js');

function record(lane, head, recommendation, findingCount) {
  return { lane, head, recommendation, findingCount };
}

describe('review convergence stats core', () => {
  it('computes per-PR and rolling values for a mixed window', () => {
    const prs = [
      { number: 14, title: 'Clean PR', state: 'MERGED', laneRecords: [record('code-quality', 'headA', 'approve', 0), record('performance', 'headA', 'approve', 0)] },
      {
        number: 13,
        title: 'Loop PR',
        state: 'MERGED',
        laneRecords: [
          record('code-quality', 'h1', 'request-changes', 2),
          record('issue-compliance', 'h2', 'request-changes', 1),
          record('code-quality', 'h2', 'approve', 0),
          record('performance', 'h3', 'approve', 1),
        ],
      },
      { number: 11, title: 'No evidence PR', state: 'CLOSED', laneRecords: [] },
    ];
    const { prs: perPr, summary } = computeReviewStats(prs, DEFAULT_STATS_WINDOW);

    assert.deepEqual(perPr.map(pr => pr.number), [14, 13, 11]);
    assert.deepEqual(perPr[0], { number: 14, title: 'Clean PR', state: 'MERGED', reviewedHeads: 1, failingHeads: 0, blockingEntries: 0, firstReviewClean: true, noLaneEvidence: false, reason: null });
    assert.equal(perPr[1].reviewedHeads, 3);
    assert.equal(perPr[1].failingHeads, 2);
    assert.equal(perPr[1].blockingEntries, 3);
    assert.equal(perPr[1].firstReviewClean, false);
    assert.equal(perPr[2].noLaneEvidence, true);
    assert.equal(perPr[2].firstReviewClean, null);
    assert.match(perPr[2].reason, /No QUBE lane reviews/);

    assert.equal(summary.totalPrs, 3);
    assert.equal(summary.reviewedPrs, 2);
    assert.equal(summary.noLaneEvidencePrs, 1);
    assert.equal(summary.firstReviewCleanCount, 1);
    assert.equal(summary.firstReviewCleanRate, 0.5);
    assert.equal(summary.medianReviewedHeads, 2);
    assert.equal(summary.blockingEntries, 3);
    assert.equal(summary.blockingEntriesAfterFirstHead, 1);
    assert.equal(summary.afterFirstHeadShare, 1 / 3);
    assert.deepEqual(summary.blockingEntriesByLane, { 'code-quality': 2, 'issue-compliance': 1 });
  });

  it('reports load failures as no-lane-evidence with the stated reason', () => {
    const { prs: perPr, summary } = computeReviewStats([
      { number: 9, title: 'Broken PR', state: 'MERGED', laneRecords: [], loadFailure: 'Pull request review state unavailable: boom' },
    ], 5);
    assert.equal(perPr[0].noLaneEvidence, true);
    assert.match(perPr[0].reason, /unavailable: boom/);
    assert.equal(summary.reviewedPrs, 0);
    assert.equal(summary.firstReviewCleanRate, null);
    assert.equal(summary.medianReviewedHeads, null);
    assert.equal(summary.afterFirstHeadShare, null);
  });

  it('drops malformed trusted metadata records and counts them', () => {
    const { records, malformed } = laneRecordsFromTrustedMetadata([
      { lane: 'code-quality', head: 'h1', recommendation: 'approve', bodyFindingCount: 1 },
      { lane: '', head: 'h1', recommendation: 'approve' },
      { head: 'h1', recommendation: 'approve' },
      'not a record',
      { lane: 'security', head: 'h1', recommendation: 'request-changes', bodyFindingCount: -3 },
    ]);
    assert.equal(records.length, 2);
    assert.equal(records[1].findingCount, 0, 'negative finding counts clamp to zero');
    assert.equal(malformed, 3);
    assert.deepEqual(laneRecordsFromTrustedMetadata('not an array'), { records: [], malformed: 0 });
  });

  it('is deterministic and renders the same fields in human output', () => {
    const prs = [
      { number: 5, title: 'One', state: 'MERGED', laneRecords: [record('code-quality', 'x', 'request-changes', 2)] },
    ];
    const first = computeReviewStats(prs, 5);
    const second = computeReviewStats(prs, 5);
    assert.deepEqual(first, second);

    const rendered = formatReviewStats({ ok: true, command: 'review stats', window: 5, prs: first.prs, summary: first.summary, warnings: [] });
    assert.ok(rendered.includes('#5 "One"'));
    assert.ok(rendered.includes('First-review-clean rate: 0% (0/1 reviewed'));
    assert.ok(rendered.includes('Median reviewed heads per reviewed PR: 1.'));
    assert.ok(rendered.includes('Blocking entries: 2 total; 0 after the first head'));
    assert.ok(rendered.includes('- code-quality: 2'));
    assert.equal(MAX_STATS_WINDOW, 50);
  });
});
