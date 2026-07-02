import type { ReviewAgentAdapter } from '@tjalve/qube-core';

import {
  MARKER_PREFIX,
  QUBE_REVIEW_SERVICE_NAME,
  canonicalReviewAgentHandle,
  commentBodyFor,
  markerFor,
  normalizeHandle,
  reviewerId,
  reviewerMarkerBodyFor,
  sanitizeFeedbackText,
  triggerFor,
} from './github_review_agent_common.js';
import { createCoderabbitReviewAgent } from './github_review_agent_coderabbit.js';
import { createCopilotReviewAgent, isCopilotOverview } from './github_review_agent_copilot.js';
import { createCubicReviewAgent } from './github_review_agent_cubic.js';
import { createQubeReviewAgent } from './github_review_agent_qube.js';

export {
  MARKER_PREFIX,
  QUBE_REVIEW_SERVICE_NAME,
  canonicalReviewAgentHandle,
  commentBodyFor,
  isCopilotOverview,
  markerFor,
  normalizeHandle,
  reviewerId,
  reviewerMarkerBodyFor,
  sanitizeFeedbackText,
  triggerFor,
};

export interface GitHubReviewAgentListOptions {
  readonly agents?: readonly string[];
}

interface GitHubReviewAgentFactory {
  readonly id: string;
  readonly aliases: readonly string[];
  create(): ReviewAgentAdapter;
}

const AGENT_FACTORIES: readonly GitHubReviewAgentFactory[] = Object.freeze([
  Object.freeze({ id: 'copilot', aliases: Object.freeze(['copilot']), create: createCopilotReviewAgent }),
  Object.freeze({ id: 'coderabbit', aliases: Object.freeze(['coderabbit', 'coderabbitai']), create: createCoderabbitReviewAgent }),
  Object.freeze({ id: 'cubic', aliases: Object.freeze(['cubic', 'cubic-dev-ai']), create: createCubicReviewAgent }),
  Object.freeze({ id: 'qubereview', aliases: Object.freeze(['qubereview']), create: createQubeReviewAgent }),
]);

const AGENT_CACHE = new Map<string, readonly ReviewAgentAdapter[]>();

function normalizedInstallSet(options: GitHubReviewAgentListOptions = {}): Set<string> | null {
  if (!options.agents) return null;
  const ids = options.agents.map(reviewerId).filter(id => id !== '');
  return new Set(ids);
}

function factoryMatches(factory: GitHubReviewAgentFactory, installSet: Set<string> | null): boolean {
  if (installSet === null) return true;
  return installSet.has(factory.id) || factory.aliases.some(alias => installSet.has(alias));
}

export function listGitHubReviewAgents(options: GitHubReviewAgentListOptions = {}): ReviewAgentAdapter[] {
  const installSet = normalizedInstallSet(options);
  const cacheKey = installSet === null ? '*' : [...installSet].sort().join(',');
  const cached = AGENT_CACHE.get(cacheKey);
  if (cached) return [...cached];
  const agents = AGENT_FACTORIES
    .filter(factory => factoryMatches(factory, installSet))
    .map(factory => factory.create());
  AGENT_CACHE.set(cacheKey, Object.freeze([...agents]));
  return [...agents];
}

export function resolveReviewAgent(name: string, options: GitHubReviewAgentListOptions = {}): ReviewAgentAdapter | null {
  return listGitHubReviewAgents(options).find(agent => agent.matches(name)) ?? null;
}

export function isNonActionableSummary(text: string | undefined, authorLogin?: string | null, options: GitHubReviewAgentListOptions = {}): boolean {
  const agents = listGitHubReviewAgents(options);
  return agents.some(agent => agent.isNonActionableSummary(text, authorLogin));
}
