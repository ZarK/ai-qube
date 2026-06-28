import { validateBranchPattern } from '../core/branch_rules.js';
import type { MigrationPolicy, ReviewContextSources, ReviewLanePolicy, ReviewLaneRequiredMode, ReviewProfileKind, ReviewPromptFragments, ReviewSeverityThreshold, ShippingPolicy } from '../core/policy.js';
import { cloneConfigFile, cloneGate, configFromFile, DEFAULT_CONFIG_FILE } from './defaults.js';
import { DEFAULT_CONFIG_VERSION, type AuditConfig, type BranchConfig, type ConfigFilePolicy, type ConfigFileShape, type ConfigValidationResult, type GateConfig, type GateKind, type GatePolicyConfig, type GateStage, type InstructionConfig, type LabelConfig, type LifecycleConfig, type MigrationConfig, type MilestoneOrderingConfig, type MissingMilestonePolicy, type ProviderCapabilityPolicy, type ProviderSelection, type ProviderSelections, type ReviewConfig, type SupplyChainConfig, type ValidationError } from './types.js';
import type { ReviewAdapterKind } from '../core/policy.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}


function pathJoin(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function rejectUnknownKeys(input: Record<string, unknown>, allowed: readonly string[], path: string, errors: ValidationError[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      const errorPath = pathJoin(path, key) || key;
      errors.push({
        kind: 'unknown',
        path: errorPath,
        message: `${errorPath} is not supported in the current Executor config shape`,
        suggestion: 'Use version, providers, and policy only; run `aie init . --dry-run --force` to review the current config shape.',
      });
    }
  }
}

function readBoolean(input: Record<string, unknown>, field: string, defaultValue: boolean, path: string, errors: ValidationError[]): boolean {
  if (!(field in input)) return defaultValue;
  const value = input[field];
  if (typeof value === 'boolean') return value;
  const errorPath = pathJoin(path, field);
  errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must be a boolean` });
  return defaultValue;
}

function readString(input: Record<string, unknown>, field: string, defaultValue: string, path: string, errors: ValidationError[], options: { allowEmpty: boolean } = { allowEmpty: false }): string {
  if (!(field in input)) return defaultValue;
  const value = input[field];
  if (typeof value === 'string' && (options.allowEmpty || value.trim() !== '')) return options.allowEmpty ? value.trim() : value.trim();
  const errorPath = pathJoin(path, field);
  errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must be ${options.allowEmpty ? 'a string' : 'a non-empty string'}` });
  return defaultValue;
}

function readOptionalNonEmptyString(input: Record<string, unknown>, field: string, path: string, errors: ValidationError[]): string | undefined {
  if (!(field in input) || input[field] === undefined || input[field] === null) return undefined;
  const value = input[field];
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  errors.push({ kind: 'invalid', path, message: `${path} must be a non-empty string when provided` });
  return undefined;
}

function readStringArray(input: Record<string, unknown>, field: string, defaultValue: string[], path: string, errors: ValidationError[]): string[] {
  if (!(field in input)) return [...defaultValue];
  const value = input[field];
  const errorPath = pathJoin(path, field);
  if (!isStringArray(value)) {
    errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must be an array of strings` });
    return [...defaultValue];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const normalized = item.trim();
    if (normalized === '') {
      errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must not contain empty label values` });
      continue;
    }
    if (seen.has(normalized)) {
      errors.push({ kind: 'duplicate', path: errorPath, message: `${errorPath} contains duplicate value ${normalized}` });
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function readBoundedInteger(input: Record<string, unknown>, field: string, defaultValue: number, min: number, max: number, path: string, errors: ValidationError[]): number {
  if (!(field in input)) return defaultValue;
  const value = input[field];
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  const errorPath = pathJoin(path, field);
  errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must be an integer between ${min} and ${max}` });
  return defaultValue;
}

function readPlainObject(input: Record<string, unknown>, field: string, path: string, errors: ValidationError[]): Record<string, unknown> | undefined {
  if (!(field in input)) return undefined;
  const value = input[field];
  if (isPlainObject(value)) return value;
  const errorPath = pathJoin(path, field);
  errors.push({ kind: 'invalid', path: errorPath, message: `${errorPath} must be an object` });
  return undefined;
}

function readStringRecord(value: unknown, path: string, errors: ValidationError[]): Record<string, string> {
  if (value === undefined) return {};
  if (isPlainObject(value) && Object.values(value).every(entry => typeof entry === 'string')) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
  errors.push({ kind: 'invalid', path, message: `${path} must be an object with string values` });
  return {};
}

function readMissingMilestonePolicy(value: unknown, defaultValue: MissingMilestonePolicy, path: string, errors: ValidationError[]): MissingMilestonePolicy {
  if (value === undefined) return defaultValue;
  if (value === 'ignore' || value === 'warn' || value === 'block') return value;
  errors.push({
    kind: 'invalid',
    path,
    message: `${path} must be ignore, warn, or block`,
    suggestion: 'Use "warn" to keep milestone assignment optional while surfacing missing metadata.',
  });
  return defaultValue;
}

function readMergeStrategy(value: unknown, defaultValue: ShippingPolicy['mergeStrategy'], path: string, errors: ValidationError[]): ShippingPolicy['mergeStrategy'] {
  if (value === undefined) return defaultValue;
  if (value === 'squash' || value === 'merge' || value === 'rebase') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be squash, merge, or rebase` });
  return defaultValue;
}

function readReviewAdapter(value: unknown, defaultValue: ReviewAdapterKind, path: string, errors: ValidationError[]): ReviewAdapterKind {
  if (value === undefined) return defaultValue;
  if (value === 'github' || value === 'remote' || value === 'local' || value === 'mixed' || value === 'shadow') return value;
  errors.push({
    kind: 'invalid',
    path,
    message: `${path} must be github, remote, local, mixed, or shadow`,
    suggestion: 'Use "github" or "remote" for remote PR reviewers, "local" for repository-scoped local evidence, "mixed" for both, or "shadow" for non-blocking local evidence.',
  });
  return defaultValue;
}

function readReviewProfile(value: unknown, defaultValue: ReviewProfileKind, path: string, errors: ValidationError[]): ReviewProfileKind {
  if (value === undefined) return defaultValue;
  if (value === 'remote-compatible' || value === 'local-standard' || value === 'local-focused' || value === 'local-comprehensive' || value === 'local-shadow') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be remote-compatible, local-standard, local-focused, local-comprehensive, or local-shadow` });
  return defaultValue;
}

function readReviewSeverity(value: unknown, defaultValue: ReviewSeverityThreshold, path: string, errors: ValidationError[]): ReviewSeverityThreshold {
  if (value === undefined) return defaultValue;
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be low, medium, high, or critical` });
  return defaultValue;
}

function readReviewRequiredMode(value: unknown, defaultValue: ReviewLaneRequiredMode, path: string, errors: ValidationError[]): ReviewLaneRequiredMode {
  if (value === undefined) return defaultValue;
  if (value === 'always' || value === 'when-matched' || value === 'optional' || value === 'shadow') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be always, when-matched, optional, or shadow` });
  return defaultValue;
}

function readReviewRunner(value: unknown, defaultValue: ReviewLanePolicy['runner'], path: string, errors: ValidationError[]): ReviewLanePolicy['runner'] {
  if (value === undefined) return defaultValue;
  if (value === 'github-comment' || value === 'github-reviewer' || value === 'local-command' || value === 'local-host' || value === 'manual-evidence') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be github-comment, github-reviewer, local-command, local-host, or manual-evidence` });
  return defaultValue;
}

function readPromptFragments(value: unknown, defaultValue: ReviewPromptFragments, path: string, errors: ValidationError[]): ReviewPromptFragments {
  if (value === undefined) return {
    repository: [...defaultValue.repository],
    safety: [...defaultValue.safety],
    style: [...defaultValue.style],
    adapter: [...defaultValue.adapter],
    reviewer: [...defaultValue.reviewer],
    commandAddendum: [...defaultValue.commandAddendum],
  };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return {
      repository: [...defaultValue.repository],
      safety: [...defaultValue.safety],
      style: [...defaultValue.style],
      adapter: [...defaultValue.adapter],
      reviewer: [...defaultValue.reviewer],
      commandAddendum: [...defaultValue.commandAddendum],
    };
  }
  rejectUnknownKeys(value, ['repository', 'safety', 'style', 'adapter', 'reviewer', 'commandAddendum'], path, errors);
  return {
    repository: readStringArray(value, 'repository', defaultValue.repository, path, errors),
    safety: readStringArray(value, 'safety', defaultValue.safety, path, errors),
    style: readStringArray(value, 'style', defaultValue.style, path, errors),
    adapter: readStringArray(value, 'adapter', defaultValue.adapter, path, errors),
    reviewer: readStringArray(value, 'reviewer', defaultValue.reviewer, path, errors),
    commandAddendum: readStringArray(value, 'commandAddendum', defaultValue.commandAddendum, path, errors),
  };
}

function readContextSourceMode(value: unknown, defaultValue: 'github' | 'disabled', path: string, errors: ValidationError[]): 'github' | 'disabled' {
  if (value === undefined) return defaultValue;
  if (value === 'github' || value === 'disabled') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be github or disabled` });
  return defaultValue;
}

function readContextSources(value: unknown, defaultValue: ReviewContextSources, path: string, errors: ValidationError[]): ReviewContextSources {
  if (value === undefined) {
    return {
      instructions: [...defaultValue.instructions],
      requirements: [...defaultValue.requirements],
      issues: defaultValue.issues,
      issueComments: defaultValue.issueComments,
      linkedIssues: defaultValue.linkedIssues,
      milestones: defaultValue.milestones,
      pullRequests: defaultValue.pullRequests,
      prComments: defaultValue.prComments,
      reviewThreads: defaultValue.reviewThreads,
    };
  }
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return {
      instructions: [...defaultValue.instructions],
      requirements: [...defaultValue.requirements],
      issues: defaultValue.issues,
      issueComments: defaultValue.issueComments,
      linkedIssues: defaultValue.linkedIssues,
      milestones: defaultValue.milestones,
      pullRequests: defaultValue.pullRequests,
      prComments: defaultValue.prComments,
      reviewThreads: defaultValue.reviewThreads,
    };
  }
  rejectUnknownKeys(value, ['instructions', 'requirements', 'issues', 'issueComments', 'linkedIssues', 'milestones', 'pullRequests', 'prComments', 'reviewThreads'], path, errors);
  return {
    instructions: readStringArray(value, 'instructions', defaultValue.instructions, path, errors),
    requirements: readStringArray(value, 'requirements', defaultValue.requirements, path, errors),
    issues: readContextSourceMode(value.issues, defaultValue.issues, `${path}.issues`, errors),
    issueComments: readContextSourceMode(value.issueComments, defaultValue.issueComments, `${path}.issueComments`, errors),
    linkedIssues: readContextSourceMode(value.linkedIssues, defaultValue.linkedIssues, `${path}.linkedIssues`, errors),
    milestones: readContextSourceMode(value.milestones, defaultValue.milestones, `${path}.milestones`, errors),
    pullRequests: readContextSourceMode(value.pullRequests, defaultValue.pullRequests, `${path}.pullRequests`, errors),
    prComments: readContextSourceMode(value.prComments, defaultValue.prComments, `${path}.prComments`, errors),
    reviewThreads: readContextSourceMode(value.reviewThreads, defaultValue.reviewThreads, `${path}.reviewThreads`, errors),
  };
}

function readReviewLanes(value: unknown, defaultValue: ReviewLanePolicy[], path: string, errors: ValidationError[]): ReviewLanePolicy[] {
  if (value === undefined) return defaultValue.map(lane => ({ ...lane, match: [...lane.match], prompt: [...lane.prompt], tools: [...lane.tools] }));
  if (!Array.isArray(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an array of lane objects` });
    return defaultValue.map(lane => ({ ...lane, match: [...lane.match], prompt: [...lane.prompt], tools: [...lane.tools] }));
  }
  const lanes: ReviewLanePolicy[] = [];
  value.forEach((entry, index) => {
    const lanePath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push({ kind: 'invalid', path: lanePath, message: `${lanePath} must be an object` });
      return;
    }
    rejectUnknownKeys(entry, ['id', 'required', 'match', 'severityThreshold', 'prompt', 'tools', 'runner', 'command'], lanePath, errors);
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : undefined;
    if (!id) {
      errors.push({ kind: 'invalid', path: `${lanePath}.id`, message: `${lanePath}.id must be a non-empty string` });
      return;
    }
    lanes.push({
      id,
      required: readReviewRequiredMode(entry.required, 'when-matched', `${lanePath}.required`, errors),
      match: readStringArray(entry, 'match', [], lanePath, errors),
      severityThreshold: readReviewSeverity(entry.severityThreshold, 'high', `${lanePath}.severityThreshold`, errors),
      prompt: readStringArray(entry, 'prompt', [], lanePath, errors),
      tools: readStringArray(entry, 'tools', [], lanePath, errors),
      runner: readReviewRunner(entry.runner, 'manual-evidence', `${lanePath}.runner`, errors),
      command: readOptionalNonEmptyString(entry, 'command', `${lanePath}.command`, errors),
    });
  });
  return lanes;
}

function readLegacyScriptsPolicy(value: unknown, defaultValue: MigrationPolicy['legacyScripts'], path: string, errors: ValidationError[]): MigrationPolicy['legacyScripts'] {
  if (value === undefined) return defaultValue;
  if (value === 'preserve' || value === 'install-wrappers' || value === 'cleanup') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be preserve, install-wrappers, or cleanup` });
  return defaultValue;
}

function readGateKind(value: unknown, path: string, errors: ValidationError[]): GateKind | undefined {
  if (value === 'build' || value === 'lint' || value === 'typecheck' || value === 'unit' || value === 'integration' || value === 'e2e' || value === 'custom' || value === 'aiq') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be build, lint, typecheck, unit, integration, e2e, custom, or aiq` });
  return undefined;
}

function readGateStage(value: unknown, path: string, errors: ValidationError[]): GateStage | undefined {
  if (value === undefined) return 'all';
  if (value === 'all' || value === 'pre-pr' || value === 'pre-merge') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be all, pre-pr, or pre-merge` });
  return undefined;
}

function readGateBoolean(value: unknown, defaultValue: boolean, path: string, errors: ValidationError[]): boolean | undefined {
  if (value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be a boolean` });
  return undefined;
}

function readGateTimeout(value: unknown, path: string, errors: ValidationError[]): number | undefined {
  if (value === undefined) return 600;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 86400) return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be an integer between 1 and 86400` });
  return undefined;
}

function readGateConfigs(value: unknown, path: string, errors: ValidationError[]): GateConfig[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an array of gate objects` });
    return undefined;
  }
  const gates: GateConfig[] = [];
  value.forEach((entry, index) => {
    const gatePath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push({ kind: 'invalid', path: gatePath, message: `${gatePath} must be an object` });
      return;
    }
    rejectUnknownKeys(entry, ['name', 'kind', 'command', 'stage', 'required', 'timeoutSeconds', 'workingDirectory', 'env', 'externalService'], gatePath, errors);
    const name = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined;
    const command = typeof entry.command === 'string' && entry.command.trim() !== '' ? entry.command.trim() : undefined;
    if (!name) errors.push({ kind: 'invalid', path: `${gatePath}.name`, message: `${gatePath}.name must be a non-empty string` });
    if (!command) errors.push({ kind: 'invalid', path: `${gatePath}.command`, message: `${gatePath}.command must be a non-empty string` });
    const kind = readGateKind(entry.kind, `${gatePath}.kind`, errors);
    const stage = readGateStage(entry.stage, `${gatePath}.stage`, errors);
    const required = readGateBoolean(entry.required, true, `${gatePath}.required`, errors);
    const timeoutSeconds = readGateTimeout(entry.timeoutSeconds, `${gatePath}.timeoutSeconds`, errors);
    let workingDirectory: string | undefined = '.';
    if (entry.workingDirectory !== undefined) {
      if (typeof entry.workingDirectory === 'string' && entry.workingDirectory.trim() !== '') {
        workingDirectory = entry.workingDirectory.trim();
      } else {
        errors.push({ kind: 'invalid', path: `${gatePath}.workingDirectory`, message: `${gatePath}.workingDirectory must be a non-empty string when provided` });
        workingDirectory = undefined;
      }
    }
    const env = readStringRecord(entry.env, `${gatePath}.env`, errors);
    const externalService = readGateBoolean(entry.externalService, false, `${gatePath}.externalService`, errors);
    if (name && command && kind && stage && required !== undefined && timeoutSeconds !== undefined && workingDirectory !== undefined && externalService !== undefined) {
      gates.push({ name, kind, command, stage, required, timeoutSeconds, workingDirectory, env, externalService });
    }
  });
  return gates;
}

function readProviderSelection<K extends string>(input: Record<string, unknown>, field: string, defaultValue: ProviderSelection<K>, supportedKinds: readonly K[], errors: ValidationError[]): ProviderSelection<K> {
  const path = `providers.${field}`;
  const section = readPlainObject(input, field, 'providers', errors);
  if (!section) return { ...defaultValue };
  rejectUnknownKeys(section, ['kind'], path, errors);
  const value = section.kind;
  if (supportedKinds.includes(value as K)) return { kind: value as K };
  if (typeof value !== 'string') {
    errors.push({ kind: 'invalid', path: `${path}.kind`, message: `${path}.kind must be ${supportedKinds.join(' or ')}` });
  } else {
    errors.push({
      kind: 'invalid',
      path: `${path}.kind`,
      message: `${value} is not a supported ${field} provider kind in Executor v1`,
      suggestion: `Use ${supportedKinds.join(' or ')}; additional providers require a real end-to-end implementation before they can be configured.`,
    });
  }
  return { ...defaultValue };
}

function readProviderCapabilities(input: Record<string, unknown>, defaultValue: ProviderCapabilityPolicy, errors: ValidationError[]): ProviderCapabilityPolicy {
  const section = readPlainObject(input, 'capabilities', 'providers', errors);
  if (!section) return { ...defaultValue };
  rejectUnknownKeys(section, ['work', 'review', 'repository', 'ci', 'layout'], 'providers.capabilities', errors);
  return {
    work: readBoolean(section, 'work', defaultValue.work, 'providers.capabilities', errors),
    review: readBoolean(section, 'review', defaultValue.review, 'providers.capabilities', errors),
    repository: readBoolean(section, 'repository', defaultValue.repository, 'providers.capabilities', errors),
    ci: readBoolean(section, 'ci', defaultValue.ci, 'providers.capabilities', errors),
    layout: readBoolean(section, 'layout', defaultValue.layout, 'providers.capabilities', errors),
  };
}

function readProviders(value: unknown, defaultValue: ProviderSelections, errors: ValidationError[]): ProviderSelections {
  if (value === undefined) return cloneConfigFile(DEFAULT_CONFIG_FILE).providers;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'providers', message: 'providers must be an object' });
    return cloneConfigFile(DEFAULT_CONFIG_FILE).providers;
  }
  rejectUnknownKeys(value, ['work', 'review', 'repository', 'ci', 'layout', 'capabilities'], 'providers', errors);
  return {
    work: readProviderSelection(value, 'work', defaultValue.work, ['github', 'gitlab', 'linear'], errors),
    review: readProviderSelection(value, 'review', defaultValue.review, ['github'], errors),
    repository: readProviderSelection(value, 'repository', defaultValue.repository, ['local-git'], errors),
    ci: readProviderSelection(value, 'ci', defaultValue.ci, ['github'], errors),
    layout: readProviderSelection(value, 'layout', defaultValue.layout, ['local'], errors),
    capabilities: readProviderCapabilities(value, defaultValue.capabilities, errors),
  };
}

function readLabels(value: unknown, defaultValue: LabelConfig, errors: ValidationError[]): LabelConfig {
  if (value === undefined) return { priorities: [...defaultValue.priorities], statuses: [...defaultValue.statuses], components: [...defaultValue.components] };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.labels', message: 'policy.labels must be an object' });
    return { priorities: [...defaultValue.priorities], statuses: [...defaultValue.statuses], components: [...defaultValue.components] };
  }
  rejectUnknownKeys(value, ['priorities', 'statuses', 'components'], 'policy.labels', errors);
  return {
    priorities: readStringArray(value, 'priorities', defaultValue.priorities, 'policy.labels', errors),
    statuses: readStringArray(value, 'statuses', defaultValue.statuses, 'policy.labels', errors),
    components: readStringArray(value, 'components', defaultValue.components, 'policy.labels', errors),
  };
}

function readMilestoneOrdering(value: unknown, defaultValue: MilestoneOrderingConfig, errors: ValidationError[]): MilestoneOrderingConfig {
  if (value === undefined) return { ...defaultValue, order: [...defaultValue.order] };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.milestoneOrdering', message: 'policy.milestoneOrdering must be an object' });
    return { ...defaultValue, order: [...defaultValue.order] };
  }
  rejectUnknownKeys(value, ['enabled', 'order', 'missingAssignment'], 'policy.milestoneOrdering', errors);
  return {
    enabled: readBoolean(value, 'enabled', defaultValue.enabled, 'policy.milestoneOrdering', errors),
    order: readStringArray(value, 'order', defaultValue.order, 'policy.milestoneOrdering', errors),
    missingAssignment: readMissingMilestonePolicy(value.missingAssignment, defaultValue.missingAssignment, 'policy.milestoneOrdering.missingAssignment', errors),
  };
}

function readBranch(value: unknown, defaultValue: BranchConfig, errors: ValidationError[]): BranchConfig {
  if (value === undefined) return { ...defaultValue, ignoredAutomationAuthors: [...defaultValue.ignoredAutomationAuthors] };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.branch', message: 'policy.branch must be an object' });
    return { ...defaultValue, ignoredAutomationAuthors: [...defaultValue.ignoredAutomationAuthors] };
  }
  rejectUnknownKeys(value, ['naming', 'baseBranch', 'baseRemote', 'noWorktree', 'blockOnOpenPRs', 'requireBaseBranchFreshness', 'ignoredAutomationAuthors'], 'policy.branch', errors);
  const result = {
    naming: readString(value, 'naming', defaultValue.naming, 'policy.branch', errors),
    baseBranch: readString(value, 'baseBranch', defaultValue.baseBranch, 'policy.branch', errors),
    baseRemote: readString(value, 'baseRemote', defaultValue.baseRemote, 'policy.branch', errors),
    noWorktree: readBoolean(value, 'noWorktree', defaultValue.noWorktree, 'policy.branch', errors),
    blockOnOpenPRs: readBoolean(value, 'blockOnOpenPRs', defaultValue.blockOnOpenPRs, 'policy.branch', errors),
    requireBaseBranchFreshness: readBoolean(value, 'requireBaseBranchFreshness', defaultValue.requireBaseBranchFreshness, 'policy.branch', errors),
    ignoredAutomationAuthors: readStringArray(value, 'ignoredAutomationAuthors', defaultValue.ignoredAutomationAuthors, 'policy.branch', errors),
  };
  const patternError = validateBranchPattern(result.naming);
  if (patternError) {
    errors.push({
      kind: 'invalid',
      path: 'policy.branch.naming',
      message: patternError,
      suggestion: 'Use a branch pattern such as issue/<number>-<slug>.',
    });
  }
  return result;
}

function readLifecycle(value: unknown, defaultValue: LifecycleConfig, errors: ValidationError[]): LifecycleConfig {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.lifecycle', message: 'policy.lifecycle must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['assignOnStart', 'commentOnStart'], 'policy.lifecycle', errors);
  return {
    assignOnStart: readBoolean(value, 'assignOnStart', defaultValue.assignOnStart, 'policy.lifecycle', errors),
    commentOnStart: readBoolean(value, 'commentOnStart', defaultValue.commentOnStart, 'policy.lifecycle', errors),
  };
}

function readShipping(value: unknown, defaultValue: ShippingPolicy, errors: ValidationError[]): ShippingPolicy {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.shipping', message: 'policy.shipping must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['autonomousMode', 'mergeStrategy'], 'policy.shipping', errors);
  return {
    autonomousMode: readBoolean(value, 'autonomousMode', defaultValue.autonomousMode, 'policy.shipping', errors),
    mergeStrategy: readMergeStrategy(value.mergeStrategy, defaultValue.mergeStrategy, 'policy.shipping.mergeStrategy', errors),
  };
}

function readReviews(value: unknown, defaultValue: ReviewConfig, errors: ValidationError[]): ReviewConfig {
  if (value === undefined) {
    return {
      ...defaultValue,
      promptFragments: {
        repository: [...defaultValue.promptFragments.repository],
        safety: [...defaultValue.promptFragments.safety],
        style: [...defaultValue.promptFragments.style],
        adapter: [...defaultValue.promptFragments.adapter],
        reviewer: [...defaultValue.promptFragments.reviewer],
        commandAddendum: [...defaultValue.promptFragments.commandAddendum],
      },
      contextSources: {
        instructions: [...defaultValue.contextSources.instructions],
        requirements: [...defaultValue.contextSources.requirements],
        issues: defaultValue.contextSources.issues,
        issueComments: defaultValue.contextSources.issueComments,
        linkedIssues: defaultValue.contextSources.linkedIssues,
        milestones: defaultValue.contextSources.milestones,
        pullRequests: defaultValue.contextSources.pullRequests,
        prComments: defaultValue.contextSources.prComments,
        reviewThreads: defaultValue.contextSources.reviewThreads,
      },
      lanes: defaultValue.lanes.map(lane => ({ ...lane, match: [...lane.match], prompt: [...lane.prompt], tools: [...lane.tools] })),
      agents: [...defaultValue.agents],
      localAgents: [...defaultValue.localAgents],
    };
  }
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.reviews', message: 'policy.reviews must be an object' });
    return {
      ...defaultValue,
      promptFragments: {
        repository: [...defaultValue.promptFragments.repository],
        safety: [...defaultValue.promptFragments.safety],
        style: [...defaultValue.promptFragments.style],
        adapter: [...defaultValue.promptFragments.adapter],
        reviewer: [...defaultValue.promptFragments.reviewer],
        commandAddendum: [...defaultValue.promptFragments.commandAddendum],
      },
      contextSources: {
        instructions: [...defaultValue.contextSources.instructions],
        requirements: [...defaultValue.contextSources.requirements],
        issues: defaultValue.contextSources.issues,
        issueComments: defaultValue.contextSources.issueComments,
        linkedIssues: defaultValue.contextSources.linkedIssues,
        milestones: defaultValue.contextSources.milestones,
        pullRequests: defaultValue.contextSources.pullRequests,
        prComments: defaultValue.contextSources.prComments,
        reviewThreads: defaultValue.contextSources.reviewThreads,
      },
      lanes: defaultValue.lanes.map(lane => ({ ...lane, match: [...lane.match], prompt: [...lane.prompt], tools: [...lane.tools] })),
      agents: [...defaultValue.agents],
      localAgents: [...defaultValue.localAgents],
    };
  }
  rejectUnknownKeys(value, ['adapter', 'profile', 'severityThreshold', 'promptFragments', 'contextSources', 'lanes', 'agents', 'localAgents', 'waitMinutes', 'requestText'], 'policy.reviews', errors);
  return {
    adapter: readReviewAdapter(value.adapter, defaultValue.adapter, 'policy.reviews.adapter', errors),
    profile: readReviewProfile(value.profile, defaultValue.profile, 'policy.reviews.profile', errors),
    severityThreshold: readReviewSeverity(value.severityThreshold, defaultValue.severityThreshold, 'policy.reviews.severityThreshold', errors),
    promptFragments: readPromptFragments(value.promptFragments, defaultValue.promptFragments, 'policy.reviews.promptFragments', errors),
    contextSources: readContextSources(value.contextSources, defaultValue.contextSources, 'policy.reviews.contextSources', errors),
    lanes: readReviewLanes(value.lanes, defaultValue.lanes, 'policy.reviews.lanes', errors),
    agents: readStringArray(value, 'agents', defaultValue.agents, 'policy.reviews', errors),
    localAgents: readStringArray(value, 'localAgents', defaultValue.localAgents, 'policy.reviews', errors),
    waitMinutes: readBoundedInteger(value, 'waitMinutes', defaultValue.waitMinutes, 0, 120, 'policy.reviews', errors),
    requestText: readString(value, 'requestText', defaultValue.requestText, 'policy.reviews', errors, { allowEmpty: true }),
  };
}

function readGates(value: unknown, defaultValue: GatePolicyConfig, errors: ValidationError[]): GatePolicyConfig {
  if (value === undefined) return { definitions: defaultValue.definitions.map(cloneGate), qualityGates: [...defaultValue.qualityGates], qualityControl: defaultValue.qualityControl };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.gates', message: 'policy.gates must be an object' });
    return { definitions: defaultValue.definitions.map(cloneGate), qualityGates: [...defaultValue.qualityGates], qualityControl: defaultValue.qualityControl };
  }
  rejectUnknownKeys(value, ['definitions', 'qualityGates', 'qualityControl'], 'policy.gates', errors);
  return {
    definitions: readGateConfigs(value.definitions, 'policy.gates.definitions', errors) ?? defaultValue.definitions.map(cloneGate),
    qualityGates: readStringArray(value, 'qualityGates', defaultValue.qualityGates, 'policy.gates', errors),
    qualityControl: readBoolean(value, 'qualityControl', defaultValue.qualityControl, 'policy.gates', errors),
  };
}

function readAudit(value: unknown, defaultValue: AuditConfig, errors: ValidationError[]): AuditConfig {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.audit', message: 'policy.audit must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['manualUiAudit', 'appLaunch', 'target'], 'policy.audit', errors);
  return {
    manualUiAudit: readBoolean(value, 'manualUiAudit', defaultValue.manualUiAudit, 'policy.audit', errors),
    appLaunch: readString(value, 'appLaunch', defaultValue.appLaunch, 'policy.audit', errors, { allowEmpty: true }),
    target: readString(value, 'target', defaultValue.target, 'policy.audit', errors, { allowEmpty: true }),
  };
}

function readInstructions(value: unknown, defaultValue: InstructionConfig, errors: ValidationError[]): InstructionConfig {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.instructions', message: 'policy.instructions must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['opencodeCommandAlias', 'namingRules', 'promptInjectionWarning', 'noCreditWarning', 'implementationGuardrails', 'supplyChainSafety'], 'policy.instructions', errors);
  return {
    opencodeCommandAlias: readBoolean(value, 'opencodeCommandAlias', defaultValue.opencodeCommandAlias, 'policy.instructions', errors),
    namingRules: readBoolean(value, 'namingRules', defaultValue.namingRules, 'policy.instructions', errors),
    promptInjectionWarning: readBoolean(value, 'promptInjectionWarning', defaultValue.promptInjectionWarning, 'policy.instructions', errors),
    noCreditWarning: readBoolean(value, 'noCreditWarning', defaultValue.noCreditWarning, 'policy.instructions', errors),
    implementationGuardrails: readBoolean(value, 'implementationGuardrails', defaultValue.implementationGuardrails, 'policy.instructions', errors),
    supplyChainSafety: readBoolean(value, 'supplyChainSafety', defaultValue.supplyChainSafety, 'policy.instructions', errors),
  };
}

function readMigration(value: unknown, defaultValue: MigrationConfig, errors: ValidationError[]): MigrationConfig {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.migration', message: 'policy.migration must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['legacyScripts', 'compatibilityWrappers', 'cleanupKnownHelpers'], 'policy.migration', errors);
  return {
    legacyScripts: readLegacyScriptsPolicy(value.legacyScripts, defaultValue.legacyScripts, 'policy.migration.legacyScripts', errors),
    compatibilityWrappers: readBoolean(value, 'compatibilityWrappers', defaultValue.compatibilityWrappers, 'policy.migration', errors),
    cleanupKnownHelpers: readBoolean(value, 'cleanupKnownHelpers', defaultValue.cleanupKnownHelpers, 'policy.migration', errors),
  };
}

function readSupplyChain(value: unknown, defaultValue: SupplyChainConfig, errors: ValidationError[]): SupplyChainConfig {
  if (value === undefined) return { ...defaultValue };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy.supplyChain', message: 'policy.supplyChain must be an object' });
    return { ...defaultValue };
  }
  rejectUnknownKeys(value, ['exactVersions', 'intentionalLockfileChanges', 'disableLifecycleScripts', 'pinCiActions', 'packageAgeDays', 'highRiskPackageAgeDays', 'requireApprovalForUnverifiedRisk', 'writePackageManagerDefaults'], 'policy.supplyChain', errors);
  const result = {
    exactVersions: readBoolean(value, 'exactVersions', defaultValue.exactVersions, 'policy.supplyChain', errors),
    intentionalLockfileChanges: readBoolean(value, 'intentionalLockfileChanges', defaultValue.intentionalLockfileChanges, 'policy.supplyChain', errors),
    disableLifecycleScripts: readBoolean(value, 'disableLifecycleScripts', defaultValue.disableLifecycleScripts, 'policy.supplyChain', errors),
    pinCiActions: readBoolean(value, 'pinCiActions', defaultValue.pinCiActions, 'policy.supplyChain', errors),
    packageAgeDays: readBoundedInteger(value, 'packageAgeDays', defaultValue.packageAgeDays, 0, 365, 'policy.supplyChain', errors),
    highRiskPackageAgeDays: readBoundedInteger(value, 'highRiskPackageAgeDays', defaultValue.highRiskPackageAgeDays, 0, 365, 'policy.supplyChain', errors),
    requireApprovalForUnverifiedRisk: readBoolean(value, 'requireApprovalForUnverifiedRisk', defaultValue.requireApprovalForUnverifiedRisk, 'policy.supplyChain', errors),
    writePackageManagerDefaults: readBoolean(value, 'writePackageManagerDefaults', defaultValue.writePackageManagerDefaults, 'policy.supplyChain', errors),
  };
  if (result.highRiskPackageAgeDays < result.packageAgeDays) {
    errors.push({
      kind: 'invalid',
      path: 'policy.supplyChain.highRiskPackageAgeDays',
      message: 'policy.supplyChain.highRiskPackageAgeDays must be greater than or equal to policy.supplyChain.packageAgeDays',
    });
  }
  return result;
}

function readPolicy(value: unknown, defaultValue: ConfigFilePolicy, errors: ValidationError[]): ConfigFilePolicy {
  if (value === undefined) return cloneConfigFile(DEFAULT_CONFIG_FILE).policy;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path: 'policy', message: 'policy must be an object' });
    return cloneConfigFile(DEFAULT_CONFIG_FILE).policy;
  }
  rejectUnknownKeys(value, ['labels', 'milestoneOrdering', 'branch', 'lifecycle', 'shipping', 'reviews', 'gates', 'audit', 'instructions', 'migration', 'supplyChain'], 'policy', errors);
  return {
    labels: readLabels(value.labels, defaultValue.labels, errors),
    milestoneOrdering: readMilestoneOrdering(value.milestoneOrdering, defaultValue.milestoneOrdering, errors),
    branch: readBranch(value.branch, defaultValue.branch, errors),
    lifecycle: readLifecycle(value.lifecycle, defaultValue.lifecycle, errors),
    shipping: readShipping(value.shipping, defaultValue.shipping, errors),
    reviews: readReviews(value.reviews, defaultValue.reviews, errors),
    gates: readGates(value.gates, defaultValue.gates, errors),
    audit: readAudit(value.audit, defaultValue.audit, errors),
    instructions: readInstructions(value.instructions, defaultValue.instructions, errors),
    migration: readMigration(value.migration, defaultValue.migration, errors),
    supplyChain: readSupplyChain(value.supplyChain, defaultValue.supplyChain, errors),
  };
}

export function validateConfig(raw: unknown): ConfigValidationResult {
  const errors: ValidationError[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      errors: [{
        kind: 'invalid',
        path: '.',
        message: 'Config must be a JSON object',
        suggestion: 'Create .qube/aie/config.json containing the current version, providers, and policy sections.',
      }],
    };
  }

  rejectUnknownKeys(raw, ['version', 'providers', 'policy'], '', errors);

  if (raw.version !== DEFAULT_CONFIG_VERSION) {
    errors.push({
      kind: raw.version === undefined ? 'missing' : 'invalid',
      path: 'version',
      message: `version must be ${DEFAULT_CONFIG_VERSION}`,
      suggestion: `Set "version": ${DEFAULT_CONFIG_VERSION}; Executor v1 supports only the current config shape.`,
    });
  }

  const defaults = cloneConfigFile(DEFAULT_CONFIG_FILE);
  const providers = readProviders(raw.providers, defaults.providers, errors);
  const policy = readPolicy(raw.policy, defaults.policy, errors);
  const result: ConfigFileShape = { version: DEFAULT_CONFIG_VERSION, providers, policy };

  return {
    ok: errors.length === 0,
    errors,
    config: errors.length === 0 ? configFromFile(result) : undefined,
  };
}
