import type { Config } from './config/index.js';
import { normalizeExecutorPolicy, type ExecutorPolicy, type ReviewContextSources } from './core/policy.js';
import { expandGateConfigs } from './gate_config.js';
import { isSupplyChainSensitive } from './gate_sensitivity.js';

export function prThreadContextMode(sources: ReviewContextSources): ReviewContextSources['reviewThreads'] {
  return sources.reviewThreads;
}

export function configToExecutorPolicy(config: Config): ExecutorPolicy {
  const gates = expandGateConfigs(config.gates, config.qualityGates, config.qualityControl);
  return normalizeExecutorPolicy({
    labels: {
      priorities: config.priorityLabels.map(name => ({ name, description: '', color: '' })),
      statuses: config.statusLabels.map(name => ({ name, description: '', color: '' })),
      components: config.componentLabels.map(name => ({ name, description: '', color: '' })),
    },
    milestoneOrdering: { ...config.milestoneOrdering, order: [...config.milestoneOrdering.order] },
    branch: {
      pattern: config.branchNaming,
      baseRemote: config.baseRemote,
      baseBranch: config.baseBranch,
      requirePrimaryCheckout: config.noWorktree,
      requireFreshBase: config.requireBaseBranchFreshness,
      blockOnOpenReviews: config.blockOnOpenPRs,
      ignoredReviewAuthors: [...config.ignoredAutomationAuthors],
    },
    lifecycle: { assignOnStart: config.assignOnStart, commentOnStart: config.commentOnStart, autonomousMode: config.autonomousMode },
    shipping: { ...config.normalizedPolicy.shipping, autonomousMode: config.autonomousMode },
    reviews: {
      adapter: config.reviewAdapter,
      profile: config.reviewProfile,
      severityThreshold: config.reviewSeverityThreshold,
      promptFragments: {
        repository: [...config.reviewPromptFragments.repository],
        safety: [...config.reviewPromptFragments.safety],
        style: [...config.reviewPromptFragments.style],
        adapter: [...config.reviewPromptFragments.adapter],
        reviewer: [...config.reviewPromptFragments.reviewer],
        commandAddendum: [...config.reviewPromptFragments.commandAddendum],
      },
      contextSources: {
        instructions: [...config.reviewContextSources.instructions],
        requirements: [...config.reviewContextSources.requirements],
        issues: config.reviewContextSources.issues,
        issueComments: config.reviewContextSources.issueComments,
        linkedIssues: config.reviewContextSources.linkedIssues,
        milestones: config.reviewContextSources.milestones,
        pullRequests: config.reviewContextSources.pullRequests,
        prComments: config.reviewContextSources.prComments,
        reviewThreads: config.reviewContextSources.reviewThreads,
      },
      lanes: config.reviewLanes.map(lane => ({ ...lane, match: [...lane.match], prompt: [...lane.prompt], tools: [...lane.tools] })),
      reviewers: [...config.reviewAgents],
      localReviewers: [...config.localReviewAgents],
      waitMinutes: config.reviewWaitMinutes,
      requestText: config.reviewRequestText,
    },
    gates: { definitions: gates.map(gate => ({ key: gate.name, name: gate.name, command: gate.command, stage: gate.stage, required: gate.required, externalService: gate.externalService, supplyChainSensitive: isSupplyChainSensitive(gate.command) })) },
    audit: { manualUiAudit: config.manualUiAudit, appLaunch: config.uiAuditAppLaunch, target: config.uiAuditTarget },
    instructions: { ...config.instructions, opencodeCommandAlias: config.opencodeCommandAlias },
    migration: { ...config.migration },
    supplyChain: { ...config.supplyChain },
  });
}
