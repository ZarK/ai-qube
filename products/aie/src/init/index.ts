import { join, relative, resolve } from 'path';
import { AIE_CONFIG_FILENAME, type Config, configToFileShape, getDefaults, validateConfig } from '../config/index.js';
import { parseInitTool, uniqueTools } from '../init_content.js';
import { getAgentHostProfiles } from '../agent_hosts.js';
import { renderInitFiles } from '../init_renderer.js';
import { planManagedUpdate, readTextIfPresent, writeFileSafely } from '../managed_file.js';
import { getRepoRoot } from '../repo/index.js';
import { detectLegacyState, LEGACY_CHOICE_TEXT } from './legacy_state.js';
export { detectLegacyState } from './legacy_state.js';
export type { InitAction, InitActionOperation, InitActionStatus, InitOptions, InitPolicyOptions, InitPolicySummary, InitResult, LegacyChoice, LegacyState } from './types.js';
import type { InitAction, InitActionStatus, InitOptions, InitPolicyOptions, InitPolicySummary, InitResult, LegacyState } from './types.js';

interface PlannedWrite {
  actionId: string;
  path: string;
  content: string;
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
    opencodeCommandAlias: config.opencodeCommandAlias,
  };
}

function mergeNestedRecord(current: unknown, updates: Record<string, unknown>): Record<string, unknown> {
  return { ...(isPlainObject(current) ? current : {}), ...updates };
}

function applyPolicyToRecord(record: Record<string, unknown>, policy: InitPolicyOptions | undefined): void {
  if (!policy) return;
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

  if (policy.reviewAgents !== undefined || policy.reviewWaitMinutes !== undefined || policy.reviewRequestText !== undefined) {
    policyRecord.reviews = mergeNestedRecord(policyRecord.reviews, {
      ...(policy.reviewAgents !== undefined ? { agents: policy.reviewAgents } : {}),
      ...(policy.reviewWaitMinutes !== undefined ? { waitMinutes: policy.reviewWaitMinutes } : {}),
      ...(policy.reviewRequestText !== undefined ? { requestText: policy.reviewRequestText } : {}),
    });
  }

  if (policy.gates !== undefined || policy.qualityGates !== undefined || policy.qualityControl !== undefined) {
    policyRecord.gates = mergeNestedRecord(policyRecord.gates, {
      ...(policy.gates !== undefined ? { definitions: policy.gates } : {}),
      ...(policy.qualityGates !== undefined ? { qualityGates: policy.qualityGates } : {}),
      ...(policy.qualityControl !== undefined ? { qualityControl: policy.qualityControl } : {}),
    });
  }

  if (policy.manualUiAudit !== undefined || policy.uiAuditAppLaunch !== undefined || policy.uiAuditTarget !== undefined) {
    policyRecord.audit = mergeNestedRecord(policyRecord.audit, {
      ...(policy.manualUiAudit !== undefined ? { manualUiAudit: policy.manualUiAudit } : {}),
      ...(policy.uiAuditAppLaunch !== undefined ? { appLaunch: policy.uiAuditAppLaunch } : {}),
      ...(policy.uiAuditTarget !== undefined ? { target: policy.uiAuditTarget } : {}),
    });
  }

  if (policy.opencodeCommandAlias !== undefined || policy.instructions) {
    policyRecord.instructions = mergeNestedRecord(policyRecord.instructions, {
      ...(policy.opencodeCommandAlias !== undefined ? { opencodeCommandAlias: policy.opencodeCommandAlias } : {}),
      ...(policy.instructions ? policy.instructions : {}),
    });
  }

  if (policy.milestoneOrdering) policyRecord.milestoneOrdering = mergeNestedRecord(policyRecord.milestoneOrdering, policy.milestoneOrdering as Record<string, unknown>);
  if (policy.migration) policyRecord.migration = mergeNestedRecord(policyRecord.migration, policy.migration as Record<string, unknown>);
  if (policy.supplyChain) policyRecord.supplyChain = mergeNestedRecord(policyRecord.supplyChain, policy.supplyChain as Record<string, unknown>);
}

function defaultsRecord(): Record<string, unknown> {
  return configToFileShape(getDefaults()) as unknown as Record<string, unknown>;
}

function generatedConfigInvalidReason(operation: string, path: string, message: string): string {
  return `Failed while ${operation}. Likely cause: invalid generated policy value at ${path}: ${message}. Next action: check supplied init policy flags or rerun with --defaults --yes.`;
}

function configFromPolicy(policy: InitPolicyOptions | undefined): Config {
  const defaults = defaultsRecord();
  applyPolicyToRecord(defaults, policy);
  const validation = validateConfig(defaults);
  return validation.config ?? getDefaults();
}

function mergeConfig(raw: Record<string, unknown> | null, force: boolean, policy: InitPolicyOptions | undefined): ConfigMergeResult {
  const defaults = defaultsRecord();
  applyPolicyToRecord(defaults, policy);
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
  if (raw === null) return { ok: true, content: formatConfig(defaults), changed: true, reason: 'Config file will be created with Executor defaults, provider selections, and selected policy.', config: defaultValidation.config };
  const validation = validateConfig(raw);
  if (!validation.ok && !force) {
    const first = validation.errors[0];
    return {
      ok: false,
      content: null,
      changed: false,
      reason: `Existing config is invalid at ${first.path}: ${first.message}. Rerun with --force to replace it with the current Executor config shape.`,
      config: defaultValidation.config,
    };
  }
  const next: Record<string, unknown> = validation.ok && validation.config
    ? configToFileShape(validation.config) as unknown as Record<string, unknown>
    : defaults;
  applyPolicyToRecord(next, policy);
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

function legacyActions(legacy: LegacyState[]): InitAction[] {
  return legacy.map(item => makeAction({
    id: `legacy-${item.category}`,
    path: `legacy/${item.category}`,
    kind: 'legacy',
    operation: 'unchanged',
    managedSection: false,
    conflict: item.action === 'defer-to-migration' || item.action === 'leave-untouched',
    reason: `${item.reason} Next action: ${item.nextCommand}`,
  }));
}

function legacyInstructionConflictPatterns(legacy: LegacyState[]): RegExp[] {
  return legacy.some(item => item.category === 'instructions') ? [/\bgh-[\w-]+\.sh\b/i, /legacy issue workflow/i, /legacy workflow helper/i] : [];
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

async function planConfig(repoRoot: string, force: boolean, warnings: string[], policy: InitPolicyOptions | undefined): Promise<{ action: InitAction; write?: PlannedWrite; config: Config }> {
  const configPath = join(repoRoot, AIE_CONFIG_FILENAME);
  const configRead = await readConfig(configPath);
  const fallbackConfig = configFromPolicy(policy);
  if (configRead.parseError) {
    if (!force) {
      return {
        action: makeAction({
          id: 'config',
          path: relativePath(repoRoot, configPath),
          kind: 'config',
          operation: 'blocked',
          managedSection: false,
          conflict: true,
          reason: `Existing config could not be parsed: ${configRead.parseError}. Rerun with --force to replace it with valid Executor defaults.`,
          }),
          config: fallbackConfig,
      };
    }
    warnings.push('Existing config could not be parsed and will be replaced because --force is set.');
  }
  const merged = mergeConfig(configRead.raw, force, policy);
  if (!merged.ok || merged.content === null) {
    return {
      action: makeAction({ id: 'config', path: relativePath(repoRoot, configPath), kind: 'config', operation: 'blocked', managedSection: false, conflict: true, reason: merged.reason }),
      config: merged.config,
    };
  }
  const operation = !configRead.fileExists ? 'create' : merged.changed ? 'update-config' : 'unchanged';
  const action = makeAction({ id: 'config', path: relativePath(repoRoot, configPath), kind: 'config', operation, managedSection: false, conflict: false, reason: merged.reason });
  return operation === 'unchanged' ? { action, config: merged.config } : { action, write: { actionId: action.id, path: configPath, content: merged.content }, config: merged.config };
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

async function planPackageManagerDefaults(repoRoot: string, force: boolean): Promise<{ action: InitAction; write?: PlannedWrite }> {
  const path = join(repoRoot, '.npmrc');
  const existingContent = await readTextIfPresent(path);
  if (existingContent === null) {
    const content = 'ignore-scripts=true\nsave-exact=true\n';
    const action = makeAction({ id: 'npm-secure-defaults', path: '.npmrc', kind: 'config', operation: 'create', managedSection: false, conflict: false, reason: 'Project npm defaults will disable lifecycle scripts and save exact dependency versions.' });
    return { action, write: { actionId: action.id, path, content } };
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
  return { action, write: { actionId: action.id, path, content } };
}

async function planManagedFile(input: {
  repoRoot: string;
  id: string;
  relativePath: string;
  kind: 'instruction' | 'command';
  body: string;
  allowAppend: boolean;
  force: boolean;
  conflictPatterns?: RegExp[];
  conflictReason?: string;
}): Promise<{ action: InitAction; write?: PlannedWrite }> {
  const path = join(input.repoRoot, input.relativePath);
  const existingContent = await readTextIfPresent(path);
  const update = planManagedUpdate({ existingContent, generatedBody: input.body, allowAppend: input.allowAppend, force: input.force, conflictPatterns: input.conflictPatterns, conflictReason: input.conflictReason });
  const action = makeAction({
    id: input.id,
    path: input.relativePath,
    kind: input.kind,
    operation: update.operation,
    managedSection: update.managedFound || update.operation !== 'blocked',
    conflict: update.conflict,
    reason: update.reason,
  });
  return update.ok && update.content !== null && update.operation !== 'unchanged'
    ? { action, write: { actionId: action.id, path, content: update.content } }
    : { action };
}

function nextCommand(resultOk: boolean): string {
  if (!resultOk) return 'Resolve blocked file actions or rerun `qube aie init . --dry-run --force` to review forced updates.';
  return 'Run `qube aie doctor --json` to verify repository setup, then `qube aie queue --json` to inspect issue work.';
}

async function prepareInitPlan(options: InitOptions): Promise<InitPlanBuild> {
  const targetPath = resolve(options.cwd ?? process.cwd(), options.target);
  const repoRoot = getRepoRoot(targetPath);
  const selectedTools = uniqueTools(parseInitTool(options.tool) ?? []);
  const fallbackConfig = configFromPolicy(options.policy);
  const warnings: string[] = [];
  const actions: InitAction[] = [];
  const writes: PlannedWrite[] = [];

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
        legacy: [],
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: [`Unsupported init tool "${options.tool}". Use opencode, codex, claude-code, or all.`],
        nextCommand: 'Run `qube aie init --help` to see supported tool values.',
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
        legacy: [],
        plannedChanges: [],
        completedChanges: [],
        skippedActions: [],
        warnings,
        errors: ['Target is not inside a git repository. Run `qube aie init .` from the repository checkout.'],
        nextCommand: 'Change to a git repository root, then rerun `qube aie init . --dry-run`.',
      },
      writes,
    };
  }

  const configPlan = await planConfig(repoRoot, options.force, warnings, options.policy);
  const config = configPlan.config;
  const selectedProfiles = getAgentHostProfiles(selectedTools);
  actions.push(configPlan.action);
  if (configPlan.write) writes.push(configPlan.write);

  const legacy = await detectLegacyState(repoRoot, config);
  actions.push(...legacyActions(legacy));
  warnings.push(...legacy.map(item => item.reason));
  const legacyInstructionPatterns = legacyInstructionConflictPatterns(legacy);

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
      conflictPatterns: renderedFile.kind === 'instruction' ? [/##\s+Executor Issue Workflow/i, /BEGIN EXECUTOR MANAGED SECTION/i, ...legacyInstructionPatterns] : undefined,
      conflictReason: renderedFile.kind === 'instruction' ? `Existing legacy instruction content was found. Choices: ${LEGACY_CHOICE_TEXT}. Rerun with --force to add the managed section intentionally.` : undefined,
    });
    actions.push(planned.action);
    if (planned.write) writes.push(planned.write);
  }

  const errors = actions.filter(action => action.status === 'blocked').map(action => `${action.path}: ${action.reason}`);
  return {
    result: {
      ok: errors.length === 0,
      command: 'init',
      dryRun: options.dryRun,
      forced: options.force,
      target: options.target,
      repoRoot,
      selectedTools,
      policy: policySummary(config),
        configPath: join(repoRoot, AIE_CONFIG_FILENAME),
      actions,
      legacy,
      plannedChanges: actions.filter(action => action.status === 'planned').map(actionText),
      completedChanges: [],
      skippedActions: actions.filter(action => action.status === 'skipped').map(actionText),
      warnings,
      errors,
      nextCommand: nextCommand(errors.length === 0),
    },
    writes,
  };
}

export async function buildInitPlan(options: InitOptions): Promise<InitResult> {
  return (await prepareInitPlan(options)).result;
}

export async function runInit(options: InitOptions): Promise<InitResult> {
  const built = await prepareInitPlan(options);
  const result = built.result;
  if (!result.ok || options.dryRun) return result;
  const completedChanges: string[] = [];
  const errors: string[] = [];
  const actions = result.actions.map(action => ({ ...action }));
  for (const write of built.writes) {
    const action = actions.find(item => item.id === write.actionId);
    try {
      await writeFileSafely(write.path, write.content);
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
