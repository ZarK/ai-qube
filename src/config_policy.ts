import type { Config } from './config';
import { normalizeExecutorPolicy, type ExecutorPolicy } from './core/policy';
import { expandGateConfigs } from './gate_config';
import { isSupplyChainSensitive } from './gate_sensitivity';

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
    reviews: { reviewers: [...config.reviewAgents], waitMinutes: config.reviewWaitMinutes, requestText: config.reviewRequestText },
    gates: { definitions: gates.map(gate => ({ key: gate.name, name: gate.name, command: gate.command, stage: gate.stage, required: gate.required, externalService: gate.externalService, supplyChainSensitive: isSupplyChainSensitive(gate.command) })) },
    audit: { manualUiAudit: config.manualUiAudit, appLaunch: config.uiAuditAppLaunch, target: config.uiAuditTarget },
    instructions: { ...config.instructions, opencodeCommandAlias: config.opencodeCommandAlias },
    migration: { ...config.migration },
    supplyChain: { ...config.supplyChain },
  });
}
