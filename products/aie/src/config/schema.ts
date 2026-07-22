import { validateBranchPattern } from '../core/branch_rules.js';
import { defaultCarryForwardContext } from '../review_focus.js';
import { gitLabConnectionContract, githubConnectionContract, jenkinsConnectionContract, jiraConnectionContract, linearConnectionContract, type ConnectionContract } from '@tjalve/qube-core';
import type { MigrationPolicy, ReviewContextSources, ReviewFailoverPolicy, ReviewLanePolicy, ReviewLaneRequiredMode, ReviewLaneRereviewMode, ReviewModelsPolicy, ReviewProfileKind, ReviewPromptFragments, ReviewRoutePolicy, ReviewSeverityThreshold, ShippingPolicy } from '../core/policy.js';
import { cloneConfigFile, cloneGate, configFromFile, DEFAULT_CONFIG_FILE } from './defaults.js';
import { DEFAULT_CONFIG_VERSION, type AuditConfig, type BranchConfig, type ConfigFilePolicy, type ConfigFileShape, type ConfigValidationResult, type GateConfig, type GateKind, type GatePolicyConfig, type GateStage, type GitHubAppPublisherConfig, type GitHubReviewPublisherConfig, type GitHubReviewPublisherMode, type GitHubTokenPublisherConfig, type InstructionConfig, type JiraIssueLinkRuleConfig, type JiraLinkRelation, type JiraWorkflowSchemaConfig, type JiraWorkPriority, type JiraWorkProviderConfig, type JiraWorkStatus, type LabelConfig, type LifecycleConfig, type MigrationConfig, type MilestoneOrderingConfig, type MissingMilestonePolicy, type ProviderCapabilityPolicy, type ProviderSelection, type ProviderSelections, type ReviewConfig, type ReviewProviderSelection, type SupplyChainConfig, type ValidationError, type WorkProviderSelection } from './types.js';
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

function readEnumRecord<T extends string>(value: unknown, path: string, allowed: readonly T[], errors: ValidationError[]): Record<string, T> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object with string values` });
    return {};
  }
  const allowedSet = new Set<string>(allowed);
  const result: Record<string, T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string' || !allowedSet.has(entry)) {
      errors.push({ kind: 'invalid', path: `${path}.${key}`, message: `${path}.${key} must be ${allowed.join(' or ')}` });
      continue;
    }
    result[key] = entry as T;
  }
  return result;
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
    rejectUnknownKeys(entry, ['id', 'required', 'match', 'severityThreshold', 'prompt', 'tools', 'runner', 'command', 'rereview', 'route', 'carryForwardContext'], lanePath, errors);
    const id = typeof entry.id === 'string' && entry.id.trim() !== '' ? entry.id.trim() : undefined;
    if (!id) {
      errors.push({ kind: 'invalid', path: `${lanePath}.id`, message: `${lanePath}.id must be a non-empty string` });
      return;
    }
    const runner = readReviewRunner(entry.runner, 'manual-evidence', `${lanePath}.runner`, errors);
    const command = readOptionalNonEmptyString(entry, 'command', `${lanePath}.command`, errors);
    const route = readReviewRoute(entry.route, `${lanePath}.route`, errors);
    if (route && runner !== 'local-host') errors.push({ kind: 'invalid', path: `${lanePath}.route`, message: `${lanePath}.route requires runner "local-host"` });
    if (route && command) errors.push({ kind: 'invalid', path: `${lanePath}.route`, message: `${lanePath}.route cannot be combined with command; routed hosts use fixed QUBE invocation adapters` });
    lanes.push({
      id,
      required: readReviewRequiredMode(entry.required, 'when-matched', `${lanePath}.required`, errors),
      match: readStringArray(entry, 'match', [], lanePath, errors),
      severityThreshold: readReviewSeverity(entry.severityThreshold, 'high', `${lanePath}.severityThreshold`, errors),
      prompt: readStringArray(entry, 'prompt', [], lanePath, errors),
      tools: readStringArray(entry, 'tools', [], lanePath, errors),
      runner,
      command,
      rereview: readReviewRereviewMode(entry.rereview, defaultRereviewMode(id), `${lanePath}.rereview`, errors),
      route,
      carryForwardContext: readCarryForwardContext(entry.carryForwardContext, defaultCarryForwardContext(id), `${lanePath}.carryForwardContext`, errors),
    });
  });
  return lanes;
}

function readReviewRoute(value: unknown, path: string, errors: ValidationError[]): ReviewRoutePolicy | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be null or an object with host, tier, timeoutSeconds, and maxTurns` });
    return null;
  }
  rejectUnknownKeys(value, ['host', 'tier', 'timeoutSeconds', 'maxTurns'], path, errors);
  const host = value.host === 'codex' || value.host === 'grok' ? value.host : null;
  if (!host) errors.push({ kind: 'invalid', path: `${path}.host`, message: `${path}.host must be "codex" or "grok"` });
  const tier = value.tier === 'review' || value.tier === 'economy' || value.tier === 'synthesis' ? value.tier : null;
  if (!tier) errors.push({ kind: 'invalid', path: `${path}.tier`, message: `${path}.tier must be "review", "economy", or "synthesis"` });
  const timeoutSeconds = readBoundedInteger(value, 'timeoutSeconds', 600, 30, 3600, path, errors);
  // Fewer than four turns cannot satisfy the routed prompt contract of batched
  // multi-area inspection with the final turn reserved for the JSON result.
  const maxTurns = readBoundedInteger(value, 'maxTurns', 8, 4, 20, path, errors);
  return host && tier ? { host, tier, timeoutSeconds, maxTurns } : null;
}

function readReviewFailover(value: unknown, path: string, errors: ValidationError[]): ReviewFailoverPolicy | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be null or an object with faults and route` });
    return null;
  }
  rejectUnknownKeys(value, ['faults', 'route'], path, errors);
  const faults = readBoundedInteger(value, 'faults', 2, 1, 5, path, errors);
  const route = readReviewRoute(value.route, `${path}.route`, errors);
  if (!route) {
    errors.push({ kind: 'invalid', path: `${path}.route`, message: `${path}.route must name a fallback host route` });
    return null;
  }
  return { faults, route };
}

function readCarryForwardContext(value: unknown, defaultValue: ReviewLanePolicy['carryForwardContext'], path: string, errors: ValidationError[]): ReviewLanePolicy['carryForwardContext'] {
  if (value === undefined) return defaultValue;
  if (value === 'all' || value === 'config' || value === 'scope') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be "all", "config", or "scope"` });
  return defaultValue;
}

export function defaultRereviewMode(laneId: string): ReviewLaneRereviewMode {
  return laneId === 'final-gate' || laneId === 'issue-compliance' ? 'always-rerun' : 'delta';
}

function readReviewRereviewMode(value: unknown, defaultValue: ReviewLaneRereviewMode, path: string, errors: ValidationError[]): ReviewLaneRereviewMode {
  if (value === undefined) return defaultValue;
  if (value === 'always-rerun' || value === 'delta') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be "always-rerun" or "delta"` });
  return defaultValue;
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

function readProviderSelection<K extends string>(input: Record<string, unknown>, field: string, defaultValue: ProviderSelection<K>, supportedKinds: readonly K[], errors: ValidationError[], allowedKeys: readonly string[] = ['kind']): ProviderSelection<K> {
  const path = `providers.${field}`;
  const section = readPlainObject(input, field, 'providers', errors);
  if (!section) return { ...defaultValue };
  rejectUnknownKeys(section, allowedKeys, path, errors);
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

function readJiraLinkRelation(value: unknown, path: string, errors: ValidationError[]): JiraLinkRelation | undefined {
  if (value === 'blocker' || value === 'blockedBy' || value === 'ignore') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be blocker, blockedBy, or ignore` });
  return undefined;
}

function readJiraLinkRules(value: unknown, path: string, errors: ValidationError[]): JiraIssueLinkRuleConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an array of Jira link rule objects` });
    return [];
  }
  const rules: JiraIssueLinkRuleConfig[] = [];
  value.forEach((entry, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push({ kind: 'invalid', path: rulePath, message: `${rulePath} must be an object` });
      return;
    }
    rejectUnknownKeys(entry, ['typeName', 'inward', 'outward'], rulePath, errors);
    const typeName = readString(entry, 'typeName', '', rulePath, errors);
    const inward = readJiraLinkRelation(entry.inward, `${rulePath}.inward`, errors);
    const outward = readJiraLinkRelation(entry.outward, `${rulePath}.outward`, errors);
    if (typeName && inward && outward) rules.push({ typeName, inward, outward });
  });
  return rules;
}

function readJiraWorkflowSchema(value: unknown, path: string, errors: ValidationError[]): JiraWorkflowSchemaConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return undefined;
  }
  rejectUnknownKeys(value, ['statusMap', 'openStatusNames', 'closedStatusNames', 'priorityMap', 'linkRules', 'sprintField', 'epicField'], path, errors);
  const sprintField = readOptionalNonEmptyString(value, 'sprintField', `${path}.sprintField`, errors);
  const epicField = readOptionalNonEmptyString(value, 'epicField', `${path}.epicField`, errors);
  const statusMap = readEnumRecord<JiraWorkStatus>(value.statusMap, `${path}.statusMap`, ['in-progress', 'ready', 'blocked', 'unknown'], errors);
  const openStatusNames = 'openStatusNames' in value ? readStringArray(value, 'openStatusNames', [], path, errors) : undefined;
  const closedStatusNames = 'closedStatusNames' in value ? readStringArray(value, 'closedStatusNames', [], path, errors) : undefined;
  const priorityMap = readEnumRecord<JiraWorkPriority>(value.priorityMap, `${path}.priorityMap`, ['critical', 'high', 'medium', 'low', 'none'], errors);
  const linkRules = 'linkRules' in value ? readJiraLinkRules(value.linkRules, `${path}.linkRules`, errors) : undefined;
  return {
    ...(Object.keys(statusMap).length > 0 ? { statusMap } : {}),
    ...(openStatusNames ? { openStatusNames } : {}),
    ...(closedStatusNames ? { closedStatusNames } : {}),
    ...(Object.keys(priorityMap).length > 0 ? { priorityMap } : {}),
    ...(linkRules ? { linkRules } : {}),
    ...(sprintField ? { sprintField } : {}),
    ...(epicField ? { epicField } : {}),
  };
}

function readJiraWorkProviderConfig(value: unknown, path: string, errors: ValidationError[]): JiraWorkProviderConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return undefined;
  }
  rejectUnknownKeys(value, ['projectKey', 'jql', 'requestTimeoutMs', 'workflowSchema'], path, errors);
  const projectKey = readOptionalNonEmptyString(value, 'projectKey', `${path}.projectKey`, errors);
  const jql = readOptionalNonEmptyString(value, 'jql', `${path}.jql`, errors);
  const requestTimeoutMs = 'requestTimeoutMs' in value ? readBoundedInteger(value, 'requestTimeoutMs', 15_000, 1, 300_000, path, errors) : undefined;
  const workflowSchema = readJiraWorkflowSchema(value.workflowSchema, `${path}.workflowSchema`, errors);
  return {
    ...(projectKey ? { projectKey } : {}),
    ...(jql ? { jql } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
    ...(workflowSchema ? { workflowSchema } : {}),
  };
}

const connectionContracts: Readonly<Record<string, ConnectionContract>> = Object.freeze({
  github: githubConnectionContract,
  gitlab: gitLabConnectionContract,
  linear: linearConnectionContract,
  jira: jiraConnectionContract,
  jenkins: jenkinsConnectionContract,
});

function readConnectionFields(value: unknown, path: string, providerKind: string, errors: ValidationError[]): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object of non-secret connection fields` });
    return undefined;
  }
  const contract = connectionContracts[providerKind];
  const allowedFields = new Set(contract?.configFields.map(field => field.name) ?? []);
  const connection: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/token|secret|password|credential|private.?key|api.?key/iu.test(key)) {
      errors.push({ kind: 'invalid', path: `${path}.${key}`, message: `${path}.${key} must not store credential material; use the connection contract environment variables` });
      continue;
    }
    if (!allowedFields.has(key)) {
      errors.push({ kind: 'unknown', path: `${path}.${key}`, message: `${path}.${key} is not declared by the ${providerKind} connection contract` });
      continue;
    }
    const field = contract?.configFields.find(candidate => candidate.name === key);
    if (field?.valueType === 'string' && typeof entry === 'string' && entry.trim().length > 0) {
      // Reject values that look like credentials rather than public connection settings.
      if (typeof entry === 'string' && (entry.includes('BEGIN ') || /^(gh[pousr]_|github_pat_|ghs_|glpat-|lin_api_|ATATT)/i.test(entry) || entry.length > 512)) {
        errors.push({ kind: 'invalid', path: `${path}.${key}`, message: `${path}.${key} must be a non-secret connection field, not credential material` });
        continue;
      }
      connection[key] = entry;
      continue;
    }
    errors.push({ kind: 'invalid', path: `${path}.${key}`, message: `${path}.${key} must be a non-empty string` });
  }
  return connection;
}

function readProbeConnections(value: unknown, errors: ValidationError[]): ProviderSelections['connections'] {
  const path = 'providers.connections';
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object keyed by connection adapter id` });
    return {};
  }
  rejectUnknownKeys(value, Object.keys(connectionContracts), path, errors);
  const connections: ProviderSelections['connections'] = {};
  for (const providerKind of Object.keys(connectionContracts)) {
    const connection = readConnectionFields(value[providerKind], `${path}.${providerKind}`, providerKind, errors);
    if (connection) connections[providerKind as keyof ProviderSelections['connections']] = connection;
  }
  return connections;
}

function readWorkProviderSelection(input: Record<string, unknown>, defaultValue: WorkProviderSelection, errors: ValidationError[]): WorkProviderSelection {
  const path = 'providers.work';
  const section = readPlainObject(input, 'work', 'providers', errors);
  if (!section) return { ...defaultValue };
  rejectUnknownKeys(section, ['kind', 'jira', 'connection'], path, errors);
  const selection = readProviderSelection(input, 'work', defaultValue, ['github', 'gitlab', 'linear', 'jira'], errors, ['kind', 'jira', 'connection']) as WorkProviderSelection;
  const jira = readJiraWorkProviderConfig(section.jira, `${path}.jira`, errors);
  const connection = readConnectionFields(section.connection, `${path}.connection`, selection.kind, errors);
  return {
    ...selection,
    ...(jira ? { jira } : {}),
    ...(connection ? { connection } : {}),
  };
}

function readGitHubAppPublisherConfig(value: unknown, path: string, errors: ValidationError[]): GitHubAppPublisherConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return undefined;
  }
  rejectUnknownKeys(value, ['appId', 'installationId', 'privateKeyPath', 'privateKeyEnv', 'login'], path, errors);
  const appId = readOptionalNonEmptyString(value, 'appId', `${path}.appId`, errors);
  const installationId = readOptionalNonEmptyString(value, 'installationId', `${path}.installationId`, errors);
  const privateKeyPath = readOptionalNonEmptyString(value, 'privateKeyPath', `${path}.privateKeyPath`, errors);
  const privateKeyEnv = readOptionalNonEmptyString(value, 'privateKeyEnv', `${path}.privateKeyEnv`, errors);
  const login = readOptionalNonEmptyString(value, 'login', `${path}.login`, errors);
  if (!appId || !installationId) {
    errors.push({ kind: 'invalid', path, message: `${path} requires appId and installationId` });
    return undefined;
  }
  if (!privateKeyPath && !privateKeyEnv) {
    errors.push({ kind: 'invalid', path, message: `${path} requires privateKeyPath or privateKeyEnv (never store private key material in config)` });
    return undefined;
  }
  if (privateKeyPath && privateKeyEnv) {
    errors.push({ kind: 'invalid', path, message: `${path} accepts only one of privateKeyPath or privateKeyEnv` });
  }
  // Reject values that look like embedded PEMs or tokens rather than paths/env names.
  if (privateKeyEnv && (privateKeyEnv.includes('BEGIN') || privateKeyEnv.includes('\n') || privateKeyEnv.length > 128)) {
    errors.push({ kind: 'invalid', path: `${path}.privateKeyEnv`, message: `${path}.privateKeyEnv must be an environment variable name, not key material` });
    return undefined;
  }
  if (privateKeyPath && (privateKeyPath.includes('BEGIN') || privateKeyPath.includes('\n'))) {
    errors.push({ kind: 'invalid', path: `${path}.privateKeyPath`, message: `${path}.privateKeyPath must be a filesystem path, not key material` });
    return undefined;
  }
  return {
    appId,
    installationId,
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(privateKeyEnv ? { privateKeyEnv } : {}),
    ...(login ? { login } : {}),
  };
}

function readGitHubTokenPublisherConfig(value: unknown, path: string, errors: ValidationError[]): GitHubTokenPublisherConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return undefined;
  }
  rejectUnknownKeys(value, ['env', 'login'], path, errors);
  const env = readOptionalNonEmptyString(value, 'env', `${path}.env`, errors);
  const login = readOptionalNonEmptyString(value, 'login', `${path}.login`, errors);
  if (!env) {
    errors.push({ kind: 'invalid', path: `${path}.env`, message: `${path}.env is required and must be an environment variable name` });
    return undefined;
  }
  if (env.includes('BEGIN') || env.includes('\n') || env.startsWith('ghp_') || env.startsWith('github_pat_') || env.length > 128) {
    errors.push({ kind: 'invalid', path: `${path}.env`, message: `${path}.env must be an environment variable name, not a token value` });
    return undefined;
  }
  return { env, ...(login ? { login } : {}) };
}

function readGitHubReviewPublisherConfig(value: unknown, path: string, errors: ValidationError[]): GitHubReviewPublisherConfig | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object` });
    return undefined;
  }
  rejectUnknownKeys(value, ['mode', 'githubApp', 'token'], path, errors);
  let mode: GitHubReviewPublisherMode = 'user';
  if (value.mode === 'user' || value.mode === 'github-app' || value.mode === 'token') {
    mode = value.mode;
  } else if (value.mode !== undefined) {
    errors.push({ kind: 'invalid', path: `${path}.mode`, message: `${path}.mode must be user, github-app, or token` });
  }
  const githubApp = readGitHubAppPublisherConfig(value.githubApp, `${path}.githubApp`, errors);
  const token = readGitHubTokenPublisherConfig(value.token, `${path}.token`, errors);
  if (mode === 'github-app' && !githubApp) {
    errors.push({ kind: 'invalid', path: `${path}.githubApp`, message: `${path}.githubApp is required when mode is github-app` });
  }
  if (mode === 'token' && !token) {
    errors.push({ kind: 'invalid', path: `${path}.token`, message: `${path}.token is required when mode is token` });
  }
  return {
    mode,
    ...(githubApp ? { githubApp } : {}),
    ...(token ? { token } : {}),
  };
}

function readReviewProviderSelection(input: Record<string, unknown>, defaultValue: ReviewProviderSelection, errors: ValidationError[]): ReviewProviderSelection {
  const path = 'providers.review';
  const section = readPlainObject(input, 'review', 'providers', errors);
  if (!section) return { ...defaultValue };
  rejectUnknownKeys(section, ['kind', 'publisher', 'connection'], path, errors);
  const selection = readProviderSelection(input, 'review', defaultValue, ['github', 'gitlab'], errors, ['kind', 'publisher', 'connection']) as ReviewProviderSelection;
  const publisher = readGitHubReviewPublisherConfig(section.publisher, `${path}.publisher`, errors);
  if (publisher && selection.kind !== 'github') {
    errors.push({ kind: 'invalid', path: `${path}.publisher`, message: `${path}.publisher is only supported when providers.review.kind is github` });
  }
  const connection = readConnectionFields(section.connection, `${path}.connection`, selection.kind, errors);
  return {
    ...selection,
    ...(publisher && selection.kind === 'github' ? { publisher } : {}),
    ...(connection ? { connection } : {}),
  };
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
  rejectUnknownKeys(value, ['work', 'review', 'repository', 'ci', 'layout', 'connections', 'capabilities'], 'providers', errors);
  return {
    work: readWorkProviderSelection(value, defaultValue.work, errors),
    review: readReviewProviderSelection(value, defaultValue.review, errors),
    repository: readProviderSelection(value, 'repository', defaultValue.repository, ['local-git'], errors),
    ci: (() => {
      const path = 'providers.ci';
      const section = readPlainObject(value, 'ci', 'providers', errors);
      if (!section) return { ...defaultValue.ci };
      rejectUnknownKeys(section, ['kind', 'connection'], path, errors);
      const selection = readProviderSelection(value, 'ci', defaultValue.ci, ['github'], errors, ['kind', 'connection']);
      const connection = readConnectionFields(section.connection, `${path}.connection`, selection.kind, errors);
      return {
        ...selection,
        ...(connection ? { connection } : {}),
      };
    })(),
    layout: readProviderSelection(value, 'layout', defaultValue.layout, ['local'], errors),
    connections: readProbeConnections(value.connections, errors),
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
  rejectUnknownKeys(value, ['adapter', 'profile', 'severityThreshold', 'promptFragments', 'contextSources', 'lanes', 'agents', 'localAgents', 'waitMinutes', 'concurrency', 'requestText', 'carryForwardPublish', 'nitCap', 'models', 'route', 'failover'], 'policy.reviews', errors);
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
    concurrency: readBoundedInteger(value, 'concurrency', defaultValue.concurrency, 1, 8, 'policy.reviews', errors),
    requestText: readString(value, 'requestText', defaultValue.requestText, 'policy.reviews', errors, { allowEmpty: true }),
    carryForwardPublish: readCarryForwardPublish(value.carryForwardPublish, defaultValue.carryForwardPublish, 'policy.reviews.carryForwardPublish', errors),
    nitCap: readBoundedInteger(value, 'nitCap', defaultValue.nitCap, 1, Number.MAX_SAFE_INTEGER, 'policy.reviews', errors),
    models: readReviewModels(value.models, 'policy.reviews.models', errors),
    route: readReviewRoute(value.route, 'policy.reviews.route', errors),
    failover: readReviewFailover(value.failover, 'policy.reviews.failover', errors),
  };
}

function readCarryForwardPublish(value: unknown, defaultValue: 'note' | 'none', path: string, errors: ValidationError[]): 'note' | 'none' {
  if (value === undefined) return defaultValue;
  if (value === 'note' || value === 'none') return value;
  errors.push({ kind: 'invalid', path, message: `${path} must be "note" or "none"` });
  return defaultValue;
}

function readReviewModelTierMap(value: unknown, path: string, errors: ValidationError[]): ReviewModelsPolicy['review'] {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object mapping hosts to model bindings` });
    return {};
  }
  rejectUnknownKeys(value, ['codex', 'claude-code', 'opencode', 'grok'], path, errors);
  const tierMap: ReviewModelsPolicy['review'] = {};
  for (const host of ['codex', 'claude-code', 'opencode', 'grok'] as const) {
    const binding = value[host];
    if (binding === undefined) continue;
    if (!isPlainObject(binding)) {
      errors.push({ kind: 'invalid', path: `${path}.${host}`, message: `${path}.${host} must be an object with model and optional effort` });
      continue;
    }
    rejectUnknownKeys(binding, ['model', 'effort'], `${path}.${host}`, errors);
    const model = typeof binding.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(binding.model.trim()) ? binding.model.trim() : null;
    if (model === null) {
      errors.push({ kind: 'invalid', path: `${path}.${host}.model`, message: `${path}.${host}.model must be a model identifier using letters, digits, dots, dashes, underscores, colons, or slashes` });
      continue;
    }
    let effort: 'low' | 'medium' | 'high' | null = null;
    if (binding.effort !== undefined && binding.effort !== null) {
      if (binding.effort === 'low' || binding.effort === 'medium' || binding.effort === 'high') effort = binding.effort;
      else errors.push({ kind: 'invalid', path: `${path}.${host}.effort`, message: `${path}.${host}.effort must be "low", "medium", or "high"` });
    }
    tierMap[host] = { model, effort };
  }
  return tierMap;
}

function readReviewModels(value: unknown, path: string, errors: ValidationError[]): ReviewModelsPolicy {
  if (value === undefined) return { review: {}, economy: {}, synthesis: {} };
  if (!isPlainObject(value)) {
    errors.push({ kind: 'invalid', path, message: `${path} must be an object with review, economy, and synthesis tiers` });
    return { review: {}, economy: {}, synthesis: {} };
  }
  rejectUnknownKeys(value, ['review', 'economy', 'synthesis'], path, errors);
  return {
    review: readReviewModelTierMap(value.review, `${path}.review`, errors),
    economy: readReviewModelTierMap(value.economy, `${path}.economy`, errors),
    synthesis: readReviewModelTierMap(value.synthesis, `${path}.synthesis`, errors),
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
