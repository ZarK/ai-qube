const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { execFileSync, spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { configToFileShape, getDefaults, validateConfig } = require('../dist/config/index.js');
const { isSupplyChainSensitive } = require('../dist/gate_sensitivity.js');
const { buildGatePlan, buildGateStatus } = require('../dist/gates/index.js');

function makeGitRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'aie-gates-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
  return repo;
}

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

function writeConfig(repo, config) {
  writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify(config.normalizedPolicy ? configToFileShape(config) : config, null, 2)}\n`);
}

function cleanConfig() {
  return configToFileShape(getDefaults());
}

function configWithGates(definitions) {
  const config = cleanConfig();
  config.policy.gates.definitions = definitions;
  return config;
}

describe('gate model', () => {
  it('detects workflow path commands as supply-chain-sensitive', () => {
    assert.equal(isSupplyChainSensitive('cat .github/workflows/ci.yml'), true);
    assert.equal(isSupplyChainSensitive('gh workflow run ci.yml'), true);
  });

  it('plans configured gates by stage without executing commands', () => {
    const repo = makeGitRepo();
    const marker = join(repo, 'gate-ran');
    const config = getDefaults();
    config.gates = [
      { name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
      { name: 'unsafe token', kind: 'custom', command: `node -e "require('node:fs').writeFileSync('${marker}','ran')" ghp_1234567890abcdef1234567890abcdef1234`, stage: 'all', required: false, timeoutSeconds: 60, workingDirectory: '.', env: { SECRET: 'github_pat_9876543210fedcba9876543210fedcba9876' }, externalService: true },
      { name: 'merge smoke', kind: 'unit', command: 'node --test test/smoke.test.js', stage: 'pre-merge', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ];

    const plan = buildGatePlan(config, { stage: 'pre-pr', dryRun: true });

    assert.equal(plan.dryRun, true);
    assert.deepEqual(plan.gates.map(gate => gate.name), ['typecheck', 'unsafe token']);
    assert.equal(plan.gates.find(gate => gate.name === 'typecheck').supplyChainSensitive, true);
    assert.match(plan.gates.find(gate => gate.name === 'typecheck').nextAction, /ZarK\/ai-supply-chain-guard/);
    assert.equal(plan.gates.find(gate => gate.name === 'unsafe token').requirement, 'advisory');
    assert.match(plan.gates.find(gate => gate.name === 'unsafe token').command, /\[REDACTED\]/);
    assert.match(plan.gates.find(gate => gate.name === 'unsafe token').env.SECRET, /\[REDACTED\]/);
    assert.equal(existsSync(marker), false);
  });

  it('reports recorded gate evidence without claiming unverified success', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'typecheck.json'), JSON.stringify({ status: 'passed', summary: 'agent reported pass with ghp_1234567890abcdef1234567890abcdef1234' }));
    const config = getDefaults();
    config.gates = [{ name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }];

    const status = buildGateStatus(config, { evidenceRoot: repo });

    assert.equal(status.gates[0].status, 'passed');
    assert.equal(status.gates[0].evidenceSource, 'agent-reported');
    assert.equal(status.gates[0].source, 'configured-gate');
    assert.equal(status.gates[0].trust, 'agent-reported');
    assert.equal(status.gates[0].reasonCode, 'agent-reported-result');
    assert.equal(status.gates[0].verified, false);
    assert.equal(status.gates[0].evidence.result, 'passed');
    assert.match(status.gates[0].evidenceSummary, /\[REDACTED\]/);
    assert.match(status.gates[0].nextAction, /Inspect the recorded evidence/);
  });

  it('reports stale gate evidence without treating it as verified success', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'typecheck.json'), JSON.stringify({ status: 'passed', stale: true, summary: 'old run', recordedAt: '2024-01-01T00:00:00.000Z' }));
    const config = getDefaults();
    config.gates = [{ name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }];

    const status = buildGateStatus(config, { evidenceRoot: repo });

    assert.equal(status.gates[0].status, 'unknown');
    assert.equal(status.gates[0].reasonCode, 'stale-evidence');
    assert.equal(status.gates[0].verified, false);
    assert.equal(status.gates[0].evidence.result, 'stale');
    assert.equal(status.gates[0].evidence.stale, true);
    assert.equal(status.summary.stale, 1);
  });

  it('treats array-shaped gate JSON as malformed evidence', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'typecheck.json'), JSON.stringify([{ status: 'passed', summary: 'not an object' }]));
    const config = getDefaults();
    config.gates = [{ name: 'typecheck', kind: 'typecheck', command: 'npm run typecheck', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }];

    const status = buildGateStatus(config, { evidenceRoot: repo });

    assert.equal(status.gates[0].status, 'unknown');
    assert.equal(status.gates[0].evidenceSource, 'evidence-found');
    assert.equal(status.gates[0].reasonCode, 'malformed-evidence');
    assert.match(status.gates[0].evidenceSummary, /not an object/);
  });

  it('redacts token-like gate names and derived evidence paths', () => {
    const repo = makeGitRepo();
    const tokenName = 'ghp_1234567890abcdef1234567890abcdef1234';
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'ghp-1234567890abcdef1234567890abcdef1234.json'), JSON.stringify({ status: 'passed', summary: 'ok' }));
    const config = getDefaults();
    config.gates = [{ name: tokenName, kind: 'custom', command: 'node --version', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: { [tokenName]: tokenName }, externalService: false }];

    const status = buildGateStatus(config, { evidenceRoot: repo });

    assert.equal(status.gates[0].name, '[REDACTED]');
    assert.match(status.gates[0].evidencePath, /redacted\.json$/);
    assert.doesNotMatch(status.gates[0].evidencePath, /1234567890abcdef/);
    assert.deepEqual(Object.keys(status.gates[0].env), ['[REDACTED]']);
  });

  it('renders aiq only when quality control is enabled and an aiq gate is configured', () => {
    const config = getDefaults();
    config.gates = [{ name: 'quality control', kind: 'aiq', command: 'aiq run', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }];

    assert.equal(buildGatePlan(config).gates.length, 0);
    config.qualityControl = true;
    assert.equal(buildGatePlan(config).gates[0].kind, 'aiq');
  });
});

describe('gate config validation', () => {
  it('accepts structured gates while preserving legacy quality gate strings', () => {
    const result = validateConfig({
      ...cleanConfig(),
      policy: {
        ...cleanConfig().policy,
        gates: {
          definitions: [
        { name: 'lint', kind: 'lint', command: 'npm run lint', stage: 'pre-pr', required: false, timeoutSeconds: 120, workingDirectory: '.', env: { NODE_ENV: 'test' }, externalService: false },
          ],
          qualityGates: ['npm test'],
          qualityControl: false,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.config.gates[0].kind, 'lint');
    assert.deepEqual(result.config.qualityGates, ['npm test']);
  });

  it('rejects malformed structured gates with actionable paths', () => {
    const config = cleanConfig();
    config.policy.gates.definitions = [{ name: '', kind: 'slow', command: '', stage: 'later', required: 'yes', timeoutSeconds: 0, externalService: 'no' }];
    const result = validateConfig(config);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].name'));
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].kind'));
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].stage'));
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].required'));
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].timeoutSeconds'));
    assert.ok(result.errors.some(error => error.path === 'policy.gates.definitions[0].externalService'));
  });
});

describe('gates CLI', () => {
  it('shows gate topic help forms without running commands', () => {
    const repo = makeGitRepo();
    const suffix = binRun(['gates', 'help'], repo);
    const prefix = binRun(['help', 'gates'], repo);
    const flag = binRun(['gates', '--help'], repo);

    assert.equal(suffix.status, 0);
    assert.match(suffix.stdout, /gates plan/);
    assert.equal(prefix.status, 0);
    assert.match(prefix.stdout, /gates plan/);
    assert.equal(flag.status, 0);
    assert.match(flag.stdout, /Usage:/);
  });

  it('emits a stable plan schema from trusted config without executing gate commands', () => {
    const repo = makeGitRepo();
    const marker = join(repo, 'should-not-run');
    writeConfig(repo, configWithGates([
        { name: 'build', kind: 'build', command: 'npm run build', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
        { name: 'marker', kind: 'custom', command: `node -e "require('node:fs').writeFileSync('${marker}','ran')"`, stage: 'pre-pr', required: true, timeoutSeconds: 60, workingDirectory: '.', env: {}, externalService: false },
        { name: 'deploy', kind: 'custom', command: 'npm publish', stage: 'pre-merge', required: false, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: true },
    ]));

    const result = binRun(['gates', 'plan', '--stage', 'pre-pr', '--dry-run', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'gates plan');
    assert.equal(parsed.stage, 'pre-pr');
    assert.deepEqual(parsed.gates.map(gate => gate.name), ['build', 'marker']);
    assert.equal(parsed.gates.find(gate => gate.name === 'build').supplyChainSensitive, true);
    assert.match(parsed.gates.find(gate => gate.name === 'build').nextAction, /ZarK\/ai-supply-chain-guard/);
    assert.match(parsed.warnings.join('\n'), /ZarK\/ai-supply-chain-guard/);
    assert.match(parsed.gates.find(gate => gate.name === 'build').evidenceExpected.join('\n'), /Exact package/);
    assert.match(parsed.gates.find(gate => gate.name === 'build').evidenceExpected.join('\n'), /\.agents\/skills\/supply-chain-guard\/SKILL\.md/);
    assert.equal(existsSync(marker), false);
  });

  it('emits status JSON for missing and recorded evidence', () => {
    const repo = makeGitRepo();
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'unit.json'), JSON.stringify({ status: 'failed', summary: 'test failure' }));
    writeConfig(repo, configWithGates([
        { name: 'unit', kind: 'unit', command: 'node --test', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
        { name: 'e2e', kind: 'e2e', command: 'npm run e2e', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ]));

    const result = binRun(['gates', 'status', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').status, 'failed');
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').evidenceSource, 'agent-reported');
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').source, 'configured-gate');
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').trust, 'agent-reported');
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').reasonCode, 'agent-reported-result');
    assert.equal(parsed.gates.find(gate => gate.name === 'unit').verified, false);
    assert.equal(parsed.gates.find(gate => gate.name === 'e2e').evidenceSource, 'not-recorded');
    assert.equal(parsed.gates.find(gate => gate.name === 'e2e').evidence.result, 'missing');
    assert.equal(parsed.gates.find(gate => gate.name === 'e2e').reasonCode, 'missing-evidence');
    assert.match(parsed.gates.find(gate => gate.name === 'e2e').evidenceSummary, /cannot claim/);
  });

  it('loads status evidence from the repository root when run from a subdirectory', () => {
    const repo = makeGitRepo();
    const subdir = join(repo, 'packages', 'cli');
    mkdirSync(join(repo, '.aie', 'gates'), { recursive: true });
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(repo, '.aie', 'gates', 'unit.json'), JSON.stringify({ status: 'passed', summary: 'root evidence' }));
    writeConfig(repo, configWithGates([{ name: 'unit', kind: 'unit', command: 'node --test', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false }]));

    const result = binRun(['gates', 'status', '--json'], subdir);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(parsed.gates[0].status, 'passed');
    assert.equal(parsed.gates[0].evidenceSource, 'agent-reported');
  });

  it('fails gates commands on malformed trusted config instead of falling back to defaults', () => {
    const repo = makeGitRepo();
    writeConfig(repo, configWithGates([{ name: '', kind: 'slow', command: '', stage: 'later' }]));

    const result = binRun(['gates', 'plan', '--json'], repo);
    const parsed = JSON.parse(result.stdout);

    assert.notEqual(result.status, 0);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.command, 'gates plan');
    assert.ok(parsed.errors.some(error => error.path === 'policy.gates.definitions[0].name'));
    assert.ok(parsed.errors.some(error => error.path === 'policy.gates.definitions[0].kind'));
    assert.match(parsed.nextAction, /Fix aie.config.json/);
  });

  it('publishes gates commands in schema metadata', () => {
    const result = binRun(['schema', '--json']);
    const parsed = JSON.parse(result.stdout);
    const plan = parsed.commands.find(command => command.name === 'gates plan');
    const status = parsed.commands.find(command => command.name === 'gates status');

    assert.equal(plan.mutation.mutates, false);
    assert.equal(plan.interactions.json, true);
    assert.equal(plan.dryRun.supported, true);
    assert.deepEqual(plan.flags.find(flag => flag.name === 'stage').options, ['all', 'pre-merge', 'pre-pr']);
    assert.equal(status.mutation.mutates, false);
  });
});
