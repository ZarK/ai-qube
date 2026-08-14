const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');

const {
  buildDeltaPromptSection,
  countPriorDeltaRounds,
  selectReviewScope,
  validateDeltaLaneEvidence,
} = require('../dist/app/review_delta_scope.js');
const { buildLocalReviewSpawnPrompt } = require('../dist/app/local_review_runner_support.js');
const { buildModelReviewPrompt } = require('../dist/app/model_review_runner.js');
const { readCurrentHeadLaneEvidence } = require('../dist/local_review_evidence.js');

describe('review delta scope', () => {
  it('uses full-diff instruction on the first run', () => {
    const selection = selectReviewScope({});
    assert.equal(selection.scope, 'full');
    assert.equal(selection.reason, 'first-run');
    assert.match(buildDeltaPromptSection(selection), /full current-head diff/);
  });

  it('builds a delta prompt with prior findings and changed paths', () => {
    const selection = selectReviewScope({
      priorApprovedHeadSha: 'aaa111',
      priorFindings: [{ summary: 'empty tokens were dropped' }],
      deltaPaths: ['products/aie/src/gates/index.ts'],
    });
    assert.equal(selection.scope, 'delta');
    const prompt = buildLocalReviewSpawnPrompt({
      hostAgentType: 'qube-review-focus',
      lane: 'code-quality',
      issueNumber: 319,
      prNumber: 509,
      headSha: 'bbb222',
      promptStackHash: 'abc',
      promptText: 'Lane body',
      publishCommand: 'aie pr review publish 509 --lane code-quality --issue 319',
      reviewScope: selection,
    });
    assert.match(prompt, /Delta re-review since approved head aaa111/);
    assert.match(prompt, /empty tokens were dropped/);
    assert.match(prompt, /products\/aie\/src\/gates\/index\.ts/);
    assert.doesNotMatch(prompt, /Inspect the full current-head diff for this lane\./);
  });

  it('forces a full pass when requested or when the cadence is reached', () => {
    const forced = selectReviewScope({ forceFull: true, priorApprovedHeadSha: 'aaa', deltaPaths: ['a.ts'] });
    const cadence = selectReviewScope({ priorDeltaRoundCount: 3, deltaFullEvery: 3, priorApprovedHeadSha: 'aaa', deltaPaths: ['a.ts'] });
    assert.equal(forced.reason, 'forced-full');
    assert.equal(cadence.reason, 'cadence-full');
    assert.match(buildDeltaPromptSection(forced), /full current-head diff/);
  });

  it('rejects delta evidence that names an unreviewed base head', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-delta-scope-'));
    const result = validateDeltaLaneEvidence({
      repoRoot: root,
      issueNumber: 319,
      prNumber: 509,
      laneId: 'code-quality',
      reviewScope: 'delta',
      baseHeadSha: 'deadbeef',
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreviewed-base-head');
  });

  it('accepts delta evidence only when the base head has an approved lane file', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-delta-ok-'));
    const dir = join(root, '.qube', 'aie', 'reviews', '319', '509', 'aaa111');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'code-quality.json'), JSON.stringify({
      version: 1,
      status: 'passed',
      recommendation: 'approve',
      headSha: 'aaa111',
    }));
    const ok = validateDeltaLaneEvidence({
      repoRoot: root,
      issueNumber: 319,
      prNumber: 509,
      laneId: 'code-quality',
      reviewScope: 'delta',
      baseHeadSha: 'aaa111',
    });
    const missing = validateDeltaLaneEvidence({
      repoRoot: root,
      issueNumber: 319,
      prNumber: 509,
      laneId: 'code-quality',
      reviewScope: 'delta',
      baseHeadSha: '',
    });
    assert.equal(ok.ok, true);
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'missing-base-head');
  });

  it('counts trailing delta rounds and resets after a full pass', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-delta-count-'));
    const writeApproved = (headSha, reviewScope, recordedAt) => {
      const dir = join(root, '.qube', 'aie', 'reviews', '319', '509', headSha);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'code-quality.json'), JSON.stringify({
        version: 1,
        status: 'passed',
        recommendation: 'approve',
        headSha,
        reviewScope,
        recordedAt,
      }));
    };
    writeApproved('head-a', 'full', '2026-01-01T00:00:00.000Z');
    writeApproved('head-b', 'delta', '2026-01-02T00:00:00.000Z');
    writeApproved('head-c', 'delta', '2026-01-03T00:00:00.000Z');
    assert.equal(countPriorDeltaRounds({
      repoRoot: root,
      issueNumber: 319,
      prNumber: 509,
      laneId: 'code-quality',
      currentHeadSha: 'head-d',
    }), 2);
    writeApproved('head-d', 'full', '2026-01-04T00:00:00.000Z');
    assert.equal(countPriorDeltaRounds({
      repoRoot: root,
      issueNumber: 319,
      prNumber: 509,
      laneId: 'code-quality',
      currentHeadSha: 'head-e',
    }), 0);
    const cadence = selectReviewScope({
      priorDeltaRoundCount: 3,
      deltaFullEvery: 3,
      priorApprovedHeadSha: 'head-c',
      deltaPaths: ['a.ts'],
    });
    assert.equal(cadence.reason, 'cadence-full');
    assert.equal(cadence.scope, 'full');
  });

  it('puts prior findings and delta paths in the isolated model prompt', () => {
    const selection = selectReviewScope({
      priorApprovedHeadSha: 'aaa111',
      priorFindings: [{ summary: 'empty tokens were dropped' }],
      deltaPaths: ['products/aie/src/gates/index.ts'],
    });
    const prompt = buildModelReviewPrompt({
      plan: {
        host: 'codex',
        tier: 'review',
        model: 'gpt-5.6-luna',
        effort: 'high',
        isolation: 'read-only',
        timeoutSeconds: 60,
        maxTurns: 8,
        substitution: null,
      },
      repoRoot: process.cwd(),
      lane: 'code-quality',
      issueNumber: 319,
      prNumber: 509,
      headSha: 'bbb222',
      profile: 'local-focused',
      promptStackHash: 'abc',
      promptText: 'Lane body',
      promptStack: [],
      reviewScope: selection,
    });
    assert.match(prompt, /Delta re-review since approved head aaa111/);
    assert.match(prompt, /empty tokens were dropped/);
    assert.match(prompt, /products\/aie\/src\/gates\/index\.ts/);
    assert.doesNotMatch(prompt, /Inspect the full current-head diff for this lane\./);
  });

  it('rejects current-head delta evidence whose base head was never approved', () => {
    const root = mkdtempSync(join(tmpdir(), 'aie-delta-parse-'));
    const currentDir = join(root, '.qube', 'aie', 'reviews', '319', '509', 'bbb222');
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(join(currentDir, 'code-quality.json'), JSON.stringify({
      version: 1,
      issueNumber: 319,
      prNumber: 509,
      headSha: 'bbb222',
      lane: 'code-quality',
      status: 'passed',
      recommendation: 'approve',
      reviewScope: 'delta',
      baseHeadSha: 'deadbeef',
    }));
    assert.equal(readCurrentHeadLaneEvidence(root, 319, 509, 'bbb222', 'code-quality'), null);

    const priorDir = join(root, '.qube', 'aie', 'reviews', '319', '509', 'aaa111');
    mkdirSync(priorDir, { recursive: true });
    writeFileSync(join(priorDir, 'code-quality.json'), JSON.stringify({
      version: 1,
      issueNumber: 319,
      prNumber: 509,
      headSha: 'aaa111',
      lane: 'code-quality',
      status: 'passed',
      recommendation: 'approve',
    }));
    writeFileSync(join(currentDir, 'code-quality.json'), JSON.stringify({
      version: 1,
      issueNumber: 319,
      prNumber: 509,
      headSha: 'bbb222',
      lane: 'code-quality',
      status: 'passed',
      recommendation: 'approve',
      reviewScope: 'delta',
      baseHeadSha: 'aaa111',
    }));
    assert.ok(readCurrentHeadLaneEvidence(root, 319, 509, 'bbb222', 'code-quality'));
  });
});
