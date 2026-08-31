const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');
const { runUiAudit } = require('../dist/audit.js');
const { manualUiAuditReadiness } = require('../dist/app/pr_body.js');
const { makePng } = require('./support/png_fixture.cjs');

function makeGitRepo() {
  return cloneGitRepo('bare', 'aie-audit-repo-');
}

function binRun(args, cwd = process.cwd(), env = {}) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeConfig(repo, config) {
  mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
  writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify(config.normalizedPolicy ? configToFileShape(config) : config, null, 2)}\n`);
}

function cleanConfig() {
  return configToFileShape(getDefaults());
}

function safeRepoSegment(repo) {
  return basename(repo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
}

const MATRIX_ROWS = ['initial-load', 'changed-interaction', 'affected-states', 'keyboard-accessibility', 'responsive-layout', 'user-visible-failures'];

function auditDirectory(home, repo, issueNumber) {
  return join(home, '.qube', 'verification', safeRepoSegment(repo), String(issueNumber));
}

function validAuditRecord(headSha, screenshotSha, overrides = {}) {
  const state = {
    id: 'settings-saved',
    name: 'Saved settings',
    url: 'http://localhost:3000/settings',
    viewport: { width: 1280, height: 800 },
    actions: [
      { type: 'navigate', description: 'Opened the settings route in the browser.' },
      { type: 'click', description: 'Changed and saved the setting.' },
      { type: 'inspect', description: 'Inspected the visible saved state and screenshot.' },
    ],
    visibleOutcome: 'The saved value and success notice were visible with no clipping.',
    screenshot: { path: 'screenshots/settings.png', sha256: screenshotSha },
    findings: [],
    blockers: [],
    ...overrides.state,
  };
  const matrix = MATRIX_ROWS.map(row => ({
    row,
    status: row === 'initial-load' || row === 'changed-interaction' ? 'inspected' : 'not-applicable',
    stateIds: row === 'initial-load' || row === 'changed-interaction' ? [state.id] : [],
    reason: row === 'initial-load' || row === 'changed-interaction' ? null : `${row} was not affected by this change.`,
  }));
  return {
    version: 1,
    outcome: 'passed',
    headSha,
    targetUrl: 'http://localhost:3000/settings',
    browser: { name: 'agent-browser', sessionId: 'browser-session-1' },
    surfaces: [{ name: 'Settings', changedFlow: 'Save one setting', interactionRequired: true, states: [state], matrix, ...overrides.surface }],
    findings: [],
    blockers: [],
    ...overrides.record,
  };
}

function writeAuditBundle(home, repo, issueNumber, headSha, overrides = {}) {
  const directory = auditDirectory(home, repo, issueNumber);
  const screenshots = join(directory, 'screenshots');
  mkdirSync(screenshots, { recursive: true });
  const image = overrides.image ?? makePng();
  const imagePath = join(screenshots, 'settings.png');
  writeFileSync(imagePath, image);
  const screenshotSha = createHash('sha256').update(image).digest('hex');
  const record = validAuditRecord(headSha, screenshotSha, overrides);
  writeFileSync(join(directory, 'audit.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { directory, imagePath, record };
}

describe('manual UI audit model', () => {
  it('plans a required audit without creating evidence during dry-run', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();
    config.uiAuditAppLaunch = 'npm run dev';
    config.uiAuditTarget = 'http://localhost:3000/settings';

    const result = runUiAudit(config, { issueNumber: 93, repoRoot: repo, homeDirectory: home, dryRun: true });

    assert.equal(result.required, true);
    assert.equal(result.preferredBrowser, 'agent-browser');
    assert.match(result.fallbackBrowserAutomation, /fallback|only when/i);
    assert.equal(result.uploadEnabled, false);
    assert.equal(result.appLaunch, 'npm run dev');
    assert.equal(result.auditTarget, 'http://localhost:3000/settings');
    assert.equal(result.recordTemplate.headSha, '<current-head-sha>');
    assert.equal(result.recordTemplate.targetUrl, 'http://localhost:3000/settings');
    assert.deepEqual(result.recordTemplate.surfaces[0].matrix.map(item => item.row), MATRIX_ROWS);
    assert.equal(result.evidence.directoryExists, false);
    assert.equal(existsSync(join(home, '.qube', 'verification', 'product-ui', '93')), false);
  });

  it('keeps notes, browser prose, and arbitrary screenshot presence incomplete', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();

    const prepared = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, prepare: true });
    const evidenceDirectory = join(home, '.qube', 'verification', 'product-ui', '94');
    writeFileSync(join(evidenceDirectory, 'notes.md'), 'HTTP 200, API JSON, DOM text, and automated tests passed.\n');
    writeFileSync(join(evidenceDirectory, 'browser-observation.md'), 'Opened a browser route without recording a visual observation.\n');
    writeFileSync(join(evidenceDirectory, 'screenshots', 'arbitrary.png'), makePng());
    writeFileSync(join(evidenceDirectory, 'head-stamp.json'), `${JSON.stringify({ approved: true, headSha: 'abcdef1234567' })}\n`);

    const checked = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, check: true });

    assert.equal(prepared.createdDirectories.length, 2);
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(evidenceDirectory, 'screenshots')), true);
    assert.equal(checked.evidence.outcome, 'incomplete');
    assert.equal(checked.evidence.notesFound, true);
    assert.equal(checked.evidence.browserObservationFound, true);
    assert.equal(checked.evidence.source, 'manual-audit');
    assert.equal(checked.evidence.trust, 'unverified');
    assert.equal(checked.evidence.reasonCode, 'missing-evidence');
    assert.equal(checked.evidence.verified, false);
    assert.equal(checked.evidence.screenshotCount, 0);
    assert.ok(checked.evidence.reasons.some(item => item.code === 'missing-audit-record'));
    assert.match(checked.nextAction, /audit\.json/);
    assert.equal(manualUiAuditReadiness(checked, true).pending.length, 1);
  });

  it('passes only a complete current-head browser-observed audit with validated screenshots', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();
    writeAuditBundle(home, repo, 96, 'abcdef1234567');
    const checked = runUiAudit(config, { issueNumber: 96, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(checked.evidence.outcome, 'passed');
    assert.equal(checked.evidence.reportedOutcome, 'passed');
    assert.equal(checked.evidence.screenshotCount, 1);
    assert.equal(checked.evidence.screenshots[0].width, 160);
    assert.equal(checked.evidence.trust, 'agent-reported');
    assert.equal(checked.evidence.reasonCode, 'local-evidence-found');
    assert.equal(checked.evidence.gateEvidence.result, 'passed');
    assert.match(checked.nextAction, /reports passed/);
    assert.deepEqual(manualUiAuditReadiness(checked, true), { pending: [], blockers: [] });
  });

  it('keeps navigation without visual observation and interaction incomplete', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    writeAuditBundle(home, repo, 105, 'abcdef1234567', {
      state: {
        actions: [{ type: 'navigate', description: 'Opened the settings route.' }],
        visibleOutcome: '',
      },
    });
    const checked = runUiAudit(getDefaults(), { issueNumber: 105, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(checked.evidence.outcome, 'incomplete');
    assert.ok(checked.evidence.reasons.some(item => item.code === 'missing-visual-observation'));
    assert.ok(checked.evidence.reasons.some(item => item.code === 'missing-relevant-interaction'));
  });

  it('rejects HTTP, API, DOM, and automated-test records as browser actions', () => {
    for (const [index, actionType] of ['http-request', 'api-json', 'dom-dump', 'automated-test'].entries()) {
      const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
      const repo = join(home, 'workspace', 'product-ui');
      writeAuditBundle(home, repo, 110 + index, 'abcdef1234567', {
        state: { actions: [{ type: actionType, description: 'Reported a non-visual check.' }] },
      });
      const checked = runUiAudit(getDefaults(), { issueNumber: 110 + index, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
      assert.equal(checked.evidence.outcome, 'incomplete');
      assert.ok(checked.evidence.reasons.some(item => item.code === 'invalid-browser-action'));
    }
  });

  it('rejects unreferenced screenshots', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const { directory } = writeAuditBundle(home, repo, 115, 'abcdef1234567');
    writeFileSync(join(directory, 'screenshots', 'orphan.png'), makePng());
    const checked = runUiAudit(getDefaults(), { issueNumber: 115, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(checked.evidence.outcome, 'incomplete');
    assert.ok(checked.evidence.reasons.some(item => item.code === 'unreferenced-screenshot'));
  });

  it('rejects tiny, corrupt, uniform, and renamed non-image screenshots', () => {
    const cases = [
      ['tiny', makePng(20, 20)],
      ['corrupt', Buffer.from('not-an-image')],
      ['uniform', makePng(160, 120, () => [255, 255, 255, 255])],
      ['renamed', Buffer.from('{"looks":"like json"}')],
    ];
    for (const [index, [name, image]] of cases.entries()) {
      const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
      const repo = join(home, 'workspace', 'product-ui');
      writeAuditBundle(home, repo, 120 + index, 'abcdef1234567', { image });
      const checked = runUiAudit(getDefaults(), { issueNumber: 120 + index, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
      assert.equal(checked.evidence.outcome, 'incomplete', name);
      assert.ok(checked.evidence.reasons.some(item => item.code === 'invalid-screenshot'), name);
    }
  });

  it('rejects screenshot hash mismatches and stale heads', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    writeAuditBundle(home, repo, 125, 'aaaaaaaaaaaaaaa', { state: { screenshot: { path: 'screenshots/settings.png', sha256: 'b'.repeat(64) } } });
    const checked = runUiAudit(getDefaults(), { issueNumber: 125, repoRoot: repo, homeDirectory: home, check: true, headSha: 'ccccccccccccccc' });
    assert.equal(checked.evidence.outcome, 'incomplete');
    assert.equal(checked.evidence.stale, true);
    assert.ok(checked.evidence.reasons.some(item => item.code === 'stale-audit-head'));
    assert.ok(checked.evidence.reasons.some(item => item.code === 'screenshot-hash-mismatch'));
  });

  it('rejects malformed records and unsupported fields instead of normalizing them', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const { directory, record } = writeAuditBundle(home, repo, 128, 'abcdef1234567');
    record.approved = true;
    writeFileSync(join(directory, 'audit.json'), `${JSON.stringify(record)}\n`);
    const unknownField = runUiAudit(getDefaults(), { issueNumber: 128, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(unknownField.evidence.outcome, 'incomplete');
    assert.ok(unknownField.evidence.reasons.some(item => item.code === 'unexpected-audit-field'));
    writeFileSync(join(directory, 'audit.json'), '{not-json');
    const malformed = runUiAudit(getDefaults(), { issueNumber: 128, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(malformed.evidence.outcome, 'incomplete');
    assert.ok(malformed.evidence.reasons.some(item => item.code === 'malformed-audit-record'));
  });

  it('turns a reported pass with a visible finding into failed', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    writeAuditBundle(home, repo, 126, 'abcdef1234567', { state: { findings: ['The save notice overlaps the submit button.'] } });
    const checked = runUiAudit(getDefaults(), { issueNumber: 126, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(checked.evidence.reportedOutcome, 'passed');
    assert.equal(checked.evidence.outcome, 'failed');
    assert.ok(checked.evidence.reasons.some(item => item.code === 'visible-audit-finding'));
    assert.equal(checked.evidence.gateEvidence.result, 'failed');
    assert.match(manualUiAuditReadiness(checked, true).blockers[0].message, /failed with browser-observed visible findings/);
  });

  it('records an unavailable browser or failed app startup as blocked', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const directory = auditDirectory(home, repo, 127);
    mkdirSync(join(directory, 'screenshots'), { recursive: true });
    writeFileSync(join(directory, 'audit.json'), `${JSON.stringify({
      version: 1,
      outcome: 'blocked',
      headSha: 'abcdef1234567',
      targetUrl: 'http://localhost:3000/settings',
      browser: { name: 'agent-browser', sessionId: null },
      surfaces: [],
      findings: [],
      blockers: ['The app runner exited before the browser could navigate to the target URL.'],
    })}\n`);
    const checked = runUiAudit(getDefaults(), { issueNumber: 127, repoRoot: repo, homeDirectory: home, check: true, headSha: 'abcdef1234567' });
    assert.equal(checked.evidence.outcome, 'blocked');
    assert.equal(checked.evidence.gateEvidence.result, 'unknown');
    assert.deepEqual(checked.evidence.reasons, [{ code: 'audit-blocked', message: 'The app runner exited before the browser could navigate to the target URL.' }]);
    assert.match(checked.nextAction, /Resolve the recorded browser or application blocker/);
    assert.match(manualUiAuditReadiness(checked, true).blockers[0].message, /blocked by the recorded browser or application failure/);
  });

  it('reports disabled audit policy without requiring local evidence', () => {
    const config = getDefaults();
    config.manualUiAudit = false;

    const result = runUiAudit(config, { issueNumber: 95, homeDirectory: mkdtempSync(join(tmpdir(), 'aie-audit-home-')) });

    assert.equal(result.required, false);
    assert.equal(result.evidence.outcome, 'incomplete');
    assert.deepEqual(result.evidence.missing, []);
    assert.equal(result.evidence.source, 'manual-audit');
    assert.equal(result.evidence.trust, 'unverified');
    assert.equal(result.evidence.reasonCode, 'manual-audit-disabled');
    assert.match(result.nextAction, /required by config/);
  });

  it('prepares evidence under the QUBE user default, not github-verification or repo .qube', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();
    const prepared = runUiAudit(config, { issueNumber: 101, repoRoot: repo, homeDirectory: home, prepare: true });
    const evidenceDirectory = join(home, '.qube', 'verification', 'product-ui', '101');
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(home, 'github-verification')), false);
    assert.equal(existsSync(join(repo, '.qube', 'verification')), false);
    assert.match(prepared.evidence.directory.replace(/\\/g, '/'), /\.qube\/verification\/product-ui\/101$/);
  });

  it('uses policy.audit.evidenceRoot when set', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();
    config.uiAuditEvidenceRoot = '~/custom-audit';
    const prepared = runUiAudit(config, { issueNumber: 102, repoRoot: repo, homeDirectory: home, prepare: true });
    const evidenceDirectory = join(home, 'custom-audit', 'product-ui', '102');
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(home, '.qube', 'verification', 'product-ui', '102')), false);
    assert.match(prepared.evidence.directory.replace(/\\/g, '/'), /custom-audit\/product-ui\/102$/);
  });

  it('rejects a configured evidence root that walks to a parent directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const config = getDefaults();
    config.uiAuditEvidenceRoot = '~/custom/../outside';
    assert.throws(
      () => runUiAudit(config, { issueNumber: 103, repoRoot: join(home, 'workspace', 'product-ui'), homeDirectory: home, prepare: true }),
      /parent-directory/,
    );
    assert.equal(existsSync(join(home, 'outside')), false);
    assert.equal(existsSync(join(home, 'custom')), false);
  });

  it('does not inspect unrelated user directories', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    mkdirSync(join(home, 'github-verification', 'product-ui'), { recursive: true });
    const result = runUiAudit(getDefaults(), { issueNumber: 104, repoRoot: repo, homeDirectory: home, dryRun: true });
    assert.ok(result.warnings.every(warning => !/github-verification/.test(warning)));
    assert.equal(existsSync(join(home, 'github-verification', 'product-ui', '104')), false);
  });
});

describe('manual UI audit config', () => {
  it('accepts optional app launch and audit target strings', () => {
    const config = cleanConfig();
    config.policy.audit.appLaunch = 'npm run dev';
    config.policy.audit.target = 'http://localhost:5173';
    const result = validateConfig(config);

    assert.equal(result.ok, true);
    assert.equal(result.config.uiAuditAppLaunch, 'npm run dev');
    assert.equal(result.config.uiAuditTarget, 'http://localhost:5173');
  });

  it('rejects non-string app launch and audit target values', () => {
    const config = cleanConfig();
    config.policy.audit.appLaunch = ['npm run dev'];
    config.policy.audit.target = true;
    const result = validateConfig(config);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.audit.appLaunch'));
    assert.ok(result.errors.some(error => error.path === 'policy.audit.target'));
  });

  it('rejects a non-string evidence root', () => {
    const config = cleanConfig();
    config.policy.audit.evidenceRoot = { path: '/tmp' };
    const result = validateConfig(config);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.audit.evidenceRoot'));
  });
});

describe('manual UI audit CLI', () => {
  it('shows audit help forms without creating evidence directories', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const env = { HOME: home, USERPROFILE: home };
    const topic = binRun(['audit', 'help'], repo, env);
    const suffix = binRun(['audit', 'ui', 'help'], repo, env);
    const prefix = binRun(['help', 'audit', 'ui'], repo, env);

    assert.equal(topic.status, 0);
    assert.match(topic.stdout, /audit ui/);
    assert.equal(suffix.status, 0);
    assert.match(suffix.stdout, /manual UI audit/i);
    assert.equal(prefix.status, 0);
    assert.match(prefix.stdout, /audit ui/i);
    assert.equal(existsSync(join(home, 'github-verification')), false);
  });

  it('emits a dry-run plan without writing or running app commands', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const marker = join(repo, 'should-not-run');
    const config = cleanConfig();
    config.policy.audit.appLaunch = `node -e "require('node:fs').writeFileSync('${marker}','ran')"`;
    config.policy.audit.target = 'http://localhost:3000';
    writeConfig(repo, config);

    const result = binRun(['audit', 'ui', '93', '--dry-run', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'audit ui');
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.preferredBrowser, 'agent-browser');
    assert.match(parsed.fallbackBrowserAutomation, /only when agent-browser/);
    assert.equal(parsed.uploadEnabled, false);
    assert.equal(parsed.recordTemplate.version, 1);
    assert.equal(parsed.recordTemplate.browser.name, 'agent-browser');
    assert.match(parsed.nextAction, /Reuse `qube aie run start --name ui-audit -- /);
    assert.match(parsed.nextAction, /http:\/\/localhost:3000/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(home, 'github-verification')), false);
  });

  it('prepares local evidence directories under the configured home directory', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));

    const result = binRun(['audit', 'ui', '93', '--prepare', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);
    const evidenceDirectory = join(home, '.qube', 'verification', safeRepoSegment(repo), '93');

    assert.equal(result.status, 0);
    assert.equal(parsed.prepare, true);
    assert.equal(parsed.evidence.directoryExists, true);
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(evidenceDirectory, 'screenshots')), true);
  });

  it('returns a typed current-head browser-observed outcome', () => {
    const repo = cloneGitRepo('committed', 'aie-audit-repo-');
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeAuditBundle(home, repo, 93, headSha);

    const result = binRun(['audit', 'ui', '93', '--check', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.check, true);
    assert.equal(parsed.evidence.outcome, 'passed');
    assert.equal(parsed.evidence.reportedOutcome, 'passed');
    assert.equal(parsed.evidence.screenshotCount, 1);
    assert.equal(parsed.evidence.source, 'manual-audit');
    assert.equal(parsed.evidence.trust, 'agent-reported');
    assert.equal(parsed.evidence.reasonCode, 'local-evidence-found');
    assert.deepEqual(parsed.evidence.reasons, []);
  });

  it('reports missing visual evidence when check only finds metadata directories', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const evidenceDirectory = join(home, '.qube', 'verification', safeRepoSegment(repo), '93');
    mkdirSync(join(evidenceDirectory, 'screenshots'), { recursive: true });

    const result = binRun(['audit', 'ui', '93', '--check', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.evidence.outcome, 'incomplete');
    assert.equal(parsed.evidence.reasonCode, 'missing-evidence');
    assert.ok(parsed.evidence.reasons.some(item => item.code === 'missing-audit-record'));
    assert.match(parsed.nextAction, /audit\.json/);
  });

  it('fails audit commands on malformed trusted config', () => {
    const repo = makeGitRepo();
    writeConfig(repo, { version: 1, uiAuditAppLaunch: ['npm run dev'] });

    const result = binRun(['audit', 'ui', '93', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, 'audit ui');
    assert.ok(parsed.errors.some(error => error.path === 'uiAuditAppLaunch'));
  });

  it('publishes audit commands in schema metadata', () => {
    const result = binRun(['schema', '--json']);
    const parsed = JSON.parse(result.stdout);
    const audit = parsed.commands.find(command => command.name === 'audit');
    const ui = parsed.commands.find(command => command.name === 'audit ui');
    const checkFlag = ui.flags.find(flag => flag.name === 'check');

    assert.equal(result.status, 0);
    assert.equal(audit.mutation.mutates, false);
    assert.equal(ui.mutation.mutates, true);
    assert.equal(ui.interactions.json, true);
    assert.equal(ui.dryRun.supported, true);
    assert.equal(checkFlag.type, 'boolean');
    assert.deepEqual(ui.mutation.categories, ['local-files']);
    const setRun = parsed.commands.find(command => command.name === 'audit ui set-run');
    assert.ok(setRun);
    assert.equal(setRun.mutation.mutates, true);
    assert.equal(setRun.interactions.json, true);
    assert.equal(setRun.dryRun.supported, true);
  });

  it('names set-run when the launch command and URL are empty', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    writeConfig(repo, cleanConfig());
    const result = binRun(['audit', 'ui', '93', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, 0);
    assert.equal(parsed.appLaunch, null);
    assert.equal(parsed.auditTarget, null);
    assert.ok(parsed.warnings.some(warning => /audit ui set-run/.test(warning)));
    assert.match(parsed.nextAction, /audit ui set-run --command/);
  });

  it('records only the working launch command and URL without a full init rerun', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const config = cleanConfig();
    config.policy.gates.qualityControl = true;
    writeConfig(repo, config);
    const planned = binRun([
      'audit', 'ui', 'set-run',
      '--command', 'pnpm dev:web',
      '--url', 'http://127.0.0.1:5178',
      '--dry-run',
      '--json',
    ], repo, { HOME: home, USERPROFILE: home });
    const plannedParsed = JSON.parse(planned.stdout);
    assert.equal(planned.status, 0, planned.stderr);
    assert.equal(plannedParsed.ok, true);
    assert.equal(plannedParsed.applied, false);
    assert.equal(JSON.parse(require('node:fs').readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8')).policy.audit.appLaunch, '');

    const written = binRun([
      'audit', 'ui', 'set-run',
      '--command', 'pnpm dev:web',
      '--url', 'http://127.0.0.1:5178',
      '--json',
    ], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(written.stdout);
    assert.equal(written.status, 0, written.stderr);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.applied, true);
    assert.equal(parsed.appLaunch, 'pnpm dev:web');
    assert.equal(parsed.target, 'http://127.0.0.1:5178');
    const saved = JSON.parse(require('node:fs').readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(saved.policy.audit.appLaunch, 'pnpm dev:web');
    assert.equal(saved.policy.audit.target, 'http://127.0.0.1:5178');
    assert.equal(saved.policy.gates.qualityControl, true);

    const reused = binRun(['audit', 'ui', '93', '--json'], repo, { HOME: home, USERPROFILE: home });
    const reusedParsed = JSON.parse(reused.stdout);
    assert.equal(reusedParsed.appLaunch, 'pnpm dev:web');
    assert.equal(reusedParsed.auditTarget, 'http://127.0.0.1:5178');
    assert.match(reusedParsed.nextAction, /pnpm dev:web/);
  });

  it('does not copy local overlay fields into the committed config', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const config = cleanConfig();
    writeConfig(repo, config);
    writeFileSync(join(repo, '.qube', 'aie', 'config.local.json'), `${JSON.stringify({
      policy: { reviews: { requestText: 'from-overlay' } },
    }, null, 2)}\n`);
    const written = binRun([
      'audit', 'ui', 'set-run',
      '--command', 'pnpm dev:web',
      '--url', 'http://127.0.0.1:5178',
      '--json',
    ], repo, { HOME: home, USERPROFILE: home });
    assert.equal(written.status, 0, written.stderr);
    const saved = JSON.parse(require('node:fs').readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8'));
    assert.equal(saved.policy.audit.appLaunch, 'pnpm dev:web');
    assert.equal(saved.policy.audit.target, 'http://127.0.0.1:5178');
    assert.notEqual(saved.policy.reviews.requestText, 'from-overlay');
  });

  it('refuses to invent a start command or write an unsafe URL', () => {
    const repo = makeGitRepo();
    writeConfig(repo, cleanConfig());
    const missing = binRun(['audit', 'ui', 'set-run', '--json'], repo);
    assert.notEqual(missing.status, 0);
    assert.match(JSON.parse(missing.stdout).error, /requires --command/);

    const parent = binRun([
      'audit', 'ui', 'set-run',
      '--command', 'pnpm dev',
      '--url', 'http://127.0.0.1:5178/ok/../secret',
      '--json',
    ], repo);
    assert.notEqual(parent.status, 0);
    assert.match(JSON.parse(parent.stdout).error, /parent-directory/);
    assert.equal(JSON.parse(require('node:fs').readFileSync(join(repo, '.qube', 'aie', 'config.json'), 'utf8')).policy.audit.appLaunch, '');
  });
});
