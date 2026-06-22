const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { configToFileShape, getDefaults, loadConfig, loadConfigFile, validateConfig } = require('../dist/config/index.js');

function defaultFile() {
  return configToFileShape(getDefaults());
}

describe('config validation', () => {
  it('accepts minimal current-version config and normalizes defaults', () => {
    const result = validateConfig({ version: 1 });

    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.config.version, 1);
    assert.equal(result.config.providers.work.kind, 'github');
    assert.equal(result.config.providers.repository.kind, 'local-git');
    assert.ok(Array.isArray(result.config.priorityLabels));
  });

  it('rejects non-object input', () => {
    const result = validateConfig('not an object');
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === '.' && e.kind === 'invalid'));
  });

  it('supports only the current config version', () => {
    const result = validateConfig({ version: 2 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'version'));
  });

  it('rejects missing version', () => {
    const result = validateConfig({});
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.path === 'version' && e.kind === 'missing'));
  });

  it('returns defaults object with expected provider and policy fields', () => {
    const defaults = getDefaults();
    assert.equal(defaults.version, 1);
    assert.equal(defaults.providers.work.kind, 'github');
    assert.equal(defaults.providers.review.kind, 'github');
    assert.equal(defaults.providers.repository.kind, 'local-git');
    assert.equal(defaults.providers.ci.kind, 'github');
    assert.equal(defaults.providers.layout.kind, 'local');
    assert.equal(defaults.noWorktree, true);
    assert.equal(defaults.blockOnOpenPRs, true);
    assert.equal(defaults.requireBaseBranchFreshness, true);
    assert.equal(defaults.autonomousMode, true);
    assert.equal(defaults.assignOnStart, true);
    assert.equal(defaults.commentOnStart, true);
    assert.equal(defaults.opencodeCommandAlias, false);
    assert.equal(defaults.uiAuditAppLaunch, '');
    assert.equal(defaults.uiAuditTarget, '');
    assert.deepEqual(defaults.reviewAgents, ['coderabbitai']);
    assert.equal(defaults.reviewAdapter, 'github');
    assert.deepEqual(defaults.localReviewAgents, []);
    assert.equal(defaults.reviewWaitMinutes, 10);
    assert.equal(defaults.milestoneOrdering.enabled, false);
    assert.equal(defaults.milestoneOrdering.missingAssignment, 'warn');
    assert.equal(defaults.instructions.namingRules, false);
    assert.equal(defaults.instructions.supplyChainSafety, true);
    assert.equal(defaults.supplyChain.exactVersions, true);
    assert.equal(defaults.supplyChain.intentionalLockfileChanges, true);
    assert.equal(defaults.supplyChain.disableLifecycleScripts, true);
    assert.equal(defaults.supplyChain.pinCiActions, true);
    assert.equal(defaults.supplyChain.packageAgeDays, 7);
    assert.equal(defaults.supplyChain.highRiskPackageAgeDays, 14);
    assert.equal(defaults.supplyChain.writePackageManagerDefaults, false);
    assert.ok(defaults.priorityLabels.includes('P1-Critical'));
    assert.ok(defaults.statusLabels.includes('S-Ready'));
  });

  it('accepts explicit provider selections and nested policy values', () => {
    const input = defaultFile();
    input.policy.labels.priorities = ['P1', 'P2'];
    input.policy.branch.noWorktree = false;
    input.policy.reviews.adapter = 'mixed';
    input.policy.reviews.waitMinutes = 15;
    input.policy.reviews.localAgents = ['local-check'];
    input.policy.instructions.opencodeCommandAlias = true;

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.deepEqual(result.config.priorityLabels, ['P1', 'P2']);
    assert.equal(result.config.noWorktree, false);
    assert.equal(result.config.reviewAdapter, 'mixed');
    assert.equal(result.config.reviewWaitMinutes, 15);
    assert.deepEqual(result.config.localReviewAgents, ['local-check']);
    assert.equal(result.config.opencodeCommandAlias, true);
  });

  it('normalizes structured and legacy gate policy consistently', () => {
    const input = defaultFile();
    input.policy.gates.definitions = [
      { name: 'unit', kind: 'unit', command: 'node --test', stage: 'pre-pr', required: true, timeoutSeconds: 600, workingDirectory: '.', env: {}, externalService: false },
    ];
    input.policy.gates.qualityGates = ['npm test'];

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.deepEqual(result.config.normalizedPolicy.gates.definitions.map(gate => gate.name), ['unit', 'quality-gate-1']);
    assert.equal(result.config.normalizedPolicy.gates.definitions.find(gate => gate.name === 'quality-gate-1').supplyChainSensitive, true);
  });

  it('accepts nested milestone, instruction, migration, and supply-chain policy', () => {
    const input = defaultFile();
    input.policy.milestoneOrdering = { enabled: true, order: ['M1', 'M2'], missingAssignment: 'block' };
    input.policy.instructions = {
      ...input.policy.instructions,
      namingRules: true,
      promptInjectionWarning: false,
      noCreditWarning: true,
      implementationGuardrails: true,
      supplyChainSafety: true,
    };
    input.policy.migration = { legacyScripts: 'cleanup', compatibilityWrappers: true, cleanupKnownHelpers: true };
    input.policy.supplyChain = {
      exactVersions: true,
      intentionalLockfileChanges: true,
      disableLifecycleScripts: true,
      pinCiActions: false,
      packageAgeDays: 9,
      highRiskPackageAgeDays: 21,
      requireApprovalForUnverifiedRisk: true,
      writePackageManagerDefaults: true,
    };

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.milestoneOrdering.enabled, true);
    assert.deepEqual(result.config.milestoneOrdering.order, ['M1', 'M2']);
    assert.equal(result.config.instructions.namingRules, true);
    assert.equal(result.config.instructions.promptInjectionWarning, false);
    assert.equal(result.config.migration.legacyScripts, 'cleanup');
    assert.equal(result.config.supplyChain.packageAgeDays, 9);
    assert.equal(result.config.supplyChain.pinCiActions, false);
    assert.equal(result.config.supplyChain.writePackageManagerDefaults, true);
  });

  it('accepts local review profiles, custom prompts, context sources, and lane policy', () => {
    const input = defaultFile();
    input.policy.reviews = {
      ...input.policy.reviews,
      adapter: 'shadow',
      profile: 'local-comprehensive',
      severityThreshold: 'medium',
      promptFragments: {
        repository: ['.qube/aie/review-prompts/repository.md'],
        safety: ['builtin:executor-review-safety'],
        style: ['.github/copilot-instructions.md'],
        adapter: ['builtin:local-host-review'],
        reviewer: ['.qube/aie/review-prompts/oracle.md'],
        commandAddendum: ['Focus on concurrency regressions.'],
      },
      contextSources: {
        instructions: ['AGENTS.md', '**/AGENTS.md'],
        requirements: ['docs/spec.md'],
        issues: 'github',
        issueComments: 'github',
        linkedIssues: 'github',
        milestones: 'github',
        pullRequests: 'github',
        prComments: 'github',
        reviewThreads: 'github',
      },
      lanes: [{
        id: 'security',
        required: 'when-matched',
        match: ['**/api/**'],
        severityThreshold: 'medium',
        prompt: ['builtin:security-review', '.qube/aie/review-prompts/security.md'],
        tools: ['rg', 'ast-grep'],
        runner: 'local-host',
      }],
    };

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.reviewAdapter, 'shadow');
    assert.equal(result.config.reviewProfile, 'local-comprehensive');
    assert.equal(result.config.reviewSeverityThreshold, 'medium');
    assert.deepEqual(result.config.reviewPromptFragments.adapter, ['builtin:local-host-review']);
    assert.deepEqual(result.config.reviewPromptFragments.reviewer, ['.qube/aie/review-prompts/oracle.md']);
    assert.deepEqual(result.config.reviewPromptFragments.commandAddendum, ['Focus on concurrency regressions.']);
    assert.deepEqual(result.config.reviewContextSources.requirements, ['docs/spec.md']);
    assert.equal(result.config.reviewContextSources.issueComments, 'github');
    assert.equal(result.config.reviewContextSources.linkedIssues, 'github');
    assert.equal(result.config.reviewContextSources.prComments, 'github');
    assert.equal(result.config.reviewContextSources.reviewThreads, 'github');
    assert.equal(result.config.reviewLanes[0].runner, 'local-host');
  });

  it('rejects unknown fields and unsupported provider kinds with actionable paths', () => {
    const input = defaultFile();
    input.legacyFlatField = true;
    input.providers.work = { kind: 'jira' };
    input.providers.repository = { kind: 'github' };
    input.policy.labels.priorityLabels = ['old-shape'];

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === 'legacyFlatField' && error.kind === 'unknown'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.kind'));
    assert.ok(result.errors.some((error) => error.path === 'providers.repository.kind'));
    assert.ok(result.errors.some((error) => error.path === 'policy.labels.priorityLabels'));
  });

  it('rejects unsupported nested policy values with actionable paths', () => {
    const input = defaultFile();
    input.policy.reviews.waitMinutes = '15';
    input.policy.reviews.adapter = 'unsupported';
    input.policy.milestoneOrdering.missingAssignment = 'required';
    input.policy.supplyChain.packageAgeDays = true;
    input.policy.supplyChain.highRiskPackageAgeDays = 7;

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === 'policy.reviews.waitMinutes'));
    assert.ok(result.errors.some((error) => error.path === 'policy.reviews.adapter'));
    assert.ok(result.errors.some((error) => error.path === 'policy.milestoneOrdering.missingAssignment'));
    assert.ok(result.errors.some((error) => error.path === 'policy.supplyChain.packageAgeDays'));
  });

  it('rejects invalid branch naming policy at config load time', () => {
    const input = defaultFile();
    input.policy.branch.naming = 'issue/<number> missing slug';

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === 'policy.branch.naming'));
  });

  it('throws typed errors instead of falling back to defaults for invalid config files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-config-'));
    writeFileSync(join(repo, 'aie.config.json'), `${JSON.stringify({ version: 1, legacyFlatField: true }, null, 2)}\n`);

    await assert.rejects(
      () => loadConfig(repo),
      (error) => error.name === 'ConfigLoadError'
        && error.message.includes('Failed to load Executor config from')
        && error.message.includes('Next action:')
        && error.errors.some((entry) => entry.path === 'legacyFlatField'),
    );
  });

  it('reports parse errors against the selected legacy config path', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-config-'));
    writeFileSync(join(repo, 'aie.config.json'), '{ invalid json');

    const result = await loadConfigFile(repo);

    assert.equal(result.ok, false);
    assert.equal(result.path, join(repo, 'aie.config.json'));
    assert.ok(result.errors.some((entry) => entry.path === 'aie.config.json' && entry.message.includes('Failed to read or parse aie.config.json')));
  });
});
