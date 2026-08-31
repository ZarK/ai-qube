import { rm } from 'fs/promises';
import { join, relative, resolve } from 'path';
import { readInitLayerContext } from '@tjalve/qube-core';
import { AIE_CONFIG_FILENAME, type Config, type GitHubReviewPublisherConfig, type ReviewSourceConfig, configToFileShape, getDefaults, mergeConfigOverlay, parseUserReviewPublisherFile, userConfigPath, userReviewPublisherPath, validateConfig } from '../config/index.js';
import { defaultModelRoutingPolicy, resolveModelRouting, type ModelRoutingPolicy } from '../core/model_routing.js';
import { detectInstalledReviewHostsOnPath, detectInstalledRoutingHostsOnPath } from '../app/model_routing_hosts.js';
import { getAgentHostProfiles } from '../agent_hosts.js';
import { parseInitTool, uniqueTools, type InitTool } from '../init_content.js';
import { renderInitFiles } from '../init_renderer.js';
import { planManagedUpdate, readTextIfPresent, writeFileSafely } from '../managed_file.js';
import { getRepoRoot } from '../repo/index.js';
import { reviewModeOf } from '../review_mode.js';
import { configToExecutorPolicy } from '../config_policy.js';
import { evaluateGitPrerequisites, prerequisiteCheck } from '../providers/local/git_prerequisites.js';
import type { RepositoryPrerequisites } from '../core/repo_state.js';
import { adoptFromSource } from './from_source.js';
import { applyFreshSetupPolicy, buildIsolatedReviewRoute, reconcileReviewModePolicy } from './fresh_setup.js';
import {
  answersFromPolicy,
  applyQuestionAnswersToPolicy,
  buildInitQuestions,
  buildSetupSummary,
  detectGuideMachine,
  fillUnansweredQuestions,
  isolatedReviewHostsOnMachine,
  unansweredQuestionIds,
} from './questions.js';
import { planLocalRuntimeGitignoreUpdate } from './local_runtime_gitignore.js';
import { getDesiredLabels } from '../labels.js';
import {
  listInitExternalReviewers,
  resolveInitExternalReviewers,
  resolveInitIsolatedReviewer,
  resolveInitLocalReviewers,
  resolveInitReviewModels,
} from './review_selections.js';
export { collectSetupDoctorRecommendations } from './setup_readiness.js';
export { resolveContainedFromPath, parseAdoptedConfig, classifyFromSpec } from './from_source.js';
export {
  applyFreshSetupPolicy,
  detectRepositoryQualityGate,
  freshSetupFirstPullRequestReadiness,
  freshSetupConfigIdentity,
} from './fresh_setup.js';
export type {
  InitAction,
  InitActionOperation,
  InitActionStatus,
  InitFromReport,
  InitOptions,
  InitPolicyOptions,
  InitPolicySummary,
  InitPostAction,
  InitProviderAction,
  InitQuestion,
  InitQuestionId,
  InitResult,
  InitSetupSummary,
} from './types.js';
import type { InitAction, InitActionStatus, InitFromReport, InitOptions, InitPolicyOptions, InitPolicySummary, InitPostAction, InitProviderAction, InitQuestion, InitResult } from './types.js';

interface PlannedWrite {
  actionId: string;
  path: string;
  operation: 'write' | 'remove';
  content?: string;
}

interface InitPlanBuild {
  result: InitResult;
  writes: PlannedWrite[];
}

interface ConfigMergeResult {
  ok: boolean;
  content: string | null;
  changed: boolean;
  reason: string;
  config: Config;
}
function resolveInitTools(tool: string | undefined): InitTool[] {
  return parseInitTool(tool ?? '') ?? [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formatConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function policySummary(config: Config): InitPolicySummary {
  return {
    namingRules: config.instructions.namingRules,
    milestoneOrdering: config.milestoneOrdering.enabled,
    missingMilestonePolicy: config.milestoneOrdering.missingAssignment,
    supplyChainSafety: config.instructions.supplyChainSafety,
    projectPackageManagerDefaults: config.supplyChain.writePackageManagerDefaults,
    autonomousMode: config.autonomousMode,
  };
}

function mergeNestedRecord(current: unknown, updates: Record<string, unknown>): Record<string, unknown> {
  return { ...(isPlainObject(current) ? current : {}), ...updates };
}

function applyProviderPolicy(record: Record<string, unknown>, policy: InitPolicyOptions): void {
  const reviewKind = policy.reviewProvider ?? (policy.workProvider === 'gitlab' ? 'gitlab' : undefined);
  if (!policy.workProvider && !reviewKind && !policy.ciProvider) return;
  const providers = mergeNestedRecord(record.providers, {});
  record.providers = providers;
  if (policy.workProvider) {
    providers.work = mergeNestedRecord(providers.work, { kind: policy.workProvider });
  }
  if (reviewKind) {
    const review = mergeNestedRecord(providers.review, { kind: reviewKind });
    if (reviewKind !== 'github') delete review.publisher;
    providers.review = review;
  }
  if (policy.ciProvider) {
    providers.ci = mergeNestedRecord(providers.ci, { kind: policy.ciProvider });
  }
}

function applyPolicyToRecord(record: Record<string, unknown>, policy: InitPolicyOptions | undefined): void {
  if (!policy) return;
  applyProviderPolicy(record, policy);
  const policyRecord = mergeNestedRecord(record.policy, {});
  record.policy = policyRecord;

  if (policy.priorityLabels !== undefined || policy.statusLabels !== undefined || policy.componentLabels !== undefined) {
    policyRecord.labels = mergeNestedRecord(policyRecord.labels, {
      ...(policy.priorityLabels !== undefined ? { priorities: policy.priorityLabels } : {}),
      ...(policy.statusLabels !== undefined ? { statuses: policy.statusLabels } : {}),
      ...(policy.componentLabels !== undefined ? { components: policy.componentLabels } : {}),
    });
  }

  if (policy.branchNaming !== undefined || policy.baseBranch !== undefined || policy.baseRemote !== undefined || policy.noWorktree !== undefined || policy.blockOnOpenPRs !== undefined || policy.requireBaseBranchFreshness !== undefined || policy.ignoredAutomationAuthors !== undefined) {
    policyRecord.branch = mergeNestedRecord(policyRecord.branch, {
      ...(policy.branchNaming !== undefined ? { naming: policy.branchNaming } : {}),
      ...(policy.baseBranch !== undefined ? { baseBranch: policy.baseBranch } : {}),
      ...(policy.baseRemote !== undefined ? { baseRemote: policy.baseRemote } : {}),
      ...(policy.noWorktree !== undefined ? { noWorktree: policy.noWorktree } : {}),
      ...(policy.blockOnOpenPRs !== undefined ? { blockOnOpenPRs: policy.blockOnOpenPRs } : {}),
      ...(policy.requireBaseBranchFreshness !== undefined ? { requireBaseBranchFreshness: policy.requireBaseBranchFreshness } : {}),
      ...(policy.ignoredAutomationAuthors !== undefined ? { ignoredAutomationAuthors: policy.ignoredAutomationAuthors } : {}),
    });
  }

  if (policy.assignOnStart !== undefined || policy.commentOnStart !== undefined) {
    policyRecord.lifecycle = mergeNestedRecord(policyRecord.lifecycle, {
      ...(policy.assignOnStart !== undefined ? { assignOnStart: policy.assignOnStart } : {}),
      ...(policy.commentOnStart !== undefined ? { commentOnStart: policy.commentOnStart } : {}),
    });
  }

  if (policy.autonomousMode !== undefined) {
    policyRecord.shipping = mergeNestedRecord(policyRecord.shipping, { autonomousMode: policy.autonomousMode });
  }

  if (
    policy.reviewAgents !== undefined
    || policy.reviewWaitMinutes !== undefined
    || policy.reviewRequestText !== undefined
    || policy.reviewMode !== undefined
    || policy.reviewAdapter !== undefined
    || policy.reviewProfile !== undefined
    || policy.reviewLanes !== undefined
    || policy.reviewModels !== undefined
    || policy.reviewRoute !== undefined
    || policy.reviewFailover !== undefined
    || policy.localReviewAgents !== undefined
  ) {
    policyRecord.reviews = mergeNestedRecord(policyRecord.reviews, {
      ...(policy.reviewAgents !== undefined ? { agents: policy.reviewAgents } : {}),
      ...(policy.localReviewAgents !== undefined ? { localAgents: policy.localReviewAgents } : {}),
      ...(policy.reviewWaitMinutes !== undefined ? { waitMinutes: policy.reviewWaitMinutes } : {}),
      ...(policy.reviewRequestText !== undefined ? { requestText: policy.reviewRequestText } : {}),
      ...(policy.reviewMode !== undefined ? { mode: policy.reviewMode } : {}),
      ...(policy.reviewAdapter !== undefined ? { adapter: policy.reviewAdapter } : {}),
      ...(policy.reviewProfile !== undefined ? { profile: policy.reviewProfile } : {}),
      ...(policy.reviewLanes !== undefined ? { lanes: policy.reviewLanes } : {}),
      ...(policy.reviewModels !== undefined ? { models: policy.reviewModels } : {}),
      ...(policy.reviewRoute !== undefined ? { route: policy.reviewRoute } : {}),
      ...(policy.reviewFailover !== undefined ? { failover: policy.reviewFailover } : {}),
    });
  }

  if (policy.publisher !== undefined) {
    const providers = mergeNestedRecord(record.providers, {});
    const review = mergeNestedRecord(providers.review, { publisher: policy.publisher });
    providers.review = review;
    record.providers = providers;
  }

  if (policy.gates !== undefined || policy.qualityControl !== undefined) {
    policyRecord.gates = mergeNestedRecord(policyRecord.gates, {
      ...(policy.gates !== undefined ? { definitions: policy.gates } : {}),
      ...(policy.qualityControl !== undefined ? { qualityControl: policy.qualityControl } : {}),
    });
  }

  if (policy.manualUiAudit !== undefined || policy.uiAuditAppLaunch !== undefined || policy.uiAuditTarget !== undefined || policy.uiAuditEvidenceRoot !== undefined) {
    policyRecord.audit = mergeNestedRecord(policyRecord.audit, {
      ...(policy.manualUiAudit !== undefined ? { manualUiAudit: policy.manualUiAudit } : {}),
      ...(policy.uiAuditAppLaunch !== undefined ? { appLaunch: policy.uiAuditAppLaunch } : {}),
      ...(policy.uiAuditTarget !== undefined ? { target: policy.uiAuditTarget } : {}),
      ...(policy.uiAuditEvidenceRoot !== undefined ? { evidenceRoot: policy.uiAuditEvidenceRoot } : {}),
    });
  }

  if (policy.instructions) {
    policyRecord.instructions = mergeNestedRecord(policyRecord.instructions, {
      ...policy.instructions,
    });
  }

  if (policy.milestoneOrdering) policyRecord.milestoneOrdering = mergeNestedRecord(policyRecord.milestoneOrdering, policy.milestoneOrdering as Record<string, unknown>);
  if (policy.supplyChain) policyRecord.supplyChain = mergeNestedRecord(policyRecord.supplyChain, policy.supplyChain as Record<string, unknown>);
  if (policy.modelRouting) policyRecord.modelRouting = policy.modelRouting as unknown as Record<string, unknown>;
}

function defaultsRecord(): Record<string, unknown> {
  return configToFileShape(getDefaults()) as unknown as Record<string, unknown>;
}

function bindDefaultModelRouting(primaryHost: InitTool): ModelRoutingPolicy {
  const modelRouting = defaultModelRoutingPolicy();
  return {
    ...modelRouting,
    catalog: modelRouting.catalog.map(entry => entry.id === modelRouting.primary
      ? { ...entry, host: primaryHost, transport: 'host' }
      : entry),
  };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function configuredReviewSources(config: Config): ReviewSourceConfig[] {
  const sources: ReviewSourceConfig[] = [];
  const localEnabled = (config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed') && config.reviewProfile !== 'local-shadow';
  if (localEnabled) {
    const expected = config.reviewLanes
      .filter(lane => lane.required === 'always' && lane.optOut !== true)
      .map(lane => lane.id);
    if (expected.length > 0) {
      sources.push({ id: 'local-lanes', identity: 'lane', expected, blocking: true, markers: 'trusted', enabled: true });
    }
  }
  const providerEnabled = config.reviewAdapter === 'github' || config.reviewAdapter === 'remote' || config.reviewAdapter === 'mixed';
  const reviewers = config.reviewAgents.map(reviewer => reviewer.trim()).filter(reviewer => reviewer !== '');
  if (providerEnabled && reviewers.length > 0) {
    sources.push({ id: 'provider-reviewers', identity: 'reviewer', expected: reviewers, blocking: true, markers: 'provider', enabled: true });
  }
  return sources;
}

function persistReviewSources(record: Record<string, unknown>): void {
  const validation = validateConfig(record);
  if (!validation.config || validation.config.reviewSources.length > 0) return;
  const sources = configuredReviewSources(validation.config);
  if (sources.length === 0) return;
  const policy = mergeNestedRecord(record.policy, {});
  const reviews = mergeNestedRecord(policy.reviews, { sources });
  policy.reviews = reviews;
  record.policy = policy;
}

function emptyGuideFields(): Pick<InitResult, 'questions' | 'unansweredQuestionIds' | 'setupSummary' | 'from' | 'awaitingAnswers' | 'postInitActions' | 'providerActions'> {
  return {
    questions: [],
    unansweredQuestionIds: [],
    setupSummary: null,
    from: null,
    awaitingAnswers: false,
    postInitActions: [],
    providerActions: [],
  };
}

function generatedConfigInvalidReason(operation: string, path: string, message: string): string {
  return `Failed while ${operation}. Likely cause: invalid generated policy value at ${path}: ${message}. Next action: check supplied init policy flags or rerun with --defaults --yes.`;
}

function configFromPolicy(policy: InitPolicyOptions | undefined): Config {
  const defaults = defaultsRecord();
  applyPolicyToRecord(defaults, policy);
  persistReviewSources(defaults);
  const validation = validateConfig(defaults);
  return validation.config ?? getDefaults();
}

function mergeConfig(
  raw: Record<string, unknown> | null,
  force: boolean,
  policy: InitPolicyOptions | undefined,
  base: Record<string, unknown> = defaultsRecord(),
  preferBase = false,
  persistDerived = true,
): ConfigMergeResult {
  const baseline = cloneRecord(base);
  const defaults = cloneRecord(base);
  applyPolicyToRecord(defaults, policy);
  if (persistDerived) persistReviewSources(defaults);
  const defaultValidation = validateConfig(defaults);
  if (!defaultValidation.ok || !defaultValidation.config) {
    const first = defaultValidation.errors[0];
    return {
      ok: false,
      content: null,
      changed: false,
      reason: generatedConfigInvalidReason('validating generated default config', first.path, first.message),
      config: getDefaults(),
    };
  }
  if (raw === null) return { ok: true, content: formatConfig(defaults), changed: true, reason: preferBase ? 'Config file will be created from the adopted policy and selected answers.' : 'Config file will be created with Executor defaults, provider selections, and selected policy.', config: defaultValidation.config };
  if (preferBase) {
    const content = formatConfig(defaults);
    const currentContent = formatConfig(raw);
    return {
      ok: true,
      content,
      changed: content !== currentContent,
      reason: content === currentContent ? 'Adopted policy already matches the destination config.' : 'Config will be replaced with the adopted policy and selected answers.',
      config: defaultValidation.config,
    };
  }
  const validation = validateConfig(mergeConfigOverlay(baseline, raw));
  if (!validation.ok) {
    const first = validation.errors[0];
    return {
      ok: false,
      content: null,
      changed: false,
      reason: `Invalid repository config at ${first.path}. Reason: ${first.message}. Next action: fix the file, then rerun the command.`,
      config: defaultValidation.config,
    };
  }
  const next: Record<string, unknown> = validation.ok && validation.config
    ? configToFileShape(validation.config) as unknown as Record<string, unknown>
    : defaults;
  applyPolicyToRecord(next, policy);
  if (persistDerived) persistReviewSources(next);
  const nextValidation = validateConfig(next);
  if (!nextValidation.ok || !nextValidation.config) {
    const first = nextValidation.errors[0];
    return {
      ok: false,
      content: null,
      changed: false,
      reason: generatedConfigInvalidReason('validating merged config', first.path, first.message),
      config: defaultValidation.config,
    };
  }
  const content = formatConfig(configToFileShape(nextValidation.config) as unknown as Record<string, unknown>);
  const currentContent = formatConfig(raw);
  return {
    ok: true,
    content,
    changed: content !== currentContent,
    reason: content === currentContent ? 'Config already uses the current Executor shape.' : 'Config will be updated to the current provider and policy shape.',
    config: nextValidation.config,
  };
}

function relativePath(repoRoot: string, path: string): string {
  const value = relative(repoRoot, path);
  return value === '' ? '.' : value;
}

function actionText(action: InitAction): string {
  return `${action.operation} ${action.path}: ${action.reason}`;
}

async function readConfig(path: string): Promise<{ raw: Record<string, unknown> | null; parseError: string | null; fileExists: boolean }> {
  const content = await readTextIfPresent(path);
  if (content === null) return { raw: null, parseError: null, fileExists: false };
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isPlainObject(parsed)) return { raw: null, parseError: 'Config file must contain a JSON object.', fileExists: true };
    return { raw: parsed, parseError: null, fileExists: true };
  } catch (err: unknown) {
    return { raw: null, parseError: err instanceof Error ? err.message : String(err), fileExists: true };
  }
}

function makeAction(input: Omit<InitAction, 'status'> & { status?: InitActionStatus }): InitAction {
  return { ...input, status: input.status ?? (input.operation === 'unchanged' ? 'skipped' : input.operation === 'blocked' ? 'blocked' : 'planned') };
}

async function planConfig(
  repoRoot: string,
  force: boolean,
  warnings: string[],
  policy: InitPolicyOptions | undefined,
  base: Record<string, unknown> = defaultsRecord(),
  preferBase = false,
  userGlobal: Record<string, unknown> | null = null,
): Promise<{ action: InitAction; write?: PlannedWrite; config: Config }> {
  const configPath = join(repoRoot, AIE_CONFIG_FILENAME);
  const configRead = await readConfig(configPath);
  const fallbackConfig = configFromPolicy(policy);
  if (configRead.parseError) {
    return {
      action: makeAction({
        id: 'config',
        path: relativePath(repoRoot, configPath),
        kind: 'config',
        operation: 'blocked',
        managedSection: false,
        conflict: true,
        reason: `Invalid repository config at ${relativePath(repoRoot, configPath)}:. Reason: ${configRead.parseError}. Next action: fix the file, then rerun the command.`,
      }),
      config: fallbackConfig,
    };
  }
  const merged = mergeConfig(configRead.raw, force, policy, base, preferBase, userGlobal === null);
  if (!merged.ok || merged.content === null) {
    return {
      action: makeAction({ id: 'config', path: relativePath(repoRoot, configPath), kind: 'config', operation: 'blocked', managedSection: false, conflict: true, reason: merged.reason }),
      config: merged.config,
    };
  }
  const projected = projectRepositoryConfig(configToFileShape(merged.config) as unknown as Record<string, unknown>, userGlobal);
  const empty = Object.keys(projected).every(key => key === 'version');
  const projectedContent = formatConfig(projected);
  const currentContent = configRead.raw ? formatConfig(configRead.raw) : null;
  const operation = empty
    ? configRead.fileExists ? 'remove' : 'unchanged'
    : !configRead.fileExists ? 'create'
      : projectedContent !== currentContent ? 'update-config' : 'unchanged';
  const reason = operation === 'remove'
    ? 'Repository config contains no values that differ from explicit user-global settings and will be removed.'
    : operation === 'unchanged'
      ? 'Repository config already contains only meaningful differences from user-global settings.'
      : 'Repository config will store only values that differ from explicit user-global settings.';
  const action = makeAction({ id: 'config', path: relativePath(repoRoot, configPath), kind: 'config', operation, managedSection: false, conflict: false, reason });
  if (operation === 'unchanged') return { action, config: merged.config };
  return {
    action,
    write: operation === 'remove'
      ? { actionId: action.id, path: configPath, operation: 'remove' }
      : { actionId: action.id, path: configPath, operation: 'write', content: projectedContent },
    config: merged.config,
  };
}

function projectRepositoryConfig(
  desired: Record<string, unknown>,
  userGlobal: Record<string, unknown> | null,
): Record<string, unknown> {
  const projected = projectRecord(desired, userGlobal);
  return { version: 1, ...projected };
}

function projectRecord(
  desired: Record<string, unknown>,
  baseline: Record<string, unknown> | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key === 'version') continue;
    const baselineValue = baseline?.[key];
    if (isPlainObject(value)) {
      const child = projectRecord(value, isPlainObject(baselineValue) ? baselineValue : null);
      if (Object.keys(child).length > 0) result[key] = child;
      continue;
    }
    if (baseline && key in baseline && JSON.stringify(value) === JSON.stringify(baselineValue)) continue;
    result[key] = value;
  }
  return result;
}

function missingNpmrcSettings(existingContent: string): string[] {
  const settings = new Map<string, string>();
  for (const line of existingContent.split(/\r?\n/)) {
    const normalized = line.replace(/[;#].*$/, '').trim().toLowerCase();
    const match = /^([^=\s]+)\s*=\s*(\S+)\s*$/.exec(normalized);
    if (match) settings.set(match[1], match[2]);
  }
  const missing: string[] = [];
  if (settings.get('ignore-scripts') !== 'true') missing.push('ignore-scripts=true');
  if (settings.get('save-exact') !== 'true') missing.push('save-exact=true');
  return missing;
}

async function planLocalRuntimeGitignore(repoRoot: string): Promise<{ action: InitAction; write?: PlannedWrite }> {
  const path = join(repoRoot, '.gitignore');
  const existingContent = await readTextIfPresent(path);
  const planned = planLocalRuntimeGitignoreUpdate(existingContent);
  const action = makeAction({
    id: 'local-runtime-gitignore',
    path: relativePath(repoRoot, path),
    kind: 'config',
    operation: planned.operation,
    managedSection: false,
    conflict: false,
    reason: planned.reason,
  });
  if (planned.operation === 'unchanged' || planned.content === null) return { action };
  return { action, write: { actionId: action.id, path, operation: 'write', content: planned.content } };
}

async function planPackageManagerDefaults(repoRoot: string, force: boolean): Promise<{ action: InitAction; write?: PlannedWrite }> {
  const path = join(repoRoot, '.npmrc');
  const existingContent = await readTextIfPresent(path);
  if (existingContent === null) {
    const content = 'ignore-scripts=true\nsave-exact=true\n';
    const action = makeAction({ id: 'npm-secure-defaults', path: '.npmrc', kind: 'config', operation: 'create', managedSection: false, conflict: false, reason: 'Project npm defaults will disable lifecycle scripts and save exact dependency versions.' });
    return { action, write: { actionId: action.id, path, operation: 'write', content } };
  }
  const missing = missingNpmrcSettings(existingContent);
  if (missing.length === 0) {
    return { action: makeAction({ id: 'npm-secure-defaults', path: '.npmrc', kind: 'config', operation: 'unchanged', managedSection: false, conflict: false, reason: 'Project npm defaults already include required supply-chain settings.' }) };
  }
  if (!force) {
    return { action: makeAction({ id: 'npm-secure-defaults', path: '.npmrc', kind: 'config', operation: 'blocked', managedSection: false, conflict: true, reason: `Existing .npmrc is missing ${missing.join(', ')}. Rerun with --force to append project defaults after reviewing existing npm settings.` }) };
  }
  const separator = existingContent.endsWith('\n') ? '' : '\n';
  const content = `${existingContent}${separator}${missing.join('\n')}\n`;
  const action = makeAction({ id: 'npm-secure-defaults', path: '.npmrc', kind: 'config', operation: 'append', managedSection: false, conflict: false, reason: `Project npm defaults will append ${missing.join(', ')}.` });
  return { action, write: { actionId: action.id, path, operation: 'write', content } };
}

async function planManagedFile(input: {
  repoRoot: string;
  id: string;
  relativePath: string;
  kind: 'instruction' | 'command' | 'skill' | 'subagent';
  body: string;
  allowAppend: boolean;
  force: boolean;
  conflictPatterns?: RegExp[];
  conflictReason?: string;
}): Promise<{ action: InitAction; write?: PlannedWrite }> {
  const path = join(input.repoRoot, input.relativePath);
  const existingContent = await readTextIfPresent(path);
  const update = planManagedUpdate({
    existingContent,
    generatedBody: input.body,
    allowAppend: input.allowAppend,
    force: input.force,
    commentStyle: input.relativePath.endsWith('.toml') ? 'hash' : 'html',
    conflictPatterns: input.conflictPatterns,
    conflictReason: input.conflictReason,
  });
  const action = makeAction({
    id: input.id,
    path: input.relativePath,
    kind: input.kind,
    operation: update.operation,
    managedSection: update.managedFound || update.operation !== 'blocked',
    conflict: update.conflict,
    reason: update.diff ? `${update.reason}\nManaged section diff (current vs rendered):\n${update.diff}` : update.reason,
  });
  return update.ok && update.content !== null && update.operation !== 'unchanged'
    ? { action, write: { actionId: action.id, path, operation: 'write', content: update.content } }
    : { action };
}

function nextCommand(resultOk: boolean, awaitingAnswers = false): string {
  if (awaitingAnswers) return 'Answer the remaining questions in the host, then rerun `aie init <target> --yes --json` with those flags. Init does not write until --yes is set.';
  if (!resultOk) return 'Resolve blocked file actions or rerun `qube aie init . --dry-run --force` to review forced updates.';
  return 'Run `qube aie doctor --json` to verify repository setup, then `qube aie queue --json` to inspect issue work.';
}

function answersFromRecord(record: Record<string, unknown>): ReturnType<typeof answersFromPolicy> {
  const validation = validateConfig(record);
  if (!validation.config) return {};
  const config = validation.config;
  const reviewMode = reviewModeOf(config);
  return {
    reviewMode,
    reviewers: [...(reviewMode === 'host' ? config.localReviewAgents : config.reviewAgents)],
    reviewModels: Object.entries(config.reviewModels.review).flatMap(([host, binding]) => (
      binding?.model ? [`${host}:${binding.model}`] : []
    )),
    publisher: config.providers.review.kind === 'github' ? (config.providers.review.publisher?.mode ?? 'user') : undefined,
    qualityControl: config.qualityControl,
    manualUiAudit: config.manualUiAudit,
    uiAuditEvidenceRoot: config.uiAuditEvidenceRoot === '' ? undefined : config.uiAuditEvidenceRoot,
    noCreditWarning: config.instructions.noCreditWarning,
  };
}

function hasCompleteGitHubAppPublisher(config: Config): boolean {
  const app = config.providers.review.publisher?.githubApp;
  return config.providers.review.publisher?.mode === 'github-app'
    && Boolean(app?.appId && app.installationId && (app.privateKeyEnv || app.privateKeyPath));
}

function hasCompletePublisher(publisher: GitHubReviewPublisherConfig | null | undefined): boolean {
  const app = publisher?.githubApp;
  return publisher?.mode === 'github-app' && Boolean(app?.appId && app.installationId && (app.privateKeyEnv || app.privateKeyPath));
}

function postInitActions(policy: InitPolicyOptions, config: Config, userPublisher: GitHubReviewPublisherConfig | null): InitPostAction[] {
  if (
    config.providers.review.kind !== 'github'
    || policy.publisherIntent !== 'github-app'
    || hasCompleteGitHubAppPublisher(config)
    || hasCompletePublisher(userPublisher)
  ) return [];
  const global = policy.publisherConfigScope === 'global';
  return [{
    id: 'github-app-publisher-setup',
    command: `qube review setup github-app${global ? ' --config-scope global' : ''}`,
    reason: 'Run the guided GitHub App setup after init. Init did not write incomplete publisher credentials.',
  }];
}

async function readUserPublisherForInit(homeDirectory?: string): Promise<{ publisher: GitHubReviewPublisherConfig | null; error: string | null }> {
  const path = userReviewPublisherPath(homeDirectory);
  const content = await readTextIfPresent(path);
  if (!content) return { publisher: null, error: null };
  try {
    const parsed = parseUserReviewPublisherFile(JSON.parse(content) as unknown);
    if (!parsed.ok || !parsed.publisher) {
      const first = parsed.errors[0];
      return { publisher: null, error: `Invalid user-global config at ${path}:${first?.path ?? '.'}. Reason: ${first?.message ?? 'Validation failed.'} Next action: fix the file, then rerun the command.` };
    }
    return { publisher: parsed.publisher as unknown as GitHubReviewPublisherConfig, error: null };
  } catch (error) {
    return { publisher: null, error: `Invalid user-global config at ${path}:. Reason: ${error instanceof Error ? error.message : String(error)} Next action: fix the file, then rerun the command.` };
  }
}

async function readUserGlobalForInit(
  homeDirectory: string | undefined,
  publisher: GitHubReviewPublisherConfig | null,
): Promise<{ config: Record<string, unknown> | null; error: string | null }> {
  const path = userConfigPath(homeDirectory);
  const current = await readConfig(path);
  if (current.parseError) {
    return { config: null, error: `Invalid user-global config at ${path}:. Reason: ${current.parseError} Next action: fix the file, then rerun the command.` };
  }
  const globalConfig = current.raw && !current.parseError ? current.raw : null;
  const publisherLayer = publisher
    ? { version: 1, providers: { review: { kind: 'github', publisher } } }
    : null;
  if (globalConfig) {
    const validation = validateConfig(mergeConfigOverlay(defaultsRecord(), globalConfig));
    if (!validation.ok) {
      const first = validation.errors[0];
      return { config: null, error: `Invalid user-global config at ${path}:${first.path}. Reason: ${first.message} Next action: fix the file, then rerun the command.` };
    }
  }
  if (!globalConfig) return { config: publisherLayer, error: null };
  if (!publisherLayer) return { config: globalConfig, error: null };
  const merged = mergeConfigOverlay(globalConfig, publisherLayer);
  return { config: isPlainObject(merged) ? merged : globalConfig, error: null };
}

function providerActions(config: Config): InitProviderAction[] {
  if (config.providers.work.kind !== 'github') return [];
  return [{
    id: 'labels-setup',
    provider: 'github',
    command: 'qube aie labels setup',
    labels: getDesiredLabels(config),
    reason: 'Create or reuse the configured priority, lifecycle, and custom component labels after local init succeeds.',
  }];
}

function publisherSummary(config: Config): string {
  if (config.providers.review.kind !== 'github') return 'not applicable';
  const publisher = config.providers.review.publisher;
  if (!publisher) return 'user (not configured)';
  if (publisher.mode === 'github-app') return publisher.githubApp?.login ? `github-app (${publisher.githubApp.login})` : 'github-app';
  if (publisher.mode === 'token') return publisher.token?.login ? `token (${publisher.token.login})` : 'token';
  return 'user';
}

async function prepareInitPlan(options: InitOptions): Promise<InitPlanBuild> {
  const targetPath = resolve(options.cwd ?? process.cwd(), options.target);
  const discoveredRepoRoot = getRepoRoot(targetPath);
  const repoRoot = discoveredRepoRoot ?? (options.prospectiveRoot && options.dryRun ? targetPath : null);
  const selectedTools = uniqueTools(resolveInitTools(options.tool));
  const warnings: string[] = [];
  const actions: InitAction[] = [];
  const writes: PlannedWrite[] = [];
  const selectedInstalledHosts = options.installedHosts ?? selectedTools;
  const detectedMachine = detectGuideMachine({
    repoRoot,
    installedHosts: selectedInstalledHosts,
    agentBrowserAvailable: options.agentBrowserAvailable,
    aiqAvailable: options.aiqAvailable,
  });
  let fromReport: InitFromReport | null = null;
  let currentAnswers: ReturnType<typeof answersFromPolicy> = {};
  let currentConfig: Config | null = null;
  let existingConfigIsBase = false;
  let policy = options.policy ? { ...options.policy } : {};
  const publisherRead = await readUserPublisherForInit(options.homeDirectory);
  const globalRead = await readUserGlobalForInit(options.homeDirectory, publisherRead.publisher);
  const userPublisher = publisherRead.publisher;
  const userGlobal = globalRead.config;
  const sourceError = publisherRead.error ?? globalRead.error;
  if (sourceError) {
    const fallbackConfig = configFromPolicy(policy);
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot,
        selectedTools,
        policy: policySummary(fallbackConfig),
        configPath: join(repoRoot ?? targetPath, AIE_CONFIG_FILENAME),
        actions: [],
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: [sourceError],
        nextCommand: 'Fix the invalid user-global config, then rerun `aie init`.',
        ...emptyGuideFields(),
      },
      writes: [],
    };
  }
  const inheritedBase = userGlobal ? mergeConfigOverlay(defaultsRecord(), userGlobal) : defaultsRecord();
  let baseRecord = isPlainObject(inheritedBase) ? inheritedBase : defaultsRecord();
  if (userGlobal) {
    const inherited = validateConfig(baseRecord);
    if (inherited.ok && inherited.config) {
      currentConfig = inherited.config;
      currentAnswers = answersFromRecord(baseRecord);
      existingConfigIsBase = true;
    }
  }

  if (!options.from && repoRoot) {
    const current = await readConfig(join(repoRoot, AIE_CONFIG_FILENAME));
    if (current.raw && !current.parseError) {
      const validation = validateConfig(mergeConfigOverlay(baseRecord, current.raw));
      if (validation.ok && validation.config) {
        currentConfig = validation.config;
        baseRecord = configToFileShape(validation.config) as unknown as Record<string, unknown>;
        currentAnswers = answersFromRecord(baseRecord);
        existingConfigIsBase = true;
      }
    }
  }

  if (options.from) {
    const adopted = await adoptFromSource({
      spec: options.from,
      cwd: options.cwd ?? process.cwd(),
      fetchRepoConfig: options.fetchRepoConfig,
      machine: detectedMachine,
    });
    if (!adopted.ok) {
      const fallbackConfig = configFromPolicy(policy);
      return {
        result: {
          ok: false,
          command: 'init',
          dryRun: options.dryRun,
          forced: options.force,
          target: options.target,
          repoRoot,
          selectedTools,
          policy: policySummary(fallbackConfig),
          configPath: join(repoRoot ?? targetPath, AIE_CONFIG_FILENAME),
          actions,
          plannedChanges: [],
          completedChanges: [],
          skippedActions: [],
          warnings,
          errors: [adopted.error],
          nextCommand: 'Pass a path relative to the working directory or an owner/repo slug, then rerun `aie init --from`.',
          ...emptyGuideFields(),
        },
        writes,
      };
    }
    baseRecord = adopted.record;
    fromReport = adopted.report;
    warnings.push(...adopted.report.adjustments);
  }

  const baseValidation = validateConfig(baseRecord);
  const reviewProvider = policy.reviewProvider
    ?? (policy.workProvider && policy.workProvider !== 'github' ? 'gitlab' : undefined)
    ?? ((existingConfigIsBase || options.from) ? baseValidation.config?.providers.review.kind : undefined)
    ?? 'github';
  const machine = {
    ...detectedMachine,
    externalReviewers: reviewProvider === 'github' ? await listInitExternalReviewers() : [],
  };

  const selectionErrors: string[] = [];
  const primaryHost = policy.primaryHost ?? selectedTools[0];
  if (policy.primaryHost && !selectedTools.includes(policy.primaryHost)) {
    selectionErrors.push(`Primary harness ${policy.primaryHost} is not in the selected agent harnesses.`);
  }
  if (!existingConfigIsBase && !options.from && policy.modelRouting === undefined && primaryHost) {
    policy.modelRouting = bindDefaultModelRouting(primaryHost);
  }
  if (policy.reviewAgentSelections !== undefined) {
    const resolved = resolveInitExternalReviewers(policy.reviewAgentSelections, machine.externalReviewers, reviewProvider);
    policy.reviewAgentSelections = [...resolved.values];
    policy.reviewAgents = [...resolved.values];
    selectionErrors.push(...resolved.errors);
  }
  if (policy.localReviewAgentSelections !== undefined) {
    const resolved = resolveInitLocalReviewers(policy.localReviewAgentSelections, machine.installedHosts);
    policy.localReviewAgentSelections = [...resolved.values];
    policy.localReviewAgents = [...resolved.values];
    selectionErrors.push(...resolved.errors);
  }
  if (policy.isolatedReviewAgent !== undefined) {
    const resolved = resolveInitIsolatedReviewer(policy.isolatedReviewAgent, selectedTools, machine.installedHosts);
    selectionErrors.push(...resolved.errors);
    if (resolved.values) {
      policy.reviewMode ??= 'isolated';
      policy.reviewRoute = buildIsolatedReviewRoute(resolved.values);
    }
  }
  if (policy.reviewModelSelections !== undefined) {
    const resolved = resolveInitReviewModels(policy.reviewModelSelections, machine.modelCatalogs ?? {});
    policy.reviewModelSelections = Object.entries(resolved.values).flatMap(([host, binding]) => (
      binding?.model ? [`${host}:${binding.model}`] : []
    ));
    selectionErrors.push(...resolved.errors);
    warnings.push(...resolved.warnings);
    if (Object.keys(resolved.values).length > 0) {
      policy.reviewModels = {
        review: resolved.values,
        economy: currentConfig?.reviewModels.economy ?? policy.reviewModels?.economy ?? {},
        synthesis: currentConfig?.reviewModels.synthesis ?? policy.reviewModels?.synthesis ?? {},
      };
    }
  }
  const reviewModeChanged = currentConfig !== null
    && policy.reviewMode !== undefined
    && policy.reviewMode !== reviewModeOf(currentConfig);
  if (existingConfigIsBase && (reviewModeChanged || policy.isolatedReviewAgent !== undefined)) {
    policy = reconcileReviewModePolicy({ policy, machine });
  }

  const flagAnswers = answersFromPolicy(policy);
  const fromAnswers = options.from ? answersFromRecord(baseRecord) : {};
  const answers = { ...currentAnswers, ...fromAnswers, ...flagAnswers };
  const askedQuestions = buildInitQuestions({
    machine,
    answers,
    useDefaults: options.useDefaults,
    repoRoot,
    reviewProvider,
  });
  const fillAnswers = Boolean(options.guide) || Boolean(options.yes) || Boolean(options.useDefaults);
  const questions = fillAnswers ? fillUnansweredQuestions(askedQuestions) : askedQuestions;
  if (!existingConfigIsBase) policy = applyQuestionAnswersToPolicy(policy, questions);
  if (fillAnswers && !existingConfigIsBase) {
    policy = applyFreshSetupPolicy({
      policy,
      machine,
      repoRoot,
      fromAdopted: Boolean(options.from) || existingConfigIsBase,
    });
  }
  const awaitingAnswers = Boolean(options.guide) && !options.yes;
  const unanswered = unansweredQuestionIds(awaitingAnswers ? askedQuestions : questions);
  if (policy.reviewMode === 'isolated' && isolatedReviewHostsOnMachine(machine).length === 0 && answers.reviewMode === 'isolated') {
    const fallbackConfig = configFromPolicy(policy);
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot,
        selectedTools,
        policy: policySummary(fallbackConfig),
        configPath: join(repoRoot ?? targetPath, AIE_CONFIG_FILENAME),
        actions,
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: ['Review mode isolated requires an installed review host adapter: codex, grok-build, or cursor.'],
        nextCommand: 'Install a review host or pass --review-mode external or --review-mode host.',
        questions: askedQuestions,
        unansweredQuestionIds: unanswered,
        setupSummary: null,
        from: fromReport,
        awaitingAnswers: false,
        postInitActions: [],
        providerActions: [],
      },
      writes,
    };
  }
  const fallbackConfig = currentConfig ?? configFromPolicy(policy);

  if (selectedTools.length === 0) {
    const configPath = join(repoRoot ?? targetPath, AIE_CONFIG_FILENAME);
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot,
        selectedTools,
        policy: policySummary(fallbackConfig),
        configPath,
        actions,
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: [`Unsupported init tool "${options.tool}". Use opencode, codex, claude-code, grok-build, cursor, or all.`],
        nextCommand: 'Run `qube aie init --help` to see supported tool values.',
        questions,
        unansweredQuestionIds: unanswered,
        setupSummary: null,
        from: fromReport,
        awaitingAnswers: false,
        postInitActions: [],
        providerActions: [],
      },
      writes,
    };
  }

  if (!repoRoot) {
    const configPath = join(targetPath, AIE_CONFIG_FILENAME);
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot: null,
        selectedTools,
        policy: policySummary(fallbackConfig),
        configPath,
        actions,
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: ['Target is not inside a git repository. Run `qube aie init .` from the repository checkout.'],
        nextCommand: 'Change to a git repository root, then rerun `qube aie init . --dry-run`.',
        questions,
        unansweredQuestionIds: unanswered,
        setupSummary: null,
        from: fromReport,
        awaitingAnswers: false,
        postInitActions: [],
        providerActions: [],
      },
      writes,
    };
  }

  if (selectionErrors.length > 0) {
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot,
        selectedTools,
        policy: policySummary(fallbackConfig),
        configPath: join(repoRoot, AIE_CONFIG_FILENAME),
        actions,
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: selectionErrors,
        nextCommand: 'Select registered review services, installed local review harnesses, and models from the live host catalogs, then rerun init.',
        questions,
        unansweredQuestionIds: unanswered,
        setupSummary: null,
        from: fromReport,
        awaitingAnswers: false,
        postInitActions: [],
        providerActions: [],
      },
      writes,
    };
  }

  const parentLayerContext = readInitLayerContext();
  const parentRepositoryFields = parentLayerContext?.repository ? Object.keys(parentLayerContext.repository).filter(field => field !== 'version') : [];
  const executorRepositoryFields = parentRepositoryFields.filter(field => ['hosts', 'workProviders', 'ciProviders', 'continuousShipping', 'review'].includes(field));
  const inheritComposerBaseline = parentLayerContext?.selectedScope === 'repository'
    && parentLayerContext.baseline !== null
    && executorRepositoryFields.length === 0;
  const inheritedOnlyBaseline = inheritComposerBaseline
    ? configToFileShape(configFromPolicy(policy)) as unknown as Record<string, unknown>
    : userGlobal;
  let configPlan = await planConfig(repoRoot, options.force, warnings, policy, baseRecord, Boolean(options.from), inheritedOnlyBaseline);
  if (inheritComposerBaseline && configPlan.action.operation === 'create') {
    configPlan = {
      action: makeAction({
        ...configPlan.action,
        operation: 'unchanged',
        status: 'skipped',
        reason: 'Effective user-global settings and defaults require no repository config.',
      }),
      config: configPlan.config,
    };
  }
  const config = configPlan.config;
  let selectedProfiles;
  try {
    selectedProfiles = await getAgentHostProfiles(selectedTools);
  } catch (error) {
    return {
      result: {
        ok: false,
        command: 'init',
        dryRun: options.dryRun,
        forced: options.force,
        target: options.target,
        repoRoot,
        selectedTools,
        policy: policySummary(config),
        configPath: join(repoRoot ?? targetPath, AIE_CONFIG_FILENAME),
        actions,
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: [error instanceof Error ? error.message : String(error)],
        nextCommand: 'Install the missing host adapter, or pass --tool all to use installed adapters only.',
        ...emptyGuideFields(),
      },
      writes,
    };
  }
  actions.push(configPlan.action);
  if (configPlan.write) writes.push(configPlan.write);

  const gitignorePlan = await planLocalRuntimeGitignore(repoRoot);
  actions.push(gitignorePlan.action);
  if (gitignorePlan.write) writes.push(gitignorePlan.write);

  if (config.supplyChain.writePackageManagerDefaults) {
    const planned = await planPackageManagerDefaults(repoRoot, options.force);
    actions.push(planned.action);
    if (planned.write) writes.push(planned.write);
  }

  const rendered = renderInitFiles(config, selectedProfiles);
  warnings.push(...rendered.warnings);
  for (const renderedFile of rendered.files) {
    const planned = await planManagedFile({
      repoRoot,
      id: renderedFile.id,
      relativePath: renderedFile.relativePath,
      kind: renderedFile.kind,
      body: renderedFile.body,
      allowAppend: renderedFile.allowAppend,
      force: options.force,
      conflictPatterns: renderedFile.kind === 'instruction' ? [/##\s+Executor Issue Workflow/i, /BEGIN EXECUTOR MANAGED SECTION/i] : undefined,
      conflictReason: renderedFile.kind === 'instruction' ? 'Existing QUBE instruction content conflicts with the managed section. Rerun with --force to replace the managed section intentionally.' : undefined,
    });
    actions.push(planned.action);
    if (planned.write) writes.push(planned.write);
  }

  const errors = actions.filter(action => action.status === 'blocked').map(action => `${action.path}: ${action.reason}`);
  const setupSummary = buildSetupSummary({
    reviewMode: reviewModeOf(config),
    reviewers: config.reviewAgents,
    publisher: publisherSummary(config),
    qualityControl: config.qualityControl,
    manualUiAudit: config.manualUiAudit,
    tools: selectedTools,
  });
  return {
    result: {
      ok: errors.length === 0,
      command: 'init',
      dryRun: options.dryRun || awaitingAnswers,
      forced: options.force,
      target: options.target,
      repoRoot,
      selectedTools,
      policy: policySummary(config),
      configPath: join(repoRoot, AIE_CONFIG_FILENAME),
      actions,
      plannedChanges: actions.filter(action => action.status === 'planned').map(actionText),
      completedChanges: [],
      skippedActions: actions.filter(action => action.status === 'skipped').map(actionText),
      warnings,
      errors,
      nextCommand: nextCommand(errors.length === 0, awaitingAnswers),
      modelRouting: resolveModelRouting(config.modelRouting, config.reviewModels, detectInstalledRoutingHostsOnPath(), detectInstalledReviewHostsOnPath()),
      questions: awaitingAnswers ? askedQuestions : questions,
      unansweredQuestionIds: unanswered,
      setupSummary,
      from: fromReport,
      awaitingAnswers,
      postInitActions: postInitActions(policy, config, userPublisher),
      providerActions: providerActions(config),
    },
    writes: awaitingAnswers ? [] : writes,
  };
}

async function initPrerequisites(options: InitOptions): Promise<RepositoryPrerequisites> {
  const targetPath = resolve(options.cwd ?? process.cwd(), options.target);
  return evaluateGitPrerequisites({
    cwd: targetPath,
    policy: configToExecutorPolicy(configFromPolicy(options.policy ?? {})),
    prospective: options.prospectiveRoot === true && options.dryRun,
    offline: options.dryRun,
  });
}

function hardInitPrerequisite(prerequisites: RepositoryPrerequisites, options: InitOptions) {
  const git = prerequisiteCheck(prerequisites, 'git');
  const repository = prerequisiteCheck(prerequisites, 'repository');
  return [git, repository].find(candidate => (
    candidate?.reasonCode === 'git-not-found'
    || candidate?.reasonCode === 'git-unsupported'
    || candidate?.reasonCode === 'repository-unreadable'
    || (candidate?.reasonCode === 'not-a-repository' && !(options.prospectiveRoot && options.dryRun))
  ));
}

function prerequisiteInitFailure(options: InitOptions, prerequisites: RepositoryPrerequisites, blocker: NonNullable<ReturnType<typeof hardInitPrerequisite>>): InitResult {
  const targetPath = resolve(options.cwd ?? process.cwd(), options.target);
  const config = configFromPolicy(options.policy ?? {});
  return {
    ok: false,
    command: 'init',
    dryRun: options.dryRun,
    forced: options.force,
    target: options.target,
    repoRoot: null,
    prerequisites,
    selectedTools: uniqueTools(resolveInitTools(options.tool)),
    policy: policySummary(config),
    configPath: join(targetPath, AIE_CONFIG_FILENAME),
    actions: [],
    plannedChanges: [],
    completedChanges: [],
    skippedActions: [],
    warnings: [],
    errors: [blocker.summary],
    nextCommand: blocker.nextAction ?? 'Resolve the Git prerequisite, then rerun `aie init`.',
    ...emptyGuideFields(),
  };
}

async function prepareInitWithPrerequisites(options: InitOptions): Promise<InitPlanBuild> {
  const prerequisites = await initPrerequisites(options);
  const blocker = hardInitPrerequisite(prerequisites, options);
  if (blocker) return { result: prerequisiteInitFailure(options, prerequisites, blocker), writes: [] };
  const built = await prepareInitPlan(options);
  return { ...built, result: { ...built.result, prerequisites } };
}

export async function buildInitPlan(options: InitOptions): Promise<InitResult> {
  return (await prepareInitWithPrerequisites(options)).result;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const built = await prepareInitWithPrerequisites(options);
  const result = built.result;
  if (!result.ok || options.dryRun || result.awaitingAnswers) return result;
  const completedChanges: string[] = [];
  const errors: string[] = [];
  const actions = result.actions.map(action => ({ ...action }));
  for (const write of built.writes) {
    const action = actions.find(item => item.id === write.actionId);
    try {
      if (write.operation === 'remove') {
        const repoRoot = result.repoRoot;
        const expectedPath = repoRoot ? resolve(repoRoot, AIE_CONFIG_FILENAME) : null;
        if (!expectedPath || resolve(write.path) !== expectedPath) {
          throw new Error('Refused to remove a config path outside the exact repository Executor config location.');
        }
        await rm(write.path, { force: true });
      } else {
        if (write.content === undefined) throw new Error('Planned config write has no content.');
        await writeFileSafely(write.path, write.content);
      }
      if (action) action.status = 'completed';
      completedChanges.push(action ? actionText(action) : `Wrote ${relativePath(result.repoRoot ?? process.cwd(), write.path)}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (action) {
        action.status = 'failed';
        action.reason = `Write failed: ${message}`;
      }
      errors.push(`${relativePath(result.repoRoot ?? process.cwd(), write.path)}: ${message}`);
    }
  }
  return {
    ...result,
    ok: errors.length === 0,
    actions,
    plannedChanges: actions.filter(action => action.status === 'planned').map(actionText),
    completedChanges,
    skippedActions: actions.filter(action => action.status === 'skipped').map(actionText),
    errors,
    nextCommand: nextCommand(errors.length === 0),
  };
}
