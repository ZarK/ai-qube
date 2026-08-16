const assert = require('node:assert/strict');
const { writeFileSync, mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const { configToFileShape, getDefaults, loadConfig, loadConfigFile, mergeConfigOverlay, overlayConfigPath, validateConfig } = require('../dist/config/index.js');

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
    assert.equal(defaults.modelRouting.primary, 'primary');
    assert.equal(defaults.modelRouting.routes['independent-review'].reviewTier, 'review');
  });

  it('accepts explicit provider selections and nested policy values', () => {
    const input = defaultFile();
    input.providers.work = {
      kind: 'jira',
      jira: {
        projectKey: 'ENG',
        requestTimeoutMs: 20000,
        workflowSchema: {
          statusMap: { Queued: 'ready', Blocked: 'blocked' },
          openStatusNames: ['Queued', 'Blocked'],
          closedStatusNames: ['Done'],
          priorityMap: { P0: 'critical' },
          linkRules: [{ typeName: 'Dependency', inward: 'blocker', outward: 'blockedBy' }],
          sprintField: 'customfield_10020',
          epicField: 'customfield_10014',
        },
      },
    };
    input.policy.labels.priorities = ['P1', 'P2'];
    input.policy.branch.noWorktree = false;
    input.policy.reviews.adapter = 'mixed';
    input.policy.reviews.waitMinutes = 15;
    input.policy.reviews.localAgents = ['local-check'];
    input.policy.instructions.opencodeCommandAlias = true;

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.providers.work.kind, 'jira');
    assert.equal(result.config.providers.work.jira.projectKey, 'ENG');
    assert.equal(result.config.providers.work.jira.requestTimeoutMs, 20000);
    assert.equal(result.config.providers.work.jira.workflowSchema.statusMap.Queued, 'ready');
    assert.equal(result.config.providers.work.jira.workflowSchema.priorityMap.P0, 'critical');
    assert.equal(result.config.providers.work.jira.workflowSchema.linkRules[0].inward, 'blocker');
    assert.equal(result.config.providers.work.jira.workflowSchema.sprintField, 'customfield_10020');
    assert.deepEqual(result.config.priorityLabels, ['P1', 'P2']);
    assert.equal(result.config.noWorktree, false);
    assert.equal(result.config.reviewAdapter, 'mixed');
    assert.equal(result.config.reviewWaitMinutes, 15);
    assert.deepEqual(result.config.localReviewAgents, ['local-check']);
    assert.equal(result.config.opencodeCommandAlias, true);
  });

  it('validates global and per-lane isolated review routes', () => {
    const input = defaultFile();
    input.policy.reviews.models = {
      review: {
        'grok-build': { model: 'grok-4.5', effort: null },
        codex: { model: 'gpt-5.6-luna', effort: 'high' },
      },
      economy: {},
      synthesis: {},
    };
    input.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    input.policy.reviews.lanes = [{
      id: 'code-quality',
      required: 'always',
      match: [],
      severityThreshold: 'high',
      prompt: [],
      tools: [],
      runner: 'local-host',
      rereview: 'delta',
      route: { host: 'codex', tier: 'review', timeoutSeconds: 900, maxTurns: 8 },
    }];

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.reviewRoute.host, 'grok-build');
    assert.equal(result.config.reviewModels.review['grok-build'].model, 'grok-4.5');
    assert.equal(result.config.reviewLanes[0].route.host, 'codex');
    assert.equal(result.config.reviewModels.review.codex.model, 'gpt-5.6-luna');
    assert.equal(result.config.reviewModels.review.codex.effort, 'high');
  });

  it('rejects grok as a review-route or review-model host id', () => {
    const routeInput = defaultFile();
    routeInput.policy.reviews.route = { host: 'grok', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };
    const routeResult = validateConfig(routeInput);
    assert.equal(routeResult.ok, false);
    assert.ok(routeResult.errors.some((error) => error.path === 'policy.reviews.route.host' && /not a host id/.test(error.message) && /grok-build/.test(error.message)));

    const modelsInput = defaultFile();
    modelsInput.policy.reviews.models = {
      review: { grok: { model: 'grok-4.5', effort: null } },
      economy: {},
      synthesis: {},
    };
    const modelsResult = validateConfig(modelsInput);
    assert.equal(modelsResult.ok, false);
    assert.ok(modelsResult.errors.some((error) => error.path === 'policy.reviews.models.review.grok' && /not a host id/.test(error.message) && /grok-build/.test(error.message)));

    const catalogInput = defaultFile();
    catalogInput.policy.modelRouting = {
      primary: 'primary',
      catalog: [{
        id: 'primary',
        host: 'grok',
        transport: 'cli',
        costRank: 1,
        notes: 'retired host id must not validate',
      }],
      routes: {
        'mechanical-implementation': { preferred: 'primary', fallback: ['primary'] },
        'exploration-investigation': { preferred: 'primary', fallback: ['primary'] },
        'independent-review': { reviewTier: 'review' },
        'synthesis-judgment': { preferred: 'primary', fallback: ['primary'] },
      },
    };
    const catalogResult = validateConfig(catalogInput);
    assert.equal(catalogResult.ok, false);
    assert.ok(catalogResult.errors.some((error) => error.path === 'policy.modelRouting.catalog[0].host' && /not a host id/.test(error.message) && /grok-build/.test(error.message)));
  });

  it('validates per-lane carry-forward context modes with conservative defaults', () => {
    const input = defaultFile();
    input.policy.reviews.lanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', carryForwardContext: 'all' },
      { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'security', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'issue-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
    ];

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    const byId = new Map(result.config.reviewLanes.map(lane => [lane.id, lane.carryForwardContext]));
    assert.equal(byId.get('code-quality'), 'all');
    assert.equal(byId.get('performance'), 'scope');
    assert.equal(byId.get('security'), 'config');
    assert.equal(byId.get('issue-compliance'), 'all');
  });

  it('rejects unknown carry-forward context modes', () => {
    const input = defaultFile();
    input.policy.reviews.lanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', carryForwardContext: 'everything' },
    ];

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.lanes[0].carryForwardContext'));
  });

  it('defaults and accepts per-lane model tiers', () => {
    const input = defaultFile();
    input.policy.reviews.lanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'docs-instructions', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host' },
      { id: 'task-record-compliance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', tier: 'review' },
      { id: 'security', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', tier: 'economy' },
    ];

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    const byId = new Map(result.config.reviewLanes.map(lane => [lane.id, lane.tier]));
    assert.equal(byId.get('code-quality'), 'review');
    assert.equal(byId.get('docs-instructions'), 'economy');
    assert.equal(byId.get('task-record-compliance'), 'review');
    assert.equal(byId.get('security'), 'economy');

    const invalid = defaultFile();
    invalid.policy.reviews.lanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', tier: 'cheap' },
    ];
    const invalidResult = validateConfig(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(invalidResult.errors.some(error => error.path === 'policy.reviews.lanes[0].tier'));
  });

  it('parses per-lane suppress globs, advisory caps, and opt-outs', () => {
    const input = defaultFile();
    input.policy.reviews.lanes = [
      { id: 'code-quality', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', suppress: ['vendor/**'], maxAdvisoryFindings: 2 },
      { id: 'performance', required: 'always', match: [], severityThreshold: 'high', prompt: [], tools: [], runner: 'local-host', optOut: true },
    ];
    const result = validateConfig(input);
    assert.equal(result.ok, true);
    const byId = new Map(result.config.reviewLanes.map(lane => [lane.id, lane]));
    assert.deepEqual(byId.get('code-quality').suppress, ['vendor/**']);
    assert.equal(byId.get('code-quality').maxAdvisoryFindings, 2);
    assert.equal(byId.get('code-quality').optOut, false);
    assert.equal(byId.get('performance').optOut, true);
  });

  it('validates review concurrency bounds', () => {
    const valid = defaultFile();
    valid.policy.reviews.concurrency = 4;
    const validResult = validateConfig(valid);
    assert.equal(validResult.ok, true);
    assert.equal(validResult.config.reviewConcurrency, 4);

    const invalid = defaultFile();
    invalid.policy.reviews.concurrency = 0;
    const invalidResult = validateConfig(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(invalidResult.errors.some(error => error.path === 'policy.reviews.concurrency'));
  });

  it('validates the review failover policy surface', () => {
    const valid = defaultFile();
    valid.policy.reviews.failover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const validResult = validateConfig(valid);
    assert.equal(validResult.ok, true);
    assert.deepEqual(validResult.config.reviewFailover, { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } });

    const absent = validateConfig(defaultFile());
    assert.equal(absent.ok, true);
    assert.equal(absent.config.reviewFailover, null);

    const zeroFaults = defaultFile();
    zeroFaults.policy.reviews.failover = { faults: 0, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const zeroResult = validateConfig(zeroFaults);
    assert.equal(zeroResult.ok, false);
    assert.ok(zeroResult.errors.some(error => error.path === 'policy.reviews.failover.faults'));

    const missingRoute = defaultFile();
    missingRoute.policy.reviews.failover = { faults: 2 };
    const missingRouteResult = validateConfig(missingRoute);
    assert.equal(missingRouteResult.ok, false);
    assert.ok(missingRouteResult.errors.some(error => error.path === 'policy.reviews.failover.route'));

    const badHost = defaultFile();
    badHost.policy.reviews.failover = { faults: 2, route: { host: 'mystery-host', tier: 'review', timeoutSeconds: 600, maxTurns: 8 } };
    const badHostResult = validateConfig(badHost);
    assert.equal(badHostResult.ok, false);
    assert.ok(badHostResult.errors.some(error => error.path === 'policy.reviews.failover.route.host'));

    const unknownKey = defaultFile();
    unknownKey.policy.reviews.failover = { faults: 2, route: { host: 'codex', tier: 'review', timeoutSeconds: 600, maxTurns: 8 }, retryDelay: 5 };
    const unknownKeyResult = validateConfig(unknownKey);
    assert.equal(unknownKeyResult.ok, false);
    assert.ok(unknownKeyResult.errors.some(error => error.path.startsWith('policy.reviews.failover')));
  });

  it('rejects turn budgets below the routed inspection floor', () => {
    const input = defaultFile();
    input.policy.reviews.route = { host: 'grok-build', tier: 'review', timeoutSeconds: 600, maxTurns: 2 };

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.route.maxTurns'));
  });

  it('rejects unsupported review route hosts and unsafe execution bounds', () => {
    const input = defaultFile();
    input.policy.reviews.route = { host: 'shell', tier: 'review', timeoutSeconds: 5, maxTurns: 50 };

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.route.host'));
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.route.timeoutSeconds'));
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.route.maxTurns'));
  });

  it('rejects a review route host id that is not registered in the review host adapter registry, naming it', () => {
    const input = defaultFile();
    input.policy.reviews.route = { host: 'mystery-review-host', tier: 'review', timeoutSeconds: 600, maxTurns: 8 };

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    const hostError = result.errors.find(error => error.path === 'policy.reviews.route.host');
    assert.ok(hostError, 'an unregistered review route host must fail with a named reason');
    assert.match(hostError.message, /mystery-review-host/);
    assert.match(hostError.message, /registered review host adapter/);
    assert.match(hostError.message, /codex/);
    assert.match(hostError.message, /grok/);
  });

  it('validates non-secret connection settings against the selected provider contract', () => {
    const valid = defaultFile();
    valid.providers.work = {
      kind: 'linear',
      connection: { teamId: 'engineering' },
    };
    const validResult = validateConfig(valid);
    assert.equal(validResult.ok, true);
    assert.deepEqual(validResult.config.providers.work.connection, { teamId: 'engineering' });

    const invalid = defaultFile();
    invalid.providers.work = {
      kind: 'linear',
      connection: {
        teemId: 'misspelled',
        apiToken: 'must-not-be-stored',
      },
    };
    const invalidResult = validateConfig(invalid);
    assert.equal(invalidResult.ok, false);
    assert.ok(invalidResult.errors.some(error => error.path === 'providers.work.connection.teemId' && error.kind === 'unknown'));
    assert.ok(invalidResult.errors.some(error => error.path === 'providers.work.connection.apiToken' && error.kind === 'invalid'));

    const jenkinsCiProvider = defaultFile();
    jenkinsCiProvider.providers.ci = { kind: 'jenkins', connection: { baseUrl: 'https://jenkins.example.com', user: 'ci' } };
    const jenkinsResult = validateConfig(jenkinsCiProvider);
    assert.equal(jenkinsResult.ok, true);
    assert.equal(jenkinsResult.config.providers.ci.kind, 'jenkins');
    assert.deepEqual(jenkinsResult.config.providers.ci.connection, { baseUrl: 'https://jenkins.example.com', user: 'ci' });

    const gitlabCiProvider = defaultFile();
    gitlabCiProvider.providers.ci = { kind: 'gitlab', connection: { baseUrl: 'https://gitlab.example.com', projectId: 'acme/qube' } };
    const gitlabResult = validateConfig(gitlabCiProvider);
    assert.equal(gitlabResult.ok, true);
    assert.equal(gitlabResult.config.providers.ci.kind, 'gitlab');

    const probeOnlyJenkins = defaultFile();
    probeOnlyJenkins.providers.connections = { jenkins: { baseUrl: 'https://jenkins.example.com', user: 'ci' } };
    const probeOnlyResult = validateConfig(probeOnlyJenkins);
    assert.equal(probeOnlyResult.ok, true);
    assert.deepEqual(probeOnlyResult.config.providers.connections.jenkins, { baseUrl: 'https://jenkins.example.com', user: 'ci' });

    const wrongType = defaultFile();
    wrongType.providers.work = { kind: 'linear', connection: { teamId: false } };
    const wrongTypeResult = validateConfig(wrongType);
    assert.equal(wrongTypeResult.ok, false);
    assert.ok(wrongTypeResult.errors.some(error => error.path === 'providers.work.connection.teamId' && error.kind === 'invalid'));
  });

  it('accepts every supported work, review, and CI permutation', () => {
    const workKinds = ['github', 'gitlab', 'linear', 'jira'];
    const reviewKinds = ['github', 'gitlab'];
    const ciKinds = ['github', 'gitlab', 'jenkins'];
    for (const work of workKinds) {
      for (const review of reviewKinds) {
        for (const ci of ciKinds) {
          const input = defaultFile();
          input.providers.work = { kind: work };
          input.providers.review = { kind: review };
          input.providers.ci = { kind: ci };
          const result = validateConfig(input);
          assert.equal(result.ok, true, `${work}/${review}/${ci} must be expressible`);
          assert.equal(result.config.providers.work.kind, work);
          assert.equal(result.config.providers.review.kind, review);
          assert.equal(result.config.providers.ci.kind, ci);
        }
      }
    }
  });

  it('rejects unknown work, review, and CI kinds without coercing to GitHub', () => {
    const unknownWork = defaultFile();
    unknownWork.providers.work = { kind: 'azure-devops' };
    const workResult = validateConfig(unknownWork);
    assert.equal(workResult.ok, false);
    assert.equal(workResult.config, undefined);
    assert.ok(workResult.errors.some(error => error.path === 'providers.work.kind' && /azure-devops/.test(error.message)));

    const unknownReview = defaultFile();
    unknownReview.providers.review = { kind: 'jenkins' };
    const reviewResult = validateConfig(unknownReview);
    assert.equal(reviewResult.ok, false);
    assert.equal(reviewResult.config, undefined);
    assert.ok(reviewResult.errors.some(error => error.path === 'providers.review.kind' && /jenkins/.test(error.message)));

    const unknownCi = defaultFile();
    unknownCi.providers.ci = { kind: 'circleci' };
    const ciResult = validateConfig(unknownCi);
    assert.equal(ciResult.ok, false);
    assert.equal(ciResult.config, undefined);
    assert.ok(ciResult.errors.some(error => error.path === 'providers.ci.kind' && /circleci/.test(error.message)));

    const localCi = defaultFile();
    localCi.providers.ci = { kind: 'local' };
    const localResult = validateConfig(localCi);
    assert.equal(localResult.ok, false);
    assert.equal(localResult.config, undefined);
    assert.ok(localResult.errors.some(error => error.path === 'providers.ci.kind' && /local/.test(error.message)));
  });

  it('preserves omitted Jira workflow schema fields so adapter defaults still apply', () => {
    const input = defaultFile();
    input.providers.work = {
      kind: 'jira',
      jira: {
        workflowSchema: {
          sprintField: 'customfield_10020',
        },
      },
    };

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.providers.work.kind, 'jira');
    assert.equal(result.config.providers.work.jira.workflowSchema.sprintField, 'customfield_10020');
    assert.equal(Object.hasOwn(result.config.providers.work.jira.workflowSchema, 'linkRules'), false);
    assert.equal(Object.hasOwn(result.config.providers.work.jira.workflowSchema, 'openStatusNames'), false);
    assert.equal(Object.hasOwn(result.config.providers.work.jira.workflowSchema, 'closedStatusNames'), false);
  });

  it('accepts Jira JQL live-read configuration without credential values', () => {
    const input = defaultFile();
    input.providers.work = {
      kind: 'jira',
      jira: {
        jql: 'project = ENG AND resolution = Unresolved ORDER BY updated DESC',
      },
    };

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.equal(result.config.providers.work.jira.jql, 'project = ENG AND resolution = Unresolved ORDER BY updated DESC');
    assert.equal(Object.hasOwn(result.config.providers.work.jira, 'baseUrl'), false);
    assert.equal(Object.hasOwn(result.config.providers.work.jira, 'workflowSchema'), false);
    assert.equal(Object.hasOwn(result.config.providers.work.jira, 'email'), false);
    assert.equal(Object.hasOwn(result.config.providers.work.jira, 'apiToken'), false);
  });

  it('rejects Jira credential environment indirection in config', () => {
    const input = defaultFile();
    input.providers.work = {
      kind: 'jira',
      jira: {
        baseUrl: 'https://jira.example.com',
        projectKey: 'ENG',
        emailEnv: 'AIE_JIRA_EMAIL',
        apiTokenEnv: 'AIE_JIRA_TOKEN',
      },
    };

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.baseUrl' && error.kind === 'unknown'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.emailEnv' && error.kind === 'unknown'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.apiTokenEnv' && error.kind === 'unknown'));
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
        runner: 'local-command',
        command: 'aie:fixture-local-review',
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
    assert.equal(result.config.reviewLanes[0].runner, 'local-command');
    assert.equal(result.config.reviewLanes[0].command, 'aie:fixture-local-review');
  });

  it('rejects unknown fields and unsupported provider kinds with actionable paths', () => {
    const input = defaultFile();
    input.legacyFlatField = true;
    input.providers.work = { kind: 'azure-devops' };
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
    input.providers.work = {
      kind: 'jira',
      jira: {
        workflowSchema: {
          statusMap: { Queued: 'queued' },
          priorityMap: { P0: 'urgent' },
          linkRules: [{ typeName: 'Dependency', inward: 'waits-on', outward: 'blockedBy' }],
        },
        requestTimeoutMs: 0,
      },
    };
    input.policy.reviews.waitMinutes = '15';
    input.policy.reviews.adapter = 'unsupported';
    input.policy.milestoneOrdering.missingAssignment = 'required';
    input.policy.supplyChain.packageAgeDays = true;
    input.policy.supplyChain.highRiskPackageAgeDays = 7;

    const result = validateConfig(input);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.workflowSchema.statusMap.Queued'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.workflowSchema.priorityMap.P0'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.workflowSchema.linkRules[0].inward'));
    assert.ok(result.errors.some((error) => error.path === 'providers.work.jira.requestTimeoutMs'));
    assert.ok(result.errors.some((error) => error.path === 'policy.reviews.waitMinutes'));
    assert.ok(result.errors.some((error) => error.path === 'policy.reviews.adapter'));
    assert.ok(result.errors.some((error) => error.path === 'policy.milestoneOrdering.missingAssignment'));
    assert.ok(result.errors.some((error) => error.path === 'policy.supplyChain.packageAgeDays'));
  });

  it('parses reviewModels tiers and rejects invalid tier bindings', () => {
    const input = defaultFile();
    input.policy.reviews.models = {
      review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } },
      economy: { codex: { model: 'gpt-5-mini' } },
    };

    const result = validateConfig(input);

    assert.equal(result.ok, true);
    assert.deepEqual(result.config.reviewModels.review.codex, { model: 'gpt-5.5-codex', effort: 'high' });
    assert.deepEqual(result.config.reviewModels.economy.codex, { model: 'gpt-5-mini', effort: null });
    assert.deepEqual(result.config.reviewModels.synthesis, {});

    const invalid = defaultFile();
    invalid.policy.reviews.models = { review: { codex: { model: 'gpt-5.5-codex', effort: 'max' } }, economy: { codex: { model: '' } }, synthesis: { codex: { model: 'bad"model"\ninjection' } } };

    const invalidResult = validateConfig(invalid);

    assert.equal(invalidResult.ok, false);
    assert.ok(invalidResult.errors.some((error) => error.path === 'policy.reviews.models.review.codex.effort'));
    assert.ok(invalidResult.errors.some((error) => error.path === 'policy.reviews.models.economy.codex.model'));
    assert.ok(invalidResult.errors.some((error) => error.path === 'policy.reviews.models.synthesis.codex.model'));
  });

  it('deep-clones review model bindings in cloneConfigFile', () => {
    const { cloneConfigFile } = require('../dist/config/index.js');
    const original = defaultFile();
    original.policy.reviews.models = { review: { codex: { model: 'gpt-5.5-codex', effort: 'high' } }, economy: {}, synthesis: {} };

    const cloned = cloneConfigFile(original);
    cloned.policy.reviews.models.review.codex.model = 'mutated-model';

    assert.equal(original.policy.reviews.models.review.codex.model, 'gpt-5.5-codex');
  });

  it('accepts github review publisher secret references and rejects embedded secrets', () => {
    const validApp = defaultFile();
    validApp.providers.review = {
      kind: 'github',
      publisher: {
        mode: 'github-app',
        githubApp: {
          appId: '123',
          installationId: '456',
          privateKeyEnv: 'QUBE_GITHUB_APP_PRIVATE_KEY',
        },
      },
    };
    const validAppResult = validateConfig(validApp);
    assert.equal(validAppResult.ok, true);
    assert.equal(validAppResult.config.providers.review.publisher.mode, 'github-app');
    assert.equal(validAppResult.config.providers.review.publisher.githubApp.privateKeyEnv, 'QUBE_GITHUB_APP_PRIVATE_KEY');

    const validToken = defaultFile();
    validToken.providers.review = {
      kind: 'github',
      publisher: {
        mode: 'token',
        token: { env: 'QUBE_GITHUB_REVIEW_TOKEN' },
      },
    };
    const validTokenResult = validateConfig(validToken);
    assert.equal(validTokenResult.ok, true);
    assert.equal(validTokenResult.config.providers.review.publisher.mode, 'token');

    const embedded = defaultFile();
    embedded.providers.review = {
      kind: 'github',
      publisher: {
        mode: 'token',
        token: { env: 'github_pat_this_is_not_an_env_name_abcdefghijklmnop' },
      },
    };
    const embeddedResult = validateConfig(embedded);
    assert.equal(embeddedResult.ok, false);
    assert.ok(embeddedResult.errors.some((error) => error.path === 'providers.review.publisher.token.env'));

    const pemEnv = defaultFile();
    pemEnv.providers.review = {
      kind: 'github',
      publisher: {
        mode: 'github-app',
        githubApp: {
          appId: '123',
          installationId: '456',
          privateKeyEnv: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        },
      },
    };
    const pemResult = validateConfig(pemEnv);
    assert.equal(pemResult.ok, false);
    assert.ok(pemResult.errors.some((error) => error.path === 'providers.review.publisher.githubApp.privateKeyEnv'));
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

  it('deep-merges a local overlay onto a base object without mutating either input', () => {
    const base = { providers: { review: { kind: 'github' } }, version: 1 };
    const overlay = { providers: { review: { publisher: { mode: 'github-app' } } } };

    const merged = mergeConfigOverlay(base, overlay);

    assert.deepEqual(merged, { providers: { review: { kind: 'github', publisher: { mode: 'github-app' } } }, version: 1 });
    assert.equal(base.providers.review.publisher, undefined);
  });

  it('replaces arrays and non-object leaves wholesale instead of merging them', () => {
    const base = { policy: { labels: { priorities: ['P1'] } }, kind: 'a' };
    const overlay = { policy: { labels: { priorities: ['P9'] } }, kind: 'b' };

    const merged = mergeConfigOverlay(base, overlay);

    assert.deepEqual(merged.policy.labels.priorities, ['P9']);
    assert.equal(merged.kind, 'b');
  });

  it('derives the local overlay filename by inserting .local before the extension', () => {
    assert.equal(overlayConfigPath(join('repo', '.qube', 'aie', 'config.json')), join('repo', '.qube', 'aie', 'config.local.json'));
    assert.equal(overlayConfigPath(join('repo', 'aie.config.json')), join('repo', 'aie.config.local.json'));
  });

  it('merges a working-tree publisher config from a local, never-committed overlay', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-config-overlay-'));
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify({ version: 1, providers: { review: { kind: 'github' } } }, null, 2)}\n`);
    writeFileSync(join(repo, '.qube', 'aie', 'config.local.json'), `${JSON.stringify({
      providers: {
        review: {
          publisher: {
            mode: 'github-app',
            githubApp: { appId: '4573671', installationId: '153271303', privateKeyEnv: 'QUBE_REVIEW_PUBLISHER_PRIVATE_KEY' },
          },
        },
      },
    }, null, 2)}\n`);

    const result = await loadConfigFile(repo);

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.config.providers.review.kind, 'github');
    assert.deepEqual(result.config.providers.review.publisher, {
      mode: 'github-app',
      githubApp: { appId: '4573671', installationId: '153271303', privateKeyEnv: 'QUBE_REVIEW_PUBLISHER_PRIVATE_KEY' },
    });
  });

  it('resolves config from the overlay alone when no committed config file is present', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-config-overlay-only-'));
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.local.json'), `${JSON.stringify({ version: 1, providers: { review: { kind: 'github', publisher: { mode: 'token', token: { env: 'QUBE_REVIEW_TOKEN' } } } } }, null, 2)}\n`);

    const result = await loadConfigFile(repo);

    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.config.providers.review.publisher.mode, 'token');
  });

  it('reports parse errors against the local overlay path without discarding a valid base config', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'aie-config-overlay-invalid-'));
    mkdirSync(join(repo, '.qube', 'aie'), { recursive: true });
    writeFileSync(join(repo, '.qube', 'aie', 'config.json'), `${JSON.stringify({ version: 1 }, null, 2)}\n`);
    writeFileSync(join(repo, '.qube', 'aie', 'config.local.json'), '{ invalid json');

    const result = await loadConfigFile(repo);

    assert.equal(result.ok, false);
    assert.ok(result.errors.some((entry) => entry.path.endsWith('config.local.json') && entry.message.includes('local overlay')));
  });
});

describe('review mode config', () => {
  it('accepts external, host, and isolated review modes', () => {
    for (const mode of ['external', 'host', 'isolated']) {
      const file = defaultFile();
      file.policy.reviews.mode = mode;
      const result = validateConfig(file);
      assert.equal(result.ok, true, result.errors.map(error => error.message).join('\n'));
      assert.equal(result.config.reviewMode, mode);
    }
  });

  it('rejects an unknown review mode', () => {
    const file = defaultFile();
    file.policy.reviews.mode = 'codex';
    const result = validateConfig(file);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(error => error.path === 'policy.reviews.mode' && error.message.includes('external, host, or isolated')));
  });
});
