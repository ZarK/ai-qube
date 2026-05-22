const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');

const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');
const { runUiAudit } = require('../dist/audit.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-audit-repo-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  return repo;
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
    assert.equal(existsSync(join(home, 'github-verification', 'product-ui', '93')), false);
  });

  it('prepares local evidence directories and checks recorded notes', () => {
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const repo = join(home, 'workspace', 'product-ui');
    const config = getDefaults();

    const prepared = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, prepare: true });
    const evidenceDirectory = join(home, 'github-verification', 'product-ui', '94');
    const notesPath = join(evidenceDirectory, 'notes.md');
    writeFileSync(notesPath, 'Ran the app locally and verified the visible UI flow.\n');

    const checked = runUiAudit(config, { issueNumber: 94, repoRoot: repo, homeDirectory: home, check: true });

    assert.equal(prepared.createdDirectories.length, 2);
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(evidenceDirectory, 'screenshots')), true);
    assert.equal(checked.evidence.state, 'local-evidence-found');
    assert.equal(checked.evidence.notesFound, true);
    assert.equal(checked.evidence.source, 'manual-audit');
    assert.equal(checked.evidence.trust, 'local-evidence');
    assert.equal(checked.evidence.reasonCode, 'local-evidence-found');
    assert.equal(checked.evidence.verified, false);
    assert.equal(checked.evidence.gateEvidence.result, 'unknown');
    assert.match(checked.nextAction, /cannot certify|Executor reports evidence presence/);
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
    assert.match(parsed.nextAction, /agent-browser/);
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(home, 'github-verification')), false);
  });

  it('prepares local evidence directories under the configured home directory', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));

    const result = binRun(['audit', 'ui', '93', '--prepare', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);
    const evidenceDirectory = join(home, 'github-verification', basename(repo), '93');

    assert.equal(result.status, 0);
    assert.equal(parsed.prepare, true);
    assert.equal(parsed.evidence.directoryExists, true);
    assert.equal(existsSync(evidenceDirectory), true);
    assert.equal(existsSync(join(evidenceDirectory, 'screenshots')), true);
  });

  it('checks local evidence without claiming audit pass', () => {
    const repo = makeGitRepo();
    const home = mkdtempSync(join(tmpdir(), 'aie-audit-home-'));
    const evidenceDirectory = join(home, 'github-verification', basename(repo), '93');
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, 'notes.md'), 'Real running app checked locally.\n');

    const result = binRun(['audit', 'ui', '93', '--check', '--json'], repo, { HOME: home, USERPROFILE: home });
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.check, true);
    assert.equal(parsed.evidence.state, 'local-evidence-found');
    assert.equal(parsed.evidence.source, 'manual-audit');
    assert.equal(parsed.evidence.trust, 'local-evidence');
    assert.equal(parsed.evidence.reasonCode, 'local-evidence-found');
    assert.match(parsed.nextAction, /cannot certify|Executor reports evidence presence/);
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
  });
});
