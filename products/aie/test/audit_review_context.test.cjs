'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { describe, it } = require('node:test');
const { mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

require('./support/compile_cache.cjs');

const { auditReviewContextLines, loadAuditReviewRecord, withVisualAuditContext } = require('../dist/app/audit_review_context.js');
const { getDefaults } = require('../dist/config/index.js');
const { runLocalReviewRunner } = require('../dist/app/local_review_runner.js');
const { makePng } = require('./support/png_fixture.cjs');

const MATRIX_ROWS = ['initial-load', 'changed-interaction', 'affected-states', 'keyboard-accessibility', 'responsive-layout', 'user-visible-failures'];

function homeRepo() {
  const home = mkdtempSync(join(tmpdir(), 'aie-audit-review-'));
  const repo = join(home, 'workspace', 'product-ui');
  mkdirSync(repo, { recursive: true });
  return { home, repo };
}

function writeAudit(home, issueNumber, extras = {}) {
  const directory = join(home, '.qube', 'verification', 'product-ui', String(issueNumber));
  mkdirSync(join(directory, 'screenshots'), { recursive: true });
  const image = makePng();
  writeFileSync(join(directory, 'screenshots', 'settings.png'), image);
  const state = {
    id: 'saved',
    name: 'Saved settings',
    url: 'http://localhost:3000/settings',
    viewport: { width: 1280, height: 800 },
    actions: [
      { type: 'navigate', description: 'Opened settings in the browser.' },
      { type: 'click', description: 'Saved the changed setting.' },
      { type: 'inspect', description: 'Inspected the visible result and screenshot.' },
    ],
    visibleOutcome: 'The saved setting and success notice were visible.',
    screenshot: { path: 'screenshots/settings.png', sha256: createHash('sha256').update(image).digest('hex') },
    findings: extras.findings ?? [],
    blockers: [],
  };
  const record = {
    version: 1,
    outcome: extras.outcome ?? 'passed',
    headSha: extras.headSha ?? 'abcdef1234567',
    targetUrl: 'http://localhost:3000/settings',
    browser: { name: 'agent-browser', sessionId: 'browser-session-1' },
    surfaces: [{
      name: 'Settings',
      changedFlow: 'Save settings',
      interactionRequired: true,
      states: [state],
      matrix: MATRIX_ROWS.map(row => ({
        row,
        status: row === 'initial-load' || row === 'changed-interaction' ? 'inspected' : 'not-applicable',
        stateIds: row === 'initial-load' || row === 'changed-interaction' ? ['saved'] : [],
        reason: row === 'initial-load' || row === 'changed-interaction' ? null : `${row} was not affected.`,
      })),
    }],
    findings: [],
    blockers: [],
  };
  writeFileSync(join(directory, 'audit.json'), `${JSON.stringify(record, null, 2)}\n`);
  if (extras.notes) writeFileSync(join(directory, 'notes.md'), extras.notes);
  return directory;
}

describe('audit review context', () => {
  it('injects the typed passed outcome and validated observations into the visual lane', () => {
    const { home, repo } = homeRepo();
    writeAudit(home, 548);
    const text = auditReviewContextLines({ repoRoot: repo, issueNumber: 548, headSha: 'abcdef1234567', homeDirectory: home, manualUiAudit: true, uiLaneActive: true }).join('\n');
    assert.match(text, /Manual UI audit outcome: passed/);
    assert.match(text, /browser-session-1/);
    assert.match(text, /State saved/);
    assert.match(text, /The saved setting and success notice were visible/);
    assert.match(text, /settings\.png; 160x120/);
    assert.match(text, /untrusted local observer input/);
  });

  it('names focused incomplete reasons when evidence is absent', () => {
    const { home, repo } = homeRepo();
    const text = auditReviewContextLines({ repoRoot: repo, issueNumber: 548, headSha: 'abcdef1234567', homeDirectory: home, manualUiAudit: true, uiLaneActive: true }).join('\n');
    assert.match(text, /Manual UI audit outcome: incomplete/);
    assert.match(text, /missing-audit-record/);
    assert.match(text, /Evidence presence alone is not a visual pass/);
  });

  it('passes failed and stale outcomes to the lane without converting them to complete evidence', () => {
    const failed = homeRepo();
    writeAudit(failed.home, 548, { findings: ['The button overlaps the notice.'] });
    const failedText = auditReviewContextLines({ repoRoot: failed.repo, issueNumber: 548, headSha: 'abcdef1234567', homeDirectory: failed.home, manualUiAudit: true, uiLaneActive: true }).join('\n');
    assert.match(failedText, /Manual UI audit outcome: failed \(observer reported passed\)/);
    assert.match(failedText, /blocking finding/);

    const stale = homeRepo();
    writeAudit(stale.home, 548, { headSha: 'aaaaaaaaaaaaaaa' });
    const staleText = auditReviewContextLines({ repoRoot: stale.repo, issueNumber: 548, headSha: 'bbbbbbbbbbbbbbb', homeDirectory: stale.home, manualUiAudit: true, uiLaneActive: true }).join('\n');
    assert.match(staleText, /Manual UI audit outcome: incomplete/);
    assert.match(staleText, /stale-audit-head/);
  });

  it('does not raise a missing-evidence finding when audit policy is off', () => {
    const { home, repo } = homeRepo();
    const text = auditReviewContextLines({ repoRoot: repo, issueNumber: 548, headSha: 'abcdef1234567', homeDirectory: home, manualUiAudit: false, uiLaneActive: true }).join('\n');
    assert.match(text, /disabled by repository policy/);
    assert.doesNotMatch(text, /missing-audit-record/);
  });

  it('loads the same typed result used by the audit command', () => {
    const { home, repo } = homeRepo();
    writeAudit(home, 548);
    const record = loadAuditReviewRecord({ issueNumber: 548, repoRoot: repo, homeDirectory: home, headSha: 'abcdef1234567' });
    assert.equal(record.outcome, 'passed');
    assert.equal(record.screenshots.length, 1);
    assert.equal(record.record.surfaces[0].states[0].visibleOutcome, 'The saved setting and success notice were visible.');
  });

  it('puts typed audit evidence in the local visual-lane prompt', async () => {
    const { home, repo } = homeRepo();
    writeAudit(home, 548);
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify({ version: 1, policy: { audit: { manualUiAudit: true } } })}\n`);
    const config = structuredClone(getDefaults());
    config.reviewAdapter = 'local';
    config.localReviewAgents = ['codex'];
    config.reviewProfile = 'local-focused';
    config.reviewLanes = [
      { id: 'ui-ux-accessibility', required: 'always', match: ['**/*'], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', rereview: 'delta', route: null },
    ];
    const result = await runLocalReviewRunner(config, { repoRoot: repo, issueNumbers: [548], prNumber: 12, headSha: 'abcdef1234567', required: true, shadow: false, dryRun: true, includePrompts: true, homeDirectory: home, changedPaths: ['docs/index.html'] });
    const visual = result.lanes.find(lane => lane.lane === 'ui-ux-accessibility');
    assert.ok(visual);
    assert.match(visual.promptText, /Manual UI audit outcome: passed/);
    assert.match(visual.promptText, /State saved/);
  });

  it('adds audit context to the visual route only', () => {
    const { home, repo } = homeRepo();
    writeAudit(home, 548);
    const visual = withVisualAuditContext({ lane: 'ui-ux-accessibility', repoRoot: repo, issueNumber: 548, headSha: 'abcdef1234567', contextLines: ['shared context'], homeDirectory: home, manualUiAudit: true }).join('\n');
    assert.match(visual, /Manual UI audit outcome: passed/);
    const other = withVisualAuditContext({ lane: 'code-quality', repoRoot: repo, issueNumber: 548, headSha: 'abcdef1234567', contextLines: ['shared context'], homeDirectory: home, manualUiAudit: true }).join('\n');
    assert.equal(other, 'shared context');
  });
});
