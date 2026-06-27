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