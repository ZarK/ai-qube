import type { RuntimeCommandContext } from '@tjalve/qube-cli/runtime';
import type { InitPolicyOptions } from './init/index.js';
import { numberFlag, stringFlag, stringListFlag } from './runtime_result.js';

function readBooleanFlag(context: RuntimeCommandContext, name: string): boolean | undefined {
  return typeof context.flags[name] === 'boolean' ? context.flags[name] : undefined;
}

function splitList(values: string[]): string[] {
  return values.flatMap(item => item.split(',')).map(item => item.trim()).filter(item => item.length > 0);
}

export function policyFromRuntimeFlags(context: RuntimeCommandContext): InitPolicyOptions {
  const policy: InitPolicyOptions = {};
  const setBoolean = (flag: string, assign: (value: boolean) => void) => {
    const value = readBooleanFlag(context, flag);
    if (value !== undefined) assign(value);
  };
  setBoolean('worktree', value => { policy.noWorktree = !value; });
  setBoolean('block-open-prs', value => { policy.blockOnOpenPRs = value; });
  setBoolean('base-branch-freshness', value => { policy.requireBaseBranchFreshness = value; });
  setBoolean('autonomous', value => { policy.autonomousMode = value; });
  setBoolean('assign-on-start', value => { policy.assignOnStart = value; });
  setBoolean('comment-on-start', value => { policy.commentOnStart = value; });
  setBoolean('manual-ui-audit', value => { policy.manualUiAudit = value; });
  setBoolean('opencode-command-alias', value => { policy.opencodeCommandAlias = value; });
  setBoolean('quality-control', value => { policy.qualityControl = value; });
  const strings: [string, (value: string) => void][] = [
    ['branch-naming', value => { policy.branchNaming = value; }],
    ['base-branch', value => { policy.baseBranch = value; }],
    ['base-remote', value => { policy.baseRemote = value; }],
    ['ui-audit-app-launch', value => { policy.uiAuditAppLaunch = value; }],
    ['ui-audit-target', value => { policy.uiAuditTarget = value; }],
    ['review-request-text', value => { policy.reviewRequestText = value; }],
  ];
  for (const [flag, assign] of strings) {
    const value = stringFlag(context, flag);
    if (value !== undefined) assign(value);
  }
  const reviewWaitMinutes = numberFlag(context, 'review-wait-minutes');
  if (reviewWaitMinutes !== undefined) policy.reviewWaitMinutes = reviewWaitMinutes;
  const lists: [string, (values: string[]) => void][] = [
    ['priority-label', values => { policy.priorityLabels = splitList(values); }],
    ['status-label', values => { policy.statusLabels = splitList(values); }],
    ['component-label', values => { policy.componentLabels = splitList(values); }],
    ['ignored-automation-author', values => { policy.ignoredAutomationAuthors = splitList(values); }],
    ['quality-gate', values => { policy.qualityGates = splitList(values); }],
    ['review-agent', values => { policy.reviewAgents = splitList(values); }],
  ];
  for (const [flag, assign] of lists) {
    const value = stringListFlag(context, flag);
    if (value !== undefined) assign(value);
  }
  addMilestonePolicy(context, policy);
  addInstructionPolicy(context, policy);
  addSupplyChainPolicy(context, policy);
  return policy;
}

function addMilestonePolicy(context: RuntimeCommandContext, policy: InitPolicyOptions): void {
  const milestoneEnabled = readBooleanFlag(context, 'milestone-ordering');
  const milestoneOrder = stringListFlag(context, 'milestone-order');
  const missingMilestone = stringFlag(context, 'missing-milestone');
  if (milestoneEnabled === undefined && milestoneOrder === undefined && missingMilestone === undefined) return;
  policy.milestoneOrdering = {};
  if (milestoneEnabled !== undefined) policy.milestoneOrdering.enabled = milestoneEnabled;
  if (milestoneOrder !== undefined) policy.milestoneOrdering.order = splitList(milestoneOrder);
  if (missingMilestone === 'ignore' || missingMilestone === 'warn' || missingMilestone === 'block') policy.milestoneOrdering.missingAssignment = missingMilestone;
}

function addInstructionPolicy(context: RuntimeCommandContext, policy: InitPolicyOptions): void {
  const flags = ['naming-rules', 'prompt-injection-warning', 'credit-warning', 'implementation-guardrails', 'supply-chain-safety'] as const;
  for (const flag of flags) {
    const value = readBooleanFlag(context, flag);
    if (value === undefined) continue;
    policy.instructions ??= {};
    if (flag === 'naming-rules') policy.instructions.namingRules = value;
    if (flag === 'prompt-injection-warning') policy.instructions.promptInjectionWarning = value;
    if (flag === 'credit-warning') policy.instructions.noCreditWarning = value;
    if (flag === 'implementation-guardrails') policy.instructions.implementationGuardrails = value;
    if (flag === 'supply-chain-safety') policy.instructions.supplyChainSafety = value;
  }
}

function addSupplyChainPolicy(context: RuntimeCommandContext, policy: InitPolicyOptions): void {
  const booleans = ['exact-dependency-versions', 'intentional-lockfile-changes', 'disable-lifecycle-scripts', 'pin-ci-actions', 'unverified-risk-approval', 'package-manager-defaults'] as const;
  for (const flag of booleans) {
    const value = readBooleanFlag(context, flag);
    if (value === undefined) continue;
    policy.supplyChain ??= {};
    if (flag === 'exact-dependency-versions') policy.supplyChain.exactVersions = value;
    if (flag === 'intentional-lockfile-changes') policy.supplyChain.intentionalLockfileChanges = value;
    if (flag === 'disable-lifecycle-scripts') policy.supplyChain.disableLifecycleScripts = value;
    if (flag === 'pin-ci-actions') policy.supplyChain.pinCiActions = value;
    if (flag === 'unverified-risk-approval') policy.supplyChain.requireApprovalForUnverifiedRisk = value;
    if (flag === 'package-manager-defaults') policy.supplyChain.writePackageManagerDefaults = value;
  }
  const packageAgeDays = numberFlag(context, 'package-age-days');
  const highRiskPackageAgeDays = numberFlag(context, 'high-risk-package-age-days');
  if (packageAgeDays === undefined && highRiskPackageAgeDays === undefined) return;
  policy.supplyChain ??= {};
  if (packageAgeDays !== undefined) policy.supplyChain.packageAgeDays = packageAgeDays;
  if (highRiskPackageAgeDays !== undefined) policy.supplyChain.highRiskPackageAgeDays = highRiskPackageAgeDays;
}
