const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { activeLocalReviewFocuses } = require('../dist/review_focus.js');

describe('review focus selection', () => {
  it('activates always-required focuses from configured lanes', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'security', required: 'when-matched', match: ['**/auth/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
      changedPaths: ['src/index.ts'],
    });

    assert.deepEqual(focuses, ['issue-compliance', 'code-quality', 'performance']);
  });

  it('adds when-matched focuses for changed paths', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'ui-ux-accessibility', required: 'when-matched', match: ['**/*.tsx'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'security', required: 'when-matched', match: ['**/auth/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
      changedPaths: ['src/components/Button.tsx'],
    });

    assert.deepEqual(focuses, ['issue-compliance', 'code-quality', 'performance', 'ui-ux-accessibility']);
  });

  it('matches double-star patterns against root-level paths', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'ui-ux-accessibility', required: 'when-matched', match: ['**/*.tsx'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'api-contract-compatibility', required: 'when-matched', match: ['**/api/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
      changedPaths: ['App.tsx', 'api/routes.ts'],
      maxActive: 5,
    });

    assert.deepEqual(focuses, ['issue-compliance', 'code-quality', 'performance', 'ui-ux-accessibility', 'api-contract-compatibility']);
  });

  it('keeps always-required focuses when capping when-matched focuses', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'security', required: 'when-matched', match: ['**/auth/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'ui-ux-accessibility', required: 'when-matched', match: ['**/*.tsx'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'api-contract-compatibility', required: 'when-matched', match: ['**/api/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
      changedPaths: ['src/auth/login.ts', 'src/components/Button.tsx', 'src/api/routes.ts'],
      maxActive: 5,
    });

    assert.equal(focuses.length, 5);
    assert.deepEqual(focuses.slice(0, 3), ['issue-compliance', 'code-quality', 'performance']);
    assert.ok(focuses.includes('security') || focuses.includes('ui-ux-accessibility') || focuses.includes('api-contract-compatibility'));
  });

  it('falls back to profile defaults when no lanes are configured', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [],
      changedPaths: ['README.md'],
    });

    assert.deepEqual(focuses, ['issue-compliance', 'code-quality', 'performance']);
  });
});

const { carryForwardDeltaTouched, defaultCarryForwardContext, defaultLaneModelTier, resolveLaneModelTier } = require('../dist/review_focus.js');

describe('per-lane model tier defaults', () => {
  it('defaults judgment lanes to review and docs/task-record lanes to economy', () => {
    assert.equal(defaultLaneModelTier('issue-compliance'), 'review');
    assert.equal(defaultLaneModelTier('code-quality'), 'review');
    assert.equal(defaultLaneModelTier('security'), 'review');
    assert.equal(defaultLaneModelTier('final-gate'), 'review');
    assert.equal(defaultLaneModelTier('docs-instructions'), 'economy');
    assert.equal(defaultLaneModelTier('task-record-compliance'), 'economy');
  });

  it('resolves route.tier over lane.tier over the lane default', () => {
    assert.equal(resolveLaneModelTier({ tier: 'economy' }, 'code-quality'), 'economy');
    assert.equal(resolveLaneModelTier({ tier: 'economy', route: { tier: 'review' } }, 'code-quality'), 'review');
    assert.equal(resolveLaneModelTier({ tier: 'review', route: { tier: 'economy' } }, 'docs-instructions'), 'economy');
    assert.equal(resolveLaneModelTier(undefined, 'docs-instructions'), 'economy');
    assert.equal(resolveLaneModelTier({}, 'issue-compliance'), 'review');
  });

  it('omits opted-out lanes from the active focus set', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', optOut: true },
        { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
    });
    assert.deepEqual(focuses, ['issue-compliance', 'performance']);
  });

  it('does not revive profile defaults when every configured focus is opted out', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', optOut: true },
        { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', optOut: true },
      ],
    });
    assert.deepEqual(focuses, []);
  });

  it('does not revive an opted-out lane through profile defaults when no configured lane activates', () => {
    const focuses = activeLocalReviewFocuses({
      profile: 'local-focused',
      lanes: [
        { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', optOut: true },
        { id: 'performance', required: 'when-matched', match: ['src/perf/**'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      ],
      changedPaths: ['src/app.ts'],
    });
    assert.deepEqual(focuses, []);
    assert.equal(focuses.includes('issue-compliance'), false);
  });

  it('does not silently plan a judgment lane as economy without an explicit override', () => {
    assert.notEqual(resolveLaneModelTier({}, 'code-quality'), 'economy');
    assert.notEqual(defaultLaneModelTier('security'), 'economy');
  });
});

describe('carry-forward context modes', () => {
  const contextPatterns = ['AGENTS.md', '**/AGENTS.md', 'docs/spec.md'];

  it('keeps fail-closed all-mode behavior as the default', () => {
    assert.equal(carryForwardDeltaTouched(['CLAUDE.md'], [], contextPatterns), true);
    assert.equal(carryForwardDeltaTouched(['.qube/aie/config.json'], [], contextPatterns), true);
    assert.equal(carryForwardDeltaTouched(['docs/spec.md'], [], contextPatterns, 'all'), true);
  });

  it('scope mode carries doc-only deltas and still honors lane globs', () => {
    assert.equal(carryForwardDeltaTouched(['CLAUDE.md'], [], contextPatterns, 'scope'), false);
    assert.equal(carryForwardDeltaTouched(['.qube/aie/config.json'], [], contextPatterns, 'scope'), false);
    assert.equal(carryForwardDeltaTouched(['docs/spec.md'], ['src/**'], contextPatterns, 'scope'), false);
    assert.equal(carryForwardDeltaTouched(['src/app.ts'], ['src/**'], contextPatterns, 'scope'), true);
    assert.equal(carryForwardDeltaTouched(['notes.md'], ['src/**'], contextPatterns, 'scope'), false);
  });

  it('scope mode still reruns broad empty-match lanes on any non-context delta', () => {
    assert.equal(carryForwardDeltaTouched(['src/app.ts'], [], contextPatterns, 'scope'), true);
    assert.equal(carryForwardDeltaTouched(['CLAUDE.md', 'src/app.ts'], [], contextPatterns, 'scope'), true);
    assert.equal(carryForwardDeltaTouched(['CLAUDE.md', 'AGENTS.md'], [], contextPatterns, 'scope'), false);
  });

  it('config mode reruns on configuration surfaces only', () => {
    assert.equal(carryForwardDeltaTouched(['.qube/aie/config.json'], [], contextPatterns, 'config'), true);
    assert.equal(carryForwardDeltaTouched(['CLAUDE.md'], [], contextPatterns, 'config'), false);
    assert.equal(carryForwardDeltaTouched(['.qube/aie/reviews/93/12/abc/code-quality.json'], [], contextPatterns, 'config'), false);
    assert.equal(carryForwardDeltaTouched(['src/app.ts'], [], contextPatterns, 'config'), true);
  });

  it('assigns conservative per-lane defaults', () => {
    assert.equal(defaultCarryForwardContext('issue-compliance'), 'all');
    assert.equal(defaultCarryForwardContext('final-gate'), 'all');
    assert.equal(defaultCarryForwardContext('task-record-compliance'), 'all');
    assert.equal(defaultCarryForwardContext('security'), 'config');
    assert.equal(defaultCarryForwardContext('release-ci-supply-chain'), 'config');
    assert.equal(defaultCarryForwardContext('performance'), 'scope');
    assert.equal(defaultCarryForwardContext('code-quality'), 'scope');
  });
});
