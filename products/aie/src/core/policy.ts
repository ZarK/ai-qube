import type { GateDefinition } from './gate_evidence.js';
import { defaultInstructionContextSources } from '../agent_host_adapters.js';

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
export type ReviewProfileKind = 'remote-compatible' | 'local-standard' | 'local-focused' | 'local-comprehensive' | 'local-shadow';
export type ReviewSeverityThreshold = 'low' | 'medium' | 'high' | 'critical';
export type ReviewLaneRequiredMode = 'always' | 'when-matched' | 'optional' | 'shadow';
export type ReviewLaneRereviewMode = 'always-rerun' | 'delta';
export type ReviewModelTierId = 'review' | 'economy' | 'synthesis';
export type ReviewModelHostId = 'codex' | 'claude-code' | 'opencode' | 'grok';
export type ReviewModelEffort = 'low' | 'medium' | 'high';
// Runtime-validated against the review host adapter registry
// (products/aie/src/app/review_host_adapters.ts); not a closed union so
// registry-only test-double hosts type-check without widening this type.
export type RoutedReviewHostId = string;

export interface ReviewRoutePolicy {
  host: RoutedReviewHostId;
  tier: ReviewModelTierId;
  timeoutSeconds: number;
  maxTurns: number;
}

export interface ReviewFailoverPolicy {
  faults: number;
  route: ReviewRoutePolicy;
}

export interface ReviewModelBinding {
  model: string;
  effort: ReviewModelEffort | null;
}

export type ReviewModelTierMap = Partial<Record<ReviewModelHostId, ReviewModelBinding>>;

export interface ReviewModelsPolicy {
  review: ReviewModelTierMap;
  economy: ReviewModelTierMap;
  synthesis: ReviewModelTierMap;
}

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
  rereview: ReviewLaneRereviewMode;
  route: ReviewRoutePolicy | null;
  carryForwardContext: 'all' | 'config' | 'scope';
  tier: ReviewModelTierId;
  suppress: string[];
  maxAdvisoryFindings: number | null;
  optOut: boolean;
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
  concurrency: number;
  requestText: string;
  carryForwardPublish: 'note' | 'none';
  models: ReviewModelsPolicy;
  route: ReviewRoutePolicy | null;
  failover: ReviewFailoverPolicy | null;
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

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`normalize executor policy failed: ${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function normalizeExecutorPolicy(input: ExecutorPolicy): ExecutorPolicy {
  const packageAgeDays = nonNegativeNumber(input.supplyChain.packageAgeDays, 'supplyChain.packageAgeDays');
  const highRiskPackageAgeDays = nonNegativeNumber(input.supplyChain.highRiskPackageAgeDays, 'supplyChain.highRiskPackageAgeDays');
  const promptFragments = input.reviews.promptFragments ?? { repository: [], safety: [], style: [], adapter: [], reviewer: [], commandAddendum: [] };
  const contextSources = input.reviews.contextSources ?? { instructions: defaultInstructionContextSources(), requirements: [], issues: 'github', issueComments: 'github', linkedIssues: 'github', milestones: 'github', pullRequests: 'github', prComments: 'github', reviewThreads: 'github' };
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
        route: lane.route ? { ...lane.route } : null,
      })),
      reviewers: uniqueStrings(input.reviews.reviewers, 'reviews.reviewers'),
      localReviewers: uniqueStrings(input.reviews.localReviewers, 'reviews.localReviewers'),
      waitMinutes: nonNegativeNumber(input.reviews.waitMinutes, 'reviews.waitMinutes'),
      concurrency: boundedInteger(input.reviews.concurrency ?? 3, 'reviews.concurrency', 1, 8),
      requestText: input.reviews.requestText,
      carryForwardPublish: input.reviews.carryForwardPublish,
      models: {
        review: { ...(input.reviews.models?.review ?? {}) },
        economy: { ...(input.reviews.models?.economy ?? {}) },
        synthesis: { ...(input.reviews.models?.synthesis ?? {}) },
      },
      route: input.reviews.route ? { ...input.reviews.route } : null,
      failover: input.reviews.failover
        ? { faults: boundedInteger(input.reviews.failover.faults, 'reviews.failover.faults', 1, 5), route: { ...input.reviews.failover.route } }
        : null,
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
