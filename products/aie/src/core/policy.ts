import type { GateDefinition } from './gate_evidence.js';

export interface PolicyLabel {
  name: string;
  description: string;
  color: string;
}

export interface LabelPolicy {
  priorities: PolicyLabel[];
  statuses: PolicyLabel[];
  components: PolicyLabel[];
}

export type MissingMilestonePolicy = 'ignore' | 'warn' | 'block';

export interface MilestoneOrderingPolicy {
  enabled: boolean;
  order: string[];
  missingAssignment: MissingMilestonePolicy;
}

export interface BranchPolicy {
  pattern: string;
  baseRemote: string;
  baseBranch: string;
  requirePrimaryCheckout: boolean;
  requireFreshBase: boolean;
  blockOnOpenReviews: boolean;
  ignoredReviewAuthors: string[];
}

export interface LifecyclePolicy {
  assignOnStart: boolean;
  commentOnStart: boolean;
  autonomousMode: boolean;
}

export interface ShippingPolicy {
  autonomousMode: boolean;
  mergeStrategy: 'squash' | 'merge' | 'rebase';
}

export type ReviewAdapterKind = 'github' | 'remote' | 'local' | 'mixed' | 'shadow';
export type ReviewProfileKind = 'remote-compatible' | 'local-standard' | 'local-comprehensive' | 'local-shadow';
export type ReviewSeverityThreshold = 'low' | 'medium' | 'high' | 'critical';
export type ReviewLaneRequiredMode = 'always' | 'when-matched' | 'optional' | 'shadow';

export interface ReviewPromptFragments {
  repository: string[];
  safety: string[];
  style: string[];
  adapter: string[];
  reviewer: string[];
  commandAddendum: string[];
}

export interface ReviewContextSources {
  instructions: string[];
  requirements: string[];
  issues: 'github' | 'disabled';
  issueComments: 'github' | 'disabled';
  linkedIssues: 'github' | 'disabled';
  milestones: 'github' | 'disabled';
  pullRequests: 'github' | 'disabled';
  prComments: 'github' | 'disabled';
  reviewThreads: 'github' | 'disabled';
}

export interface ReviewLanePolicy {
  id: string;
  required: ReviewLaneRequiredMode;
  match: string[];
  severityThreshold: ReviewSeverityThreshold;
  prompt: string[];
  tools: string[];
  runner: 'github-comment' | 'github-reviewer' | 'local-command' | 'local-host' | 'manual-evidence';
  command?: string;
}

export interface ReviewPolicy {
  adapter: ReviewAdapterKind;
  profile: ReviewProfileKind;
  severityThreshold: ReviewSeverityThreshold;
  promptFragments: ReviewPromptFragments;
  contextSources: ReviewContextSources;
  lanes: ReviewLanePolicy[];
  reviewers: string[];
  localReviewers: string[];
  waitMinutes: number;
  requestText: string;
}

export interface GatePolicy {
  definitions: GateDefinition[];
}

export interface AuditPolicy {
  manualUiAudit: boolean;
  appLaunch: string;
  target: string;
}

export interface InstructionPolicy {
  opencodeCommandAlias: boolean;
  namingRules: boolean;
  promptInjectionWarning: boolean;
  noCreditWarning: boolean;
  implementationGuardrails: boolean;
  supplyChainSafety: boolean;
}

export interface MigrationPolicy {
  legacyScripts: 'preserve' | 'install-wrappers' | 'cleanup';
  compatibilityWrappers: boolean;
  cleanupKnownHelpers: boolean;
}

export interface SupplyChainPolicy {
  exactVersions: boolean;
  intentionalLockfileChanges: boolean;
  disableLifecycleScripts: boolean;
  pinCiActions: boolean;
  packageAgeDays: number;
  highRiskPackageAgeDays: number;
  requireApprovalForUnverifiedRisk: boolean;
  writePackageManagerDefaults: boolean;
}

export interface ExecutorPolicy {
  labels: LabelPolicy;
  milestoneOrdering: MilestoneOrderingPolicy;
  branch: BranchPolicy;
  lifecycle: LifecyclePolicy;
  shipping: ShippingPolicy;
  reviews: ReviewPolicy;
  gates: GatePolicy;
  audit: AuditPolicy;
  instructions: InstructionPolicy;
  migration: MigrationPolicy;
  supplyChain: SupplyChainPolicy;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function uniqueStrings(values: string[], field: string): string[] {
  return [...new Set(values.map((value) => nonEmpty(value, field)))];
}

function nonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`normalize executor policy failed: ${field} must be a finite non-negative number.`);
  }
  return value;
}

export function normalizeExecutorPolicy(input: ExecutorPolicy): ExecutorPolicy {
  const packageAgeDays = nonNegativeNumber(input.supplyChain.packageAgeDays, 'supplyChain.packageAgeDays');
  const highRiskPackageAgeDays = nonNegativeNumber(input.supplyChain.highRiskPackageAgeDays, 'supplyChain.highRiskPackageAgeDays');
  const promptFragments = input.reviews.promptFragments ?? { repository: [], safety: [], style: [], adapter: [], reviewer: [], commandAddendum: [] };
  const contextSources = input.reviews.contextSources ?? { instructions: ['AGENTS.md', '**/AGENTS.md'], requirements: [], issues: 'github', issueComments: 'github', linkedIssues: 'github', milestones: 'github', pullRequests: 'github', prComments: 'github', reviewThreads: 'github' };
  const lanes = input.reviews.lanes ?? [];
  if (highRiskPackageAgeDays < packageAgeDays) {
    throw new Error('normalize executor policy failed: supplyChain.highRiskPackageAgeDays must be greater than or equal to supplyChain.packageAgeDays.');
  }

  return {
    labels: {
      priorities: input.labels.priorities.map((label) => ({ ...label, name: nonEmpty(label.name, 'label.name') })),
      statuses: input.labels.statuses.map((label) => ({ ...label, name: nonEmpty(label.name, 'label.name') })),
      components: input.labels.components.map((label) => ({ ...label, name: nonEmpty(label.name, 'label.name') })),
    },
    milestoneOrdering: {
      enabled: input.milestoneOrdering.enabled,
      order: uniqueStrings(input.milestoneOrdering.order, 'milestoneOrdering.order'),
      missingAssignment: input.milestoneOrdering.missingAssignment,
    },
    branch: {
      ...input.branch,
      pattern: nonEmpty(input.branch.pattern, 'branch.pattern'),
      baseRemote: nonEmpty(input.branch.baseRemote, 'branch.baseRemote'),
      baseBranch: nonEmpty(input.branch.baseBranch, 'branch.baseBranch'),
      ignoredReviewAuthors: uniqueStrings(input.branch.ignoredReviewAuthors, 'branch.ignoredReviewAuthors'),
    },
    shipping: { ...input.shipping },
    lifecycle: { ...input.lifecycle, autonomousMode: input.shipping.autonomousMode },
    reviews: {
      adapter: input.reviews.adapter,
      profile: input.reviews.profile ?? 'remote-compatible',
      severityThreshold: input.reviews.severityThreshold ?? 'high',
      promptFragments: {
        repository: uniqueStrings(promptFragments.repository ?? [], 'reviews.promptFragments.repository'),
        safety: uniqueStrings(promptFragments.safety ?? [], 'reviews.promptFragments.safety'),
        style: uniqueStrings(promptFragments.style ?? [], 'reviews.promptFragments.style'),
        adapter: uniqueStrings(promptFragments.adapter ?? [], 'reviews.promptFragments.adapter'),
        reviewer: uniqueStrings(promptFragments.reviewer ?? [], 'reviews.promptFragments.reviewer'),
        commandAddendum: uniqueStrings(promptFragments.commandAddendum ?? [], 'reviews.promptFragments.commandAddendum'),
      },
      contextSources: {
        instructions: uniqueStrings(contextSources.instructions, 'reviews.contextSources.instructions'),
        requirements: uniqueStrings(contextSources.requirements, 'reviews.contextSources.requirements'),
        issues: contextSources.issues,
        issueComments: contextSources.issueComments ?? contextSources.issues,
        linkedIssues: contextSources.linkedIssues ?? contextSources.issues,
        milestones: contextSources.milestones,
        pullRequests: contextSources.pullRequests,
        prComments: contextSources.prComments ?? contextSources.pullRequests,
        reviewThreads: contextSources.reviewThreads ?? contextSources.pullRequests,
      },
      lanes: lanes.map(lane => ({
        ...lane,
        id: nonEmpty(lane.id, 'reviews.lanes.id'),
        match: uniqueStrings(lane.match, 'reviews.lanes.match'),
        prompt: uniqueStrings(lane.prompt, 'reviews.lanes.prompt'),
        tools: uniqueStrings(lane.tools, 'reviews.lanes.tools'),
        command: lane.command?.trim() ? lane.command.trim() : undefined,
      })),
      reviewers: uniqueStrings(input.reviews.reviewers, 'reviews.reviewers'),
      localReviewers: uniqueStrings(input.reviews.localReviewers, 'reviews.localReviewers'),
      waitMinutes: nonNegativeNumber(input.reviews.waitMinutes, 'reviews.waitMinutes'),
      requestText: input.reviews.requestText,
    },
    gates: { definitions: input.gates.definitions.map((definition) => ({ ...definition, key: nonEmpty(definition.key, 'gate.key'), name: nonEmpty(definition.name, 'gate.name') })) },
    audit: { ...input.audit },
    instructions: { ...input.instructions },
    migration: { ...input.migration },
    supplyChain: {
      ...input.supplyChain,
      packageAgeDays,
      highRiskPackageAgeDays,
    },
  };
}
