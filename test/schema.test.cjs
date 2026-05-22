const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

function binRun(args, cwd = process.cwd()) {
  return spawnSync(process.execPath, [join(process.cwd(), 'bin/run'), ...args], { cwd, encoding: 'utf8' });
}

describe('schema command', () => {
  it('backs implemented commands with the qube-cli registry metadata model', async () => {
    const { EXECUTOR_COMMAND_REGISTRY } = await import('../dist/command_registry.js');
    const { listCommands } = await import('@tjalve/qube-cli/registry');
    const commands = listCommands(EXECUTOR_COMMAND_REGISTRY);
    const commandNames = commands.map(command => command.name);
    const init = commands.find(command => command.name === 'init');
    const start = commands.find(command => command.name === 'start');
    const depsBlockers = commands.find(command => command.name === 'deps blockers');
    const depsReady = commands.find(command => command.name === 'deps ready');

    assert.ok(init, 'Expected init command in registry');
    assert.ok(start, 'Expected start command in registry');
    assert.ok(depsBlockers, 'Expected deps blockers command in registry');
    assert.ok(depsReady, 'Expected deps ready command in registry');

    const exactVersions = init.flags.find(flag => flag.name === 'exact-dependency-versions');
    const assignFlag = start.flags.find(flag => flag.name === 'assign');
    const commentFlag = start.flags.find(flag => flag.name === 'comment');
    const jsonFlag = depsReady.flags.find(flag => flag.name === 'json');
    const dryRunFlag = init.flags.find(flag => flag.name === 'dry-run');

    assert.ok(exactVersions, 'Expected exact-dependency-versions flag on init');
    assert.ok(assignFlag, 'Expected assign flag on start');
    assert.ok(commentFlag, 'Expected comment flag on start');
    assert.ok(jsonFlag, 'Expected json flag on deps ready');
    assert.ok(dryRunFlag, 'Expected dry-run flag on init');

    assert.ok(commandNames.includes('deps blockers'));
    assert.ok(commandNames.includes('pr gate'));
    assert.deepEqual(depsBlockers.arguments.map(argument => argument.name), ['issue']);
    assert.equal(depsBlockers.arguments[0].required, true);
    assert.equal(jsonFlag.short, 'j');
    assert.equal(dryRunFlag.short, 'd');
    assert.equal(exactVersions.negatable, true);
    assert.equal(assignFlag.negatable, true);
    assert.deepEqual(assignFlag.extensions.legacyForms, ['no-assign']);
    assert.equal(commentFlag.negatable, true);
    assert.equal(start.mutation.categories[0], 'github');
    assert.equal(start.interactions.dryRun.supported, true);
  });

  it('emits implemented command metadata with detailed init flag options', () => {
    const result = binRun(['schema', '--json']);
    const parsed = JSON.parse(result.stdout);
    const init = parsed.commands.find(command => command.name === 'init');
    const doctor = parsed.commands.find(command => command.name === 'doctor');
    const switchCommand = parsed.commands.find(command => command.name === 'switch');
    const gatesPlan = parsed.commands.find(command => command.name === 'gates plan');
    const migrate = parsed.commands.find(command => command.name === 'migrate');
    const migrateLegacy = parsed.commands.find(command => command.name === 'migrate legacy');
    const migrateMap = parsed.commands.find(command => command.name === 'migrate map');
    const auditUi = parsed.commands.find(command => command.name === 'audit ui');
    const reviewGate = parsed.commands.find(command => command.name === 'review gate');
    const prView = parsed.commands.find(command => command.name === 'pr view');
    const prBody = parsed.commands.find(command => command.name === 'pr body');
    const prGate = parsed.commands.find(command => command.name === 'pr gate');

    assert.equal(result.status, 0);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.command, 'schema');
    assert.deepEqual(parsed.config.shape, ['version', 'providers', 'policy']);
    assert.deepEqual(parsed.config.supportedProviders.work, ['github']);
    assert.deepEqual(parsed.config.supportedProviders.repository, ['local-git']);
    assert.equal(parsed.config.defaultConfig.providers.work.kind, 'github');
    assert.equal(parsed.config.defaultConfig.policy.branch.baseBranch, 'main');
    assert.ok(init.flags.includes('--tool'));
    assert.ok(init.flags.includes('--missing-milestone'));
    assert.ok(init.flags.includes('--unverified-risk-approval'));
    assert.ok(init.flags.includes('--no-unverified-risk-approval'));
    assert.deepEqual(init.flagDetails.find(flag => flag.name === '--tool').options, ['opencode', 'codex', 'claude-code', 'all']);
    assert.deepEqual(init.flagDetails.find(flag => flag.name === '--missing-milestone').options, ['ignore', 'warn', 'block']);
    assert.equal(init.flagDetails.find(flag => flag.name === '--package-age-days').type, 'integer');
    assert.match(init.flagDetails.find(flag => flag.name === '--unverified-risk-approval').description, /source\/provenance/);
    assert.equal(doctor.flagDetails.find(flag => flag.name === '--json').type, 'boolean');
    assert.ok(doctor.externalServices.includes('github'));
    assert.ok(doctor.stableErrorKinds.includes('config-error'));
    assert.ok(doctor.stableErrorKinds.includes('invalid'));
    assert.deepEqual(doctor.exitCodes, [0, 1]);
    assert.equal(switchCommand.flagDetails.find(flag => flag.name === '--from').type, 'string');
    assert.deepEqual(switchCommand.argDetails, [{ name: 'issue', description: 'Target issue number, for example 93 or #93', required: true }]);
    assert.deepEqual(prView.argDetails, [{ name: 'pr', description: 'Pull request number for concise PR state, for example 12 or #12', required: true }]);
    assert.ok(prView.externalServices.includes('github'));
    assert.ok(prView.stableErrorKinds.includes('review-state-unavailable'));
    assert.equal(prView.supportsJson, true);
    assert.equal(prView.supportsDryRun, false);
    assert.equal(prView.flagDetails.find(flag => flag.name === '--json').type, 'boolean');
    assert.deepEqual(prGate.argDetails, [{ name: 'pr', description: 'Pull request number for the PR review gate, for example 12 or #12', required: true }]);
    assert.deepEqual(parsed.commands.find(command => command.name === 'deps blockers').argDetails, [{ name: 'issue', description: 'Issue number, for example 93 or #93', required: true }]);
    assert.deepEqual(parsed.commands.find(command => command.name === 'start').argDetails, [{ name: 'issue', description: 'Issue selector: next, a bare number such as 93, or shell-safe #93', required: false }]);
    assert.deepEqual(gatesPlan.stageValues, ['all', 'pre-pr', 'pre-merge']);
    assert.deepEqual(gatesPlan.flagDetails.find(flag => flag.name === '--stage').options, ['all', 'pre-pr', 'pre-merge']);
    assert.equal(migrate.mutates, false);
    assert.equal(migrateMap.mutates, false);
    assert.equal(migrateMap.supportsJson, true);
    assert.ok(migrateMap.helpForms.includes('aie migrate map help'));
    assert.ok(migrate.examples.includes('aie migrate map'));
    assert.equal(migrateLegacy.mutates, true);
    assert.deepEqual(migrateLegacy.mutationTargets, ['local-files']);
    assert.equal(migrateLegacy.supportsJson, true);
    assert.equal(migrateLegacy.supportsDryRun, true);
    assert.doesNotMatch(migrateLegacy.description, /non-mutating/);
    assert.ok(migrateLegacy.flags.includes('--dry-run'));
    assert.ok(migrateLegacy.flags.includes('--apply'));
    assert.ok(migrateLegacy.flags.includes('--cleanup'));
    assert.ok(migrateLegacy.flags.includes('--install-wrappers'));
    assert.ok(migrateLegacy.flags.includes('--path'));
    assert.equal(migrateLegacy.flagDetails.find(flag => flag.name === '--instruction').multiple, true);
    assert.equal(migrateLegacy.flagDetails.find(flag => flag.name === '--path').multiple, true);
    assert.ok(migrateLegacy.stableErrorKinds.includes('migration-error'));
    assert.deepEqual(migrateLegacy.exitCodes, [0, 1]);
    assert.deepEqual(migrateLegacy.migrationModeValues, ['audit-plan', 'apply-plan', 'apply-result']);
    assert.deepEqual(migrateLegacy.migrationActionValues, ['remove', 'replace', 'preserve', 'skip']);
    assert.deepEqual(migrateLegacy.migrationConfidenceValues, ['high', 'medium', 'review-required']);
    assert.ok(migrateLegacy.helpForms.includes('aie migrate legacy --help'));
    assert.ok(auditUi.externalServices.includes('agent-browser'));
    assert.ok(reviewGate.reviewAgentValues.includes('oracle'));
    assert.ok(reviewGate.reviewAgentValues.includes('custom'));
    assert.ok(prBody.externalServices.includes('github'));
    assert.ok(prBody.reviewAgentValues.includes('coderabbit'));
    assert.ok(prGate.externalServices.includes('github-copilot'));
    assert.ok(prGate.externalServices.includes('custom-pr-reviewer'));
    assert.ok(prGate.stableErrorKinds.includes('review-state-unavailable'));
  });
});
