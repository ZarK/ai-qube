const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { cloneGitRepo } = require('./support/git_fixture.cjs');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');
const { runUiAudit } = require('../dist/audit.js');

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
  writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config.normalizedPolicy ? configToFileShape(config) : config, null, 2)}\n`);
}

function cleanConfig() {
  return configToFileShape(getDefaults());
}

function safeRepoSegment(repo) {
  return basename(repo).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
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
    assert.equal(result.evidence.directoryExists, false);
    assert.equal(existsSync(join(home, '.qube', 'verification', 'product-ui', '93')), false);
  });

  it('requires browser or screenshot evidence in addition to visual analysis notes', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();

    const prepared = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, prepare: true });
    const evidenceDirectory = join(home, '.qube', 'verification', 'product-ui', '94');
    const notesPath = join(evidenceDirectory, 'notes.md');
    writeFileSync(notesPath, 'Ran the app locally and verified the visible UI flow.\n');

    const checked = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, check: true });

    assert.equal(prepared.createdDirectories.length, 2);
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(evidenceDirectory, 'screenshots')), true);
    assert.equal(checked.evidence.state, 'metadata-only');
    assert.equal(checked.evidence.notesFound, true);
    assert.equal(checked.evidence.browserObservationFound, false);
    assert.equal(checked.evidence.source, 'manual-audit');
    assert.equal(checked.evidence.trust, 'unverified');
    assert.equal(checked.evidence.reasonCode, 'manual-audit-incomplete');
    assert.equal(checked.evidence.verified, false);
    assert.equal(checked.evidence.gateEvidence.result, 'unknown');
    assert.deepEqual(checked.evidence.missing, ['browser-observation.md', 'local screenshots']);
    assert.match(checked.nextAction, /browser-observation\.md, capture local screenshots/);
  });

  it('distinguishes browser visits, screenshots, and visual analysis evidence states', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();
    const evidenceDirectory = join(home, '.qube', 'verification', 'product-ui', '96');
    const screenshotsDirectory = join(evidenceDirectory, 'screenshots');

    mkdirSync(screenshotsDirectory, { recursive: true });

    const metadataOnly = runUiAudit(config, { issueNumber: 96, repoRoot: repo, homeDirectory: home, check: true });
    assert.equal(metadataOnly.evidence.state, 'metadata-only');
    assert.deepEqual(metadataOnly.evidence.missing, ['browser-observation.md', 'local screenshots', 'notes.md visual analysis']);

    writeFileSync(join(evidenceDirectory, 'browser-observation.md'), 'Opened http://localhost:3000/settings at desktop width.\n');
    const browserVisited = runUiAudit(config, { issueNumber: 96, repoRoot: repo, homeDirectory: home, check: true });
    assert.equal(browserVisited.evidence.state, 'browser-visited');
    assert.equal(browserVisited.evidence.browserObservationFound, true);
    assert.deepEqual(browserVisited.evidence.missing, ['local screenshots', 'notes.md visual analysis']);

    writeFileSync(join(screenshotsDirectory, 'settings.png'), 'fake image bytes\n');
    const screenshotsCaptured = runUiAudit(config, { issueNumber: 97, repoRoot: repo, homeDirectory: home, prepare: true });
    const secondEvidenceDirectory = join(home, '.qube', 'verification', 'product-ui', '97');
    const secondScreenshotsDirectory = join(secondEvidenceDirectory, 'screenshots');
    writeFileSync(join(secondScreenshotsDirectory, 'settings.png'), 'fake image bytes\n');
    const screenshotsOnly = runUiAudit(config, { issueNumber: 97, repoRoot: repo, homeDirectory: home, check: true });
    assert.equal(screenshotsCaptured.prepare, true);
    assert.equal(screenshotsOnly.evidence.state, 'screenshots-captured');
    assert.equal(screenshotsOnly.evidence.screenshotCount, 1);
    assert.deepEqual(screenshotsOnly.evidence.missing, ['browser-observation.md', 'notes.md visual analysis']);

    writeFileSync(join(evidenceDirectory, 'notes.md'), 'Visible outcome matched the expected settings UI at desktop width.\n');
    const visualAnalysis = runUiAudit(config, { issueNumber: 96, repoRoot: repo, homeDirectory: home, check: true });
    assert.equal(visualAnalysis.evidence.state, 'visual-analysis-recorded');
    assert.equal(visualAnalysis.evidence.trust, 'local-evidence');
    assert.equal(visualAnalysis.evidence.reasonCode, 'local-evidence-found');
    assert.equal(visualAnalysis.evidence.gateEvidence.result, 'unknown');
    assert.match(visualAnalysis.nextAction, /cannot certify/);
  });

  it('reports disabled audit policy without requiring local evidence', () => {
    const config = getDefaults();
    config.manualUiAudit = false;

    const result = runUiAudit(config, { issueNumber: 95, homeDirectory: mkdtempSync(join(tmpdir(), 'aie-audit-home-')) });

    assert.equal(result.required, false);
    assert.equal(result.evidence.state, 'disabled');
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

  it('reports leftover github-verification trees without writing there', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    mkdirSync(join(home, 'github-verification', 'product-ui'), { recursive: true });
    const result = runUiAudit(getDefaults(), { issueNumber: 104, repoRoot: repo, homeDirectory: home, dryRun: true });
    assert.ok(result.warnings.some(warning => /leftover UI audit directory/.test(warning)));
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

  it('checks local visual evidence without claiming audit pass', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const evidenceDirectory = join(home, '.qube', 'verification', safeRepoSegment(repo), '93');
    const screenshotsDirectory = join(evidenceDirectory, 'screenshots');
    mkdirSync(screenshotsDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, 'browser-observation.md'), 'Opened the real running app with agent-browser.\n');
    writeFileSync(join(screenshotsDirectory, 'home.png'), 'fake image bytes\n');
    writeFileSync(join(evidenceDirectory, 'notes.md'), 'Real running app checked locally.\n');

    const result = binRun(['audit', 'ui', '93', '--check', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.check, true);
    assert.equal(parsed.evidence.state, 'visual-analysis-recorded');
    assert.equal(parsed.evidence.browserObservationFound, true);
    assert.equal(parsed.evidence.screenshotCount, 1);
    assert.equal(parsed.evidence.source, 'manual-audit');
    assert.equal(parsed.evidence.trust, 'local-evidence');
    assert.equal(parsed.evidence.reasonCode, 'local-evidence-found');
    assert.match(parsed.nextAction, /cannot certify|Executor reports evidence presence/);
  });

  it('reports missing visual evidence when check only finds metadata directories', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const evidenceDirectory = join(home, '.qube', 'verification', safeRepoSegment(repo), '93');
    mkdirSync(join(evidenceDirectory, 'screenshots'), { recursive: true });

    const result = binRun(['audit', 'ui', '93', '--check', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.evidence.state, 'metadata-only');
    assert.equal(parsed.evidence.reasonCode, 'manual-audit-incomplete');
    assert.deepEqual(parsed.evidence.missing, ['browser-observation.md', 'local screenshots', 'notes.md visual analysis']);
    assert.match(parsed.nextAction, /browser-observation\.md, capture local screenshots/);
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
    assert.equal(JSON.parse(require('node:fs').readFileSync(join(repo, 'aie.config.json'), 'utf8')).policy.audit.appLaunch, '');

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
    const saved = JSON.parse(require('node:fs').readFileSync(join(repo, 'aie.config.json'), 'utf8'));
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
    writeFileSync(join(repo, 'aie.config.local.json'), `${JSON.stringify({
      policy: { reviews: { requestText: 'from-overlay' } },
    }, null, 2)}\n`);
    const written = binRun([
      'audit', 'ui', 'set-run',
      '--command', 'pnpm dev:web',
      '--url', 'http://127.0.0.1:5178',
      '--json',
    ], repo, { HOME: home, USERPROFILE: home });
    assert.equal(written.status, 0, written.stderr);
    const saved = JSON.parse(require('node:fs').readFileSync(join(repo, 'aie.config.json'), 'utf8'));
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
    assert.equal(JSON.parse(require('node:fs').readFileSync(join(repo, 'aie.config.json'), 'utf8')).policy.audit.appLaunch, '');
  });
});
