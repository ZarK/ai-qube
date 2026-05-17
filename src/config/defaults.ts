import type { ExecutorPolicy } from '../core/policy';
import { expandGateConfigs } from '../gate_config';
import { isSupplyChainSensitive } from '../gate_sensitivity';
import type { Config, ConfigFileShape, GateConfig, GatePolicyConfig } from './types';
import { DEFAULT_CONFIG_VERSION } from './types';

export const DEFAULT_CONFIG_FILE: ConfigFileShape = {
  version: DEFAULT_CONFIG_VERSION,
  providers: {
    work: { kind: 'github' },
    review: { kind: 'github' },
    repository: { kind: 'local-git' },
    ci: { kind: 'github' },
    layout: { kind: 'local' },
    capabilities: {
      work: true,
      review: true,
      repository: true,
      ci: true,
      layout: true,
    },
  },
  policy: {
    labels: {
      priorities: ['P1-Critical', 'P2-High', 'P3-Medium', 'P4-Low'],
      statuses: ['S-Ready', 'S-InProgress', 'S-Blocked', 'S-Blocking'],
      components: [
        'C-Architecture',
        'C-Backend',
        'C-Frontend',
        'C-Testing',
        'C-Tooling',
        'C-Docs',
        'C-DevEx',
        'C-CI',
        'C-Security',
        'C-Data',
      ],
    },
    milestoneOrdering: {
      enabled: false,
      order: [],
      missingAssignment: 'warn',
    },
    branch: {
      naming: 'issue/<number>-<slug>',
      baseBranch: 'main',
      baseRemote: 'origin',
      noWorktree: true,
      blockOnOpenPRs: true,
      requireBaseBranchFreshness: true,
      ignoredAutomationAuthors: ['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]'],
    },
    lifecycle: {
      assignOnStart: false,
      commentOnStart: false,
    },
    shipping: {
      autonomousMode: true,
      mergeStrategy: 'squash',
    },
    reviews: {
      agents: [],
      waitMinutes: 10,
      requestText: '',
    },
    gates: {
      definitions: [],
      qualityGates: [],
      qualityControl: false,
    },
    audit: {
      manualUiAudit: true,
      appLaunch: '',
      target: '',
    },
    instructions: {
      opencodeCommandAlias: false,
      namingRules: false,
      promptInjectionWarning: true,
      noCreditWarning: true,
      implementationGuardrails: true,
      supplyChainSafety: true,
    },
    migration: {
      legacyScripts: 'preserve',
      compatibilityWrappers: false,
      cleanupKnownHelpers: false,
    },
    supplyChain: {
      exactVersions: true,
      intentionalLockfileChanges: true,
      disableLifecycleScripts: true,
      pinCiActions: true,
      packageAgeDays: 7,
      highRiskPackageAgeDays: 14,
      requireApprovalForUnverifiedRisk: true,
      writePackageManagerDefaults: false,
    },
  },
};

export function cloneGate(gate: GateConfig): GateConfig {
  return { ...gate, env: { ...gate.env } };
}

export function cloneConfigFile(input: ConfigFileShape): ConfigFileShape {
  return {
    version: input.version,
    providers: {
      work: { ...input.providers.work },
      review: { ...input.providers.review },
      repository: { ...input.providers.repository },
      ci: { ...input.providers.ci },
      layout: { ...input.providers.layout },
      capabilities: { ...input.providers.capabilities },
    },
    policy: {
      labels: {
        priorities: [...input.policy.labels.priorities],
        statuses: [...input.policy.labels.statuses],
        components: [...input.policy.labels.components],
      },
      milestoneOrdering: { ...input.policy.milestoneOrdering, order: [...input.policy.milestoneOrdering.order] },
      branch: { ...input.policy.branch, ignoredAutomationAuthors: [...input.policy.branch.ignoredAutomationAuthors] },
      lifecycle: { ...input.policy.lifecycle },
      shipping: { ...input.policy.shipping },
      reviews: { ...input.policy.reviews, agents: [...input.policy.reviews.agents] },
      gates: {
        definitions: input.policy.gates.definitions.map(cloneGate),
        qualityGates: [...input.policy.gates.qualityGates],
        qualityControl: input.policy.gates.qualityControl,
      },
      audit: { ...input.policy.audit },
      instructions: { ...input.policy.instructions },
      migration: { ...input.policy.migration },
      supplyChain: { ...input.policy.supplyChain },
    },
  };
}

function labelObjects(names: string[]): Array<{ name: string; description: string; color: string }> {
  return names.map(name => ({ name, description: '', color: '' }));
}

function policyGateDefinitions(gates: GatePolicyConfig): ExecutorPolicy['gates']['definitions'] {
  return expandGateConfigs(gates.definitions.map(cloneGate), gates.qualityGates, gates.qualityControl)
    .map(gate => ({
      key: gate.name,
      name: gate.name,
      command: gate.command,
      stage: gate.stage,
      required: gate.required,
      externalService: gate.externalService,
      supplyChainSensitive: isSupplyChainSensitive(gate.command),
    }));
}

export function configFromFile(input: ConfigFileShape): Config {
  const file = cloneConfigFile(input);
  const policy = file.policy;
  const normalizedPolicy: ExecutorPolicy = {
    labels: {
      priorities: labelObjects(policy.labels.priorities),
      statuses: labelObjects(policy.labels.statuses),
      components: labelObjects(policy.labels.components),
    },
    milestoneOrdering: { ...policy.milestoneOrdering, order: [...policy.milestoneOrdering.order] },
    branch: {
      pattern: policy.branch.naming,
      baseRemote: policy.branch.baseRemote,
      baseBranch: policy.branch.baseBranch,
      requirePrimaryCheckout: policy.branch.noWorktree,
      requireFreshBase: policy.branch.requireBaseBranchFreshness,
      blockOnOpenReviews: policy.branch.blockOnOpenPRs,
      ignoredReviewAuthors: [...policy.branch.ignoredAutomationAuthors],
    },
    lifecycle: {
      assignOnStart: policy.lifecycle.assignOnStart,
      commentOnStart: policy.lifecycle.commentOnStart,
      autonomousMode: policy.shipping.autonomousMode,
    },
    shipping: { ...policy.shipping },
    reviews: {
      reviewers: [...policy.reviews.agents],
      waitMinutes: policy.reviews.waitMinutes,
      requestText: policy.reviews.requestText,
    },
    gates: { definitions: policyGateDefinitions(policy.gates) },
    audit: {
      manualUiAudit: policy.audit.manualUiAudit,
      appLaunch: policy.audit.appLaunch,
      target: policy.audit.target,
    },
    instructions: { ...policy.instructions },
    migration: { ...policy.migration },
    supplyChain: { ...policy.supplyChain },
  };
  return {
    ...file,
    normalizedPolicy,
    priorityLabels: [...policy.labels.priorities],
    statusLabels: [...policy.labels.statuses],
    componentLabels: [...policy.labels.components],
    milestoneOrdering: { ...policy.milestoneOrdering, order: [...policy.milestoneOrdering.order] },
    branchNaming: policy.branch.naming,
    baseBranch: policy.branch.baseBranch,
    baseRemote: policy.branch.baseRemote,
    noWorktree: policy.branch.noWorktree,
    blockOnOpenPRs: policy.branch.blockOnOpenPRs,
    requireBaseBranchFreshness: policy.branch.requireBaseBranchFreshness,
    autonomousMode: policy.shipping.autonomousMode,
    assignOnStart: policy.lifecycle.assignOnStart,
    commentOnStart: policy.lifecycle.commentOnStart,
    ignoredAutomationAuthors: [...policy.branch.ignoredAutomationAuthors],
    reviewAgents: [...policy.reviews.agents],
    reviewWaitMinutes: policy.reviews.waitMinutes,
    reviewRequestText: policy.reviews.requestText,
    opencodeCommandAlias: policy.instructions.opencodeCommandAlias,
    manualUiAudit: policy.audit.manualUiAudit,
    uiAuditAppLaunch: policy.audit.appLaunch,
    uiAuditTarget: policy.audit.target,
    gates: policy.gates.definitions.map(cloneGate),
    qualityGates: [...policy.gates.qualityGates],
    qualityControl: policy.gates.qualityControl,
    instructions: { ...policy.instructions },
    supplyChain: { ...policy.supplyChain },
    migration: { ...policy.migration },
  };
}

export function configToFileShape(config: Config): ConfigFileShape {
  return cloneConfigFile({ version: config.version, providers: config.providers, policy: config.policy });
}

export function formatConfigFile(config: Config = getDefaults()): string {
  return `${JSON.stringify(configToFileShape(config), null, 2)}\n`;
}

export function getDefaults(): Config {
  return configFromFile(DEFAULT_CONFIG_FILE);
}
