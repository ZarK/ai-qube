const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const {
  buildReviewHeadDigest,
  RELATED_TEST_PATH_LIMIT,
  relatedTestPaths,
  requirementSectionsFromIssueBody,
  reviewHeadDigestContextLines,
  reviewHeadDigestPath,
  siblingTestCandidates,
  writeReviewHeadDigest,
} = require('../dist/app/review_head_digest.js');

function emptyChecklist(issueNumber, title = `Issue ${issueNumber}`) {
  return {
    issue: { number: issueNumber, title, state: 'OPEN', url: `https://example.test/${issueNumber}` },
    checklist: { total: 0, checked: 0, unchecked: 0, items: [] },
  };
}

function digestInput(repo, overrides = {}) {
  return {
    repoRoot: repo,
    prNumber: 12,
    headSha: 'abc123',
    issueNumbers: [93],
    issueChecklists: [emptyChecklist(93, 'Review digest issue')],
    issueBodies: new Map(),
    prTitle: 'Generate a shared digest',
    prBody: '## Summary\nShip a per-head digest.\n\n## Criterion-to-proof map\n### Criterion 1: Digest exists.\n- Proven by: `products/aie/test/review_head_digest.test.cjs`.\n\n## Notes\nOutside the map.',
    changedPaths: [],
    diffStats: ' 1 file changed, 1 insertion(+)',
    ...overrides,
  };
}

describe('review head digest', () => {
  it('extracts requirement sections and ignores unrelated headings', () => {
    const sections = requirementSectionsFromIssueBody([
      '# Title',
      '## Context',
      'Why this exists.',
      '## Acceptance',
      'Must write digest evidence.',
      '## Notes',
      'Ignore me.',
    ].join('\n'));
    assert.deepEqual(sections.map(section => section.heading), ['Context', 'Acceptance']);
    assert.ok(sections[1].text.includes('Must write digest evidence'));
  });

  it('pairs changed source files with sibling test files that exist', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-tests-'));
    writeFileSync(join(repo, 'foo.ts'), 'export {}\n');
    writeFileSync(join(repo, 'foo.test.ts'), 'test("foo", () => {});\n');
    assert.deepEqual(siblingTestCandidates('src/foo.ts'), ['src/foo.test.ts', 'src/foo.spec.ts']);
    assert.deepEqual(relatedTestPaths(repo, ['foo.ts', 'test/unit.cjs']), ['foo.test.ts', 'test/unit.cjs']);
  });

  it('caps related-test discovery instead of probing an unbounded changed-path list', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-cap-'));
    const paths = Array.from({ length: RELATED_TEST_PATH_LIMIT + 25 }, (_, index) => `test/case-${index}.cjs`);
    const related = relatedTestPaths(repo, paths);
    assert.equal(related.length, RELATED_TEST_PATH_LIMIT);
    assert.deepEqual(related, paths.slice(0, RELATED_TEST_PATH_LIMIT));
  });

  it('builds a hash-audited digest with provenance and omits raw PR notes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-build-'));
    const checklists = [{
      issue: { number: 93, title: 'Review digest issue', state: 'OPEN', url: 'https://example.test/93' },
      checklist: {
        total: 1,
        checked: 0,
        unchecked: 1,
        items: [{ index: 1, line: 4, text: 'Digest evidence exists per head with provenance.', checked: false }],
      },
    }];
    const first = buildReviewHeadDigest(digestInput(repo, {
      issueChecklists: checklists,
      issueBodies: new Map([[93, '## Requirements\nWrite one digest per head.\n']]),
      recordedAt: '2026-08-13T00:00:00.000Z',
    }));
    const second = buildReviewHeadDigest(digestInput(repo, {
      issueChecklists: checklists,
      issueBodies: new Map([[93, '## Requirements\nWrite one digest per head.\n']]),
      recordedAt: '2026-08-13T00:00:01.000Z',
    }));

    assert.equal(first.kind, 'review-head-digest');
    assert.equal(first.builder, 'qube-review-digest');
    assert.equal(first.sha256, second.sha256);
    assert.match(first.sha256, /^[a-f0-9]{64}$/);
    assert.equal(first.prIntent.criterionToProofStatus, 'current');
    assert.match(first.prIntent.criterionToProof, /Criterion 1: Digest exists/);
    assert.doesNotMatch(first.prIntent.criterionToProof, /Outside the map/);
    assert.equal(first.acceptanceCriteria[0].bodyStatus, 'current');
    assert.equal(first.acceptanceCriteria[0].items[0].text, 'Digest evidence exists per head with provenance.');
    assert.equal(first.acceptanceCriteria[0].requirementSections[0].heading, 'Requirements');
    assert.ok(first.provenance.sources.some(source => source.kind === 'issue-body' && source.freshness === 'current' && source.sha256));
    assert.ok(first.provenance.sources.some(source => source.kind === 'criterion-to-proof' && source.freshness === 'current'));
  });

  it('names missing issue bodies and criterion maps', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-missing-'));
    const digest = buildReviewHeadDigest(digestInput(repo, {
      issueBodies: new Map(),
      prBody: 'No criterion map in this body.',
    }));
    assert.equal(digest.acceptanceCriteria[0].bodyStatus, 'missing');
    assert.equal(digest.prIntent.criterionToProofStatus, 'missing');
    assert.equal(digest.prIntent.criterionToProof, null);
  });

  it('changes sha256 when acceptance text changes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-hash-'));
    const left = buildReviewHeadDigest(digestInput(repo, {
      issueBodies: new Map([[93, '## Requirements\nAlpha.\n']]),
    }));
    const right = buildReviewHeadDigest(digestInput(repo, {
      issueBodies: new Map([[93, '## Requirements\nBeta.\n']]),
    }));
    assert.notEqual(left.sha256, right.sha256);
  });

  it('writes digest evidence under the per-head review store and renders consume-not-reread context', () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-digest-write-'));
    const digest = buildReviewHeadDigest(digestInput(repo, {
      issueBodies: new Map([[93, '## Requirements\nWrite one digest per head.\n']]),
    }));
    const path = writeReviewHeadDigest(repo, digest, 93);
    const expected = reviewHeadDigestPath(repo, 93, 12, 'abc123');
    assert.equal(path, expected);
    assert.match(path.replace(/\\/g, '/'), /\.qube\/aie\/reviews\/93\/12\/abc123\/context-digest\.json$/);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.sha256, digest.sha256);
    assert.equal(written.builder, 'qube-review-digest');
    const lines = reviewHeadDigestContextLines(digest, path);
    assert.ok(lines.some(line => line.includes('Consume this digest instead of rereading')));
    assert.ok(lines.some(line => line.includes(`Digest sha256: ${digest.sha256}`)));
    assert.ok(lines.some(line => line.includes('Do not reread raw issue bodies')));
    assert.ok(!lines.some(line => line.includes('Outside the map')));
  });
});
