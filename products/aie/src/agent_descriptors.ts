import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LocalReviewTrust } from './local_review_evidence.js';
import { redact } from './gh.js';

export type AgentRoleKind = 'reviewer' | 'qa' | 'acceptance-verifier' | 'planner' | 'researcher';
export type AgentCategoryId = 'review' | 'qa' | 'acceptance-verification' | 'planning' | 'research';
export type AgentPromptSource = 'builtin' | 'repo-configured' | 'command-supplied' | 'evidence';

export interface CategoryDescriptor {
  id: AgentCategoryId;
  name: string;
  description: string;
  promptFragmentIds: string[];
  outputContract: string;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  description: string;
  roleKind: AgentRoleKind;
  categoryIds: AgentCategoryId[];
  promptSeed: string;
  readOnly: boolean;
  writeScopeHints: string[];
  requiredTools: string[];
  requiredSkills: string[];
  modelPreferences: {
    effort: 'low' | 'medium' | 'high';
    supportsLargeContext: boolean;
  };
  fallbackBehavior: string;
  outputContract: string;
}

export interface AgentToolHost {
  id: string;
  name: string;
  canRun: boolean;
  canComment: boolean;
  canInline: boolean;
  canUseTools: boolean;
  canRunShell: boolean;
  canUseBrowser: boolean;
  canReadMcp: boolean;
  canAccessNetwork: boolean;
  canWriteEvidence: boolean;
  supportsJson: boolean;
  supportsPromptStack: boolean;
  supportsIncrementalReview: boolean;
}

export interface AgentRunRequest {
  descriptorId: string;
  categoryId: AgentCategoryId;
  issueNumber?: number;
  promptStack: RenderedPromptFragment[];
  outputContract: string;
  readOnly: boolean;
}

export interface AgentRunResult {
  descriptorId: string;
  categoryId: AgentCategoryId;
  status: 'passed' | 'failed' | 'needs-work' | 'pending' | 'inconclusive';
  summary: string;
  outputContract: string;
  promptStack: RenderedPromptFragment[];
}

export interface PromptFragmentDefinition {
  id: string;
  relativePath: string;
  trust: LocalReviewTrust;
  sourceCategory: 'policy' | 'descriptor' | 'lane' | 'host' | 'acceptance';
}

export type PromptSourceCategory = PromptFragmentDefinition['sourceCategory'] | 'command';

export interface RenderedPromptFragment {
  id: string;
  source: AgentPromptSource;
  sourceCategory: PromptSourceCategory;
  path: string | null;
  sha256: string;
  trust: LocalReviewTrust;
  text: string;
}

export interface PromptRenderInput {
  hostId: string;
  descriptorId: string;
  categoryId: AgentCategoryId;
  laneIds?: readonly string[];
  contextLines?: readonly string[];
  commandFragments?: readonly string[];
  outputContract?: string;
}

export interface RenderedAgentPrompt {
  descriptor: AgentDescriptor;
  category: CategoryDescriptor;
  host: AgentToolHost;
  promptStack: RenderedPromptFragment[];
  orderedFragmentIds: string[];
  sourcePaths: string[];
  hashes: string[];
  outputContract: string;
  text: string;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT_ROOT = join(PACKAGE_ROOT, 'prompts');

export const DEFAULT_AGENT_TOOL_HOSTS: readonly AgentToolHost[] = [
  {
    id: 'fallback-single-agent',
    name: 'Fallback single agent',
    canRun: false,
    canComment: false,
    canInline: false,
    canUseTools: false,
    canRunShell: false,
    canUseBrowser: false,
    canReadMcp: false,
    canAccessNetwork: false,
    canWriteEvidence: true,
    supportsJson: true,
    supportsPromptStack: true,
    supportsIncrementalReview: false,
  },
  {
    id: 'codex',
    name: 'Codex host prompt',
    canRun: false,
    canComment: false,
    canInline: false,
    canUseTools: true,
    canRunShell: true,
    canUseBrowser: true,
    canReadMcp: true,
    canAccessNetwork: true,
    canWriteEvidence: true,
    supportsJson: true,
    supportsPromptStack: true,
    supportsIncrementalReview: false,
  },
];

export const DEFAULT_CATEGORY_DESCRIPTORS: readonly CategoryDescriptor[] = [
  {
    id: 'review',
    name: 'Review',
    description: 'Review issue compliance, code quality, tests, security, and final merge readiness.',
    promptFragmentIds: ['review-lanes/issue-compliance', 'review-lanes/code-quality', 'review-lanes/tests-quality', 'review-lanes/security', 'review-lanes/final-gate'],
    outputContract: 'Bottom line, actionable findings, recommended fixes, and residual risks.',
  },
  {
    id: 'qa',
    name: 'QA',
    description: 'Inspect manual QA, user-facing behavior, and accessibility evidence.',
    promptFragmentIds: ['review-lanes/manual-qa'],
    outputContract: 'QA status, visible evidence reviewed, blockers, and residual user-facing risk.',
  },
  {
    id: 'acceptance-verification',
    name: 'Acceptance Verification',
    description: 'Verify each acceptance criterion against implementation and evidence.',
    promptFragmentIds: ['acceptance/verify-criterion'],
    outputContract: 'Criterion-by-criterion pass, fail, or inconclusive status with evidence.',
  },
  {
    id: 'planning',
    name: 'Planning',
    description: 'Review plans, specs, decomposition, and sequencing before implementation.',
    promptFragmentIds: ['descriptors/plan-reviewer'],
    outputContract: 'Plan risks, missing constraints, suggested next actions, and decision points.',
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Explore codebase or source material and return cited, bounded findings.',
    promptFragmentIds: ['descriptors/explorer'],
    outputContract: 'Findings, evidence paths, confidence, gaps, and next query targets.',
  },
];

export const DEFAULT_AGENT_DESCRIPTORS: readonly AgentDescriptor[] = [
  {
    id: 'qa-reviewer',
    name: 'QA reviewer',
    description: 'Reviews issue compliance, manual QA evidence, tests, and final readiness.',
    roleKind: 'qa',
    categoryIds: ['review', 'qa', 'acceptance-verification'],
    promptSeed: 'descriptors/qa-reviewer',
    readOnly: true,
    writeScopeHints: ['local evidence files only when explicitly asked'],
    requiredTools: ['repository-read', 'test-output-read'],
    requiredSkills: [],
    modelPreferences: { effort: 'high', supportsLargeContext: true },
    fallbackBehavior: 'Use the fallback single-agent prompt and record inconclusive evidence when context is missing.',
    outputContract: 'Bottom line, blocking findings, addressed/remaining acceptance criteria, and residual risks.',
  },
  {
    id: 'plan-reviewer',
    name: 'Plan reviewer',
    description: 'Reviews implementation plans and specs for feasibility, scope, and missing constraints.',
    roleKind: 'planner',
    categoryIds: ['planning'],
    promptSeed: 'descriptors/plan-reviewer',
    readOnly: true,
    writeScopeHints: [],
    requiredTools: ['repository-read'],
    requiredSkills: [],
    modelPreferences: { effort: 'medium', supportsLargeContext: true },
    fallbackBehavior: 'Return plan gaps and assumptions without editing files.',
    outputContract: 'Plan verdict, required corrections, assumptions, and next safe command.',
  },
  {
    id: 'oracle',
    name: 'Oracle reviewer',
    description: 'Default read-only strategic reviewer for review gates when no host reviewer is configured.',
    roleKind: 'reviewer',
    categoryIds: ['review'],
    promptSeed: 'descriptors/oracle',
    readOnly: true,
    writeScopeHints: [],
    requiredTools: ['repository-read', 'diff-read', 'test-output-read'],
    requiredSkills: [],
    modelPreferences: { effort: 'high', supportsLargeContext: true },
    fallbackBehavior: 'Use fallback-single-agent prompt text when @oracle is unavailable.',
    outputContract: 'Bottom Line, Action Plan with effort tags, Rationale, and residual risks.',
  },
  {
    id: 'explorer',
    name: 'Explorer',
    description: 'Researches codebase or source context and reports bounded findings without changing files.',
    roleKind: 'researcher',
    categoryIds: ['research'],
    promptSeed: 'descriptors/explorer',
    readOnly: true,
    writeScopeHints: [],
    requiredTools: ['repository-search', 'file-read'],
    requiredSkills: [],
    modelPreferences: { effort: 'medium', supportsLargeContext: true },
    fallbackBehavior: 'Return known findings, confidence, and exact missing context.',
    outputContract: 'Findings, evidence paths, confidence, unresolved questions, and next query targets.',
  },
];

const BUILTIN_PROMPT_FRAGMENTS: readonly PromptFragmentDefinition[] = [
  { id: 'safety/review-output-untrusted', relativePath: 'safety/review-output-untrusted.md', trust: 'policy', sourceCategory: 'policy' },
  { id: 'safety/prompt-injection', relativePath: 'safety/prompt-injection.md', trust: 'policy', sourceCategory: 'policy' },
  { id: 'safety/repository-policy', relativePath: 'safety/repository-policy.md', trust: 'policy', sourceCategory: 'policy' },
  { id: 'descriptors/qa-reviewer', relativePath: 'descriptors/qa-reviewer.md', trust: 'policy', sourceCategory: 'descriptor' },
  { id: 'descriptors/plan-reviewer', relativePath: 'descriptors/plan-reviewer.md', trust: 'policy', sourceCategory: 'descriptor' },
  { id: 'descriptors/oracle', relativePath: 'descriptors/oracle.md', trust: 'policy', sourceCategory: 'descriptor' },
  { id: 'descriptors/explorer', relativePath: 'descriptors/explorer.md', trust: 'policy', sourceCategory: 'descriptor' },
  { id: 'review-lanes/issue-compliance', relativePath: 'review-lanes/issue-compliance.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'review-lanes/code-quality', relativePath: 'review-lanes/code-quality.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'review-lanes/tests-quality', relativePath: 'review-lanes/tests-quality.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'review-lanes/security', relativePath: 'review-lanes/security.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'review-lanes/manual-qa', relativePath: 'review-lanes/manual-qa.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'review-lanes/final-gate', relativePath: 'review-lanes/final-gate.md', trust: 'policy', sourceCategory: 'lane' },
  { id: 'acceptance/verify-criterion', relativePath: 'acceptance/verify-criterion.md', trust: 'policy', sourceCategory: 'acceptance' },
  { id: 'hosts/codex', relativePath: 'hosts/codex.md', trust: 'policy', sourceCategory: 'host' },
  { id: 'hosts/fallback-single-agent', relativePath: 'hosts/fallback-single-agent.md', trust: 'policy', sourceCategory: 'host' },
];

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function fragmentDefinition(id: string): PromptFragmentDefinition | null {
  return BUILTIN_PROMPT_FRAGMENTS.find(fragment => fragment.id === id) ?? null;
}

function cloneCategoryDescriptor(category: CategoryDescriptor): CategoryDescriptor {
  return {
    ...category,
    promptFragmentIds: [...category.promptFragmentIds],
  };
}

function cloneAgentDescriptor(agent: AgentDescriptor): AgentDescriptor {
  return {
    ...agent,
    categoryIds: [...agent.categoryIds],
    writeScopeHints: [...agent.writeScopeHints],
    requiredTools: [...agent.requiredTools],
    requiredSkills: [...agent.requiredSkills],
    modelPreferences: { ...agent.modelPreferences },
  };
}

function cloneAgentToolHost(host: AgentToolHost): AgentToolHost {
  return { ...host };
}

function clonePromptFragmentDefinition(fragment: PromptFragmentDefinition): PromptFragmentDefinition {
  return { ...fragment };
}

function readBuiltinFragment(definition: PromptFragmentDefinition): RenderedPromptFragment {
  const absolutePath = join(PROMPT_ROOT, definition.relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing built-in prompt asset ${definition.relativePath}`);
  }
  const text = readFileSync(absolutePath, 'utf8').trimEnd();
  return {
    id: definition.id,
    source: 'builtin',
    sourceCategory: definition.sourceCategory,
    path: join('prompts', definition.relativePath).replace(/\\/g, '/'),
    sha256: hash(text),
    trust: definition.trust,
    text,
  };
}

function commandFragment(text: string): RenderedPromptFragment {
  const redacted = redact(text);
  const sha256 = hash(redacted);
  return {
    id: `command-supplied:${sha256.slice(0, 12)}`,
    source: 'command-supplied',
    sourceCategory: 'command',
    path: null,
    sha256,
    trust: 'untrusted-task-input',
    text: redacted,
  };
}

export function listPromptFragmentDefinitions(): readonly PromptFragmentDefinition[] {
  return BUILTIN_PROMPT_FRAGMENTS.map(clonePromptFragmentDefinition);
}

export function getAgentDescriptor(id: string): AgentDescriptor {
  const descriptor = DEFAULT_AGENT_DESCRIPTORS.find(item => item.id === id);
  if (!descriptor) throw new Error(`Unknown agent descriptor ${id}`);
  return cloneAgentDescriptor(descriptor);
}

export function getCategoryDescriptor(id: AgentCategoryId): CategoryDescriptor {
  const category = DEFAULT_CATEGORY_DESCRIPTORS.find(item => item.id === id);
  if (!category) throw new Error(`Unknown agent category ${id}`);
  return cloneCategoryDescriptor(category);
}

export function getAgentToolHost(id: string): AgentToolHost {
  const host = DEFAULT_AGENT_TOOL_HOSTS.find(item => item.id === id);
  if (!host) throw new Error(`Unknown agent host ${id}`);
  return cloneAgentToolHost(host);
}

export function renderAgentPrompt(input: PromptRenderInput): RenderedAgentPrompt {
  const descriptor = getAgentDescriptor(input.descriptorId);
  const category = getCategoryDescriptor(input.categoryId);
  const host = getAgentToolHost(input.hostId);
  const laneIds = input.laneIds ?? [];
  const fragmentIds = unique([
    'safety/repository-policy',
    'safety/prompt-injection',
    'safety/review-output-untrusted',
    host.id === 'codex' ? 'hosts/codex' : 'hosts/fallback-single-agent',
    descriptor.promptSeed,
    ...category.promptFragmentIds,
    ...laneIds.map(id => `review-lanes/${id}`).filter(id => fragmentDefinition(id) !== null),
  ]);
  const promptStack = [
    ...fragmentIds.map(id => {
      const definition = fragmentDefinition(id);
      if (!definition) throw new Error(`Unknown built-in prompt fragment ${id}`);
      return readBuiltinFragment(definition);
    }),
    ...(input.commandFragments ?? []).map(commandFragment),
  ];
  const outputContract = input.outputContract ?? descriptor.outputContract ?? category.outputContract;
  const context = input.contextLines && input.contextLines.length > 0
    ? `\nContext:\n${input.contextLines.map(line => `- ${redact(line)}`).join('\n')}`
    : '';
  const text = [
    ...promptStack.map(fragment => `## ${fragment.id}\n${fragment.text}`),
    `## Output contract\n${outputContract}`,
    context.trim(),
  ].filter(section => section !== '').join('\n\n');
  return {
    descriptor,
    category,
    host,
    promptStack,
    orderedFragmentIds: promptStack.map(fragment => fragment.id),
    sourcePaths: promptStack.map(fragment => fragment.path).filter((path): path is string => path !== null),
    hashes: promptStack.map(fragment => fragment.sha256),
    outputContract,
    text,
  };
}

export function buildDescriptorSummary() {
  return {
    categories: DEFAULT_CATEGORY_DESCRIPTORS.map(cloneCategoryDescriptor),
    agents: DEFAULT_AGENT_DESCRIPTORS.map(cloneAgentDescriptor),
    hosts: DEFAULT_AGENT_TOOL_HOSTS.map(cloneAgentToolHost),
    promptFragments: BUILTIN_PROMPT_FRAGMENTS.map(fragment => ({
      id: fragment.id,
      path: join('prompts', fragment.relativePath).replace(/\\/g, '/'),
      trust: fragment.trust,
      sourceCategory: fragment.sourceCategory,
    })),
    runnerAvailability: 'unavailable' as const,
  };
}

export function validatePromptAssets(promptRoot = PROMPT_ROOT): { ok: boolean; missing: string[] } {
  const missing = BUILTIN_PROMPT_FRAGMENTS
    .map(fragment => join(promptRoot, fragment.relativePath))
    .filter(path => !existsSync(path))
    .map(path => path.replace(/\\/g, '/'));
  return { ok: missing.length === 0, missing };
}
