import type { GateDefinition } from './gate_evidence';

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

export interface ReviewPolicy {
  reviewers: string[];
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
      reviewers: uniqueStrings(input.reviews.reviewers, 'reviews.reviewers'),
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
