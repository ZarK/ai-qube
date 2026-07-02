import type { ExecutorPolicy } from '../core/policy.js';
import { expandGateConfigs } from '../gate_config.js';
import { isSupplyChainSensitive } from '../gate_sensitivity.js';
import type { Config, ConfigFileShape, GateConfig, GatePolicyConfig, WorkProviderSelection } from './types.js';
import { DEFAULT_CONFIG_VERSION } from './types.js';

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
      assignOnStart: true,
      commentOnStart: true,
    },
    shipping: {
      autonomousMode: true,
      mergeStrategy: 'squash',
    },
    reviews: {
      adapter: 'github',
      profile: 'remote-compatible',
      severityThreshold: 'high',
      promptFragments: {
        repository: [],
        safety: [],
        style: [],
        adapter: [],
        reviewer: [],
        commandAddendum: [],
      },
      contextSources: {
        instructions: ['AGENTS.md', '**/AGENTS.md'],
        requirements: ['docs/spec.md', 'products/aie/docs/*.md'],
        issues: 'github',
        issueComments: 'github',
        linkedIssues: 'github',
        milestones: 'github',
        pullRequests: 'github',
        prComments: 'github',
        reviewThreads: 'github',
      },
      lanes: [],
      agents: ['coderabbitai'],
      localAgents: [],
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

function cloneWorkProviderSelection(input: WorkProviderSelection): WorkProviderSelection {
  return {
    kind: input.kind,
    ...(input.jira ? {
      jira: {
        ...(input.jira.baseUrl ? { baseUrl: input.jira.baseUrl } : {}),
        ...(input.jira.projectKey ? { projectKey: input.jira.projectKey } : {}),
        ...(input.jira.jql ? { jql: input.jira.jql } : {}),
        ...(input.jira.requestTimeoutMs ? { requestTimeoutMs: input.jira.requestTimeoutMs } : {}),
        ...(input.jira.workflowSchema ? {
          workflowSchema: {
            ...(input.jira.workflowSchema.statusMap ? { statusMap: { ...input.jira.workflowSchema.statusMap } } : {}),
            ...(input.jira.workflowSchema.openStatusNames ? { openStatusNames: [...input.jira.workflowSchema.openStatusNames] } : {}),
            ...(input.jira.workflowSchema.closedStatusNames ? { closedStatusNames: [...input.jira.workflowSchema.closedStatusNames] } : {}),
            ...(input.jira.workflowSchema.priorityMap ? { priorityMap: { ...input.jira.workflowSchema.priorityMap } } : {}),
            ...(input.jira.workflowSchema.linkRules ? { linkRules: input.jira.workflowSchema.linkRules.map(rule => ({ ...rule })) } : {}),
            ...(input.jira.workflowSchema.sprintField ? { sprintField: input.jira.workflowSchema.sprintField } : {}),
            ...(input.jira.workflowSchema.epicField ? { epicField: input.jira.workflowSchema.epicField } : {}),
          },
        } : {}),
      },
    } : {}),
  };
}

export function cloneConfigFile(input: ConfigFileShape): ConfigFileShape {
  return {
    version: input.version,
    providers: {
      work: cloneWorkProviderSelection(input.providers.work),
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
      reviews: {
        ...input.policy.reviews,
        promptFragments: {
          repository: [...input.policy.reviews.promptFragments.repository],
          safety: [...input.policy.reviews.promptFragments.safety],
          style: [...input.policy.reviews.promptFragments.style],
          adapter: [...input.policy.reviews.promptFragments.adapter],
          reviewer: [...input.policy.reviews.promptFragments.reviewer],
          commandAddendum: [...input.policy.reviews.promptFragments.commandAddendum],
        },
        contextSources: {
          instructions: [...input.policy.reviews.contextSources.instructions],
          requirements: [...input.policy.reviews.contextSources.requirements],
          issues: input.policy.reviews.contextSources.issues,
          issueComments: input.policy.reviews.contextSources.issueComments,
          linkedIssues: input.policy.reviews.contextSources.linkedIssues,
          milestones: input.policy.reviews.contextSources.milestones,
          pullRequests: input.policy.reviews.contextSources.pullRequests,
          prComments: input.policy.reviews.contextSources.prComments,
          reviewThreads: input.policy.reviews.contextSources.reviewThreads,
        },
        lanes: input.policy.reviews.lanes.map(lane => ({
          ...lane,
          match: [...lane.match],
          prompt: [...lane.prompt],
          tools: [...lane.tools],
        })),
        agents: [...input.policy.reviews.agents],
        localAgents: [...input.policy.reviews.localAgents],
      },
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
      adapter: policy.reviews.adapter,
      profile: policy.reviews.profile,
      severityThreshold: policy.reviews.severityThreshold,
      promptFragments: {
        repository: [...policy.reviews.promptFragments.repository],
        safety: [...policy.reviews.promptFragments.safety],
        style: [...policy.reviews.promptFragments.style],
        adapter: [...policy.reviews.promptFragments.adapter],
        reviewer: [...policy.reviews.promptFragments.reviewer],
        commandAddendum: [...policy.reviews.promptFragments.commandAddendum],
      },
      contextSources: {
        instructions: [...policy.reviews.contextSources.instructions],
        requirements: [...policy.reviews.contextSources.requirements],
        issues: policy.reviews.contextSources.issues,
        issueComments: policy.reviews.contextSources.issueComments,
        linkedIssues: policy.reviews.contextSources.linkedIssues,
        milestones: policy.reviews.contextSources.milestones,
        pullRequests: policy.reviews.contextSources.pullRequests,
        prComments: policy.reviews.contextSources.prComments,
        reviewThreads: policy.reviews.contextSources.reviewThreads,
      },
      lanes: policy.reviews.lanes.map(lane => ({
        ...lane,
        match: [...lane.match],
        prompt: [...lane.prompt],
        tools: [...lane.tools],
      })),
      reviewers: [...policy.reviews.agents],
      localReviewers: [...policy.reviews.localAgents],
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
    reviewAdapter: policy.reviews.adapter,
    reviewProfile: policy.reviews.profile,
    reviewSeverityThreshold: policy.reviews.severityThreshold,
    reviewPromptFragments: {
      repository: [...policy.reviews.promptFragments.repository],
      safety: [...policy.reviews.promptFragments.safety],
      style: [...policy.reviews.promptFragments.style],
      adapter: [...policy.reviews.promptFragments.adapter],
      reviewer: [...policy.reviews.promptFragments.reviewer],
      commandAddendum: [...policy.reviews.promptFragments.commandAddendum],
    },
    reviewContextSources: {
      instructions: [...policy.reviews.contextSources.instructions],
      requirements: [...policy.reviews.contextSources.requirements],
      issues: policy.reviews.contextSources.issues,
      issueComments: policy.reviews.contextSources.issueComments,
      linkedIssues: policy.reviews.contextSources.linkedIssues,
      milestones: policy.reviews.contextSources.milestones,
      pullRequests: policy.reviews.contextSources.pullRequests,
      prComments: policy.reviews.contextSources.prComments,
      reviewThreads: policy.reviews.contextSources.reviewThreads,
    },
    reviewLanes: policy.reviews.lanes.map(lane => ({
      ...lane,
      match: [...lane.match],
      prompt: [...lane.prompt],
      tools: [...lane.tools],
    })),
    localReviewAgents: [...policy.reviews.localAgents],
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
