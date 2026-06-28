import type { ReviewAgentAdapter, ReviewForgePolicy } from '@tjalve/qube-core';

import { redact } from './gh.js';
import type { GitHubReviewRequestTrigger } from './github_review_types.js';

export const MARKER_PREFIX = 'aie:pr-gate';
export const QUBE_REVIEW_SERVICE_NAME = 'QUBEReview';

export function reviewerId(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'reviewer';
}

export function normalizeHandle(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

export function markerFor(reviewer: string, headSha: string): string {
  return `<!-- ${MARKER_PREFIX}:${reviewerId(reviewer)}:${headSha} -->`;
}

export function triggerFor(name: string): GitHubReviewRequestTrigger {
  return reviewerId(name) === 'copilot' ? 'github-reviewer' : 'comment';
}

export function sanitizeFeedbackText(text: string | undefined): string {
  return (text ?? '')
    .replace(/<!--\s*internal state start\s*-->[\s\S]*?<!--\s*internal state end\s*-->/gi, '')
    .replace(/<details>\s*<summary>\s*Prompt for AI Agents[\s\S]*?<\/details>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/Prompt for AI Agents[\s\S]*$/i, '');
}

export function isCopilotOverview(normalizedText: string, authorLogin?: string | null): boolean {
  if ((authorLogin ?? '').toLowerCase() !== 'copilot-pull-request-reviewer') return false;
  return normalizedText.startsWith('## pull request overview')
    && normalizedText.includes('### reviewed changes')
    && /\bcopilot reviewed \d+ out of \d+ changed files in this pull request\b/i.test(normalizedText);
}

export function isNonActionableSummary(text: string | undefined, authorLogin?: string | null): boolean {
  const normalized = sanitizeFeedbackText(text).replace(/\s+/g, ' ').trim().toLowerCase();
  if (normalized === '') return true;
  if (normalized.includes('no actionable comments were generated')) return true;
  if (normalized.includes('review in progress')) return true;
  if (normalized.includes('currently processing new changes')) return true;
  if (normalized.includes('<summary>📝 walkthrough</summary>')) return true;
  if (normalized.includes('<summary>walkthrough</summary>')) return true;
  if (isCopilotOverview(normalized, authorLogin)) return true;
  if (normalized.startsWith('**no issues found**') || normalized.startsWith('no issues found')) return true;
  return false;
}

export function commentBodyFor(name: string, policy: ReviewForgePolicy, headSha: string): { body: string; marker: string } {
  const handle = normalizeHandle(name);
  const marker = markerFor(name, headSha);
  const requestText = policy.requestText.replace(/\s+/g, ' ').trim();
  const id = reviewerId(name);
  let command = `${handle} review this PR`;
  if (id === 'coderabbit' || id === 'coderabbitai') command = `${handle} review`;
  if (id === 'cubic' || id === 'cubic-dev-ai') command = `${handle} review this PR`;
  if (id === 'qubereview') command = `${handle} review`;
  const body = requestText === '' ? `${marker}\n${command}` : `${marker}\n${command}\n${redact(requestText)}`;
  return { body, marker };
}

export function reviewerMarkerBodyFor(name: string, headSha: string): { body: string; marker: string } {
  const marker = markerFor(name, headSha);
  return { body: `${marker}\nExecutor recorded a configured PR reviewer request for this PR head.`, marker };
}

function createReviewAgentAdapter(input: {
  id: string;
  aliases: readonly string[];
  trigger?: (name: string) => GitHubReviewRequestTrigger;
  commentBody?: (name: string, policy: ReviewForgePolicy, headSha: string) => { body: string; marker: string };
}): ReviewAgentAdapter {
  return {
    id: input.id,
    aliases: input.aliases,
    matches(name: string): boolean {
      const id = reviewerId(name);
      return id === input.id || input.aliases.includes(id);
    },
    triggerFor(name: string): GitHubReviewRequestTrigger {
      return input.trigger ? input.trigger(name) : triggerFor(name);
    },
    commentBodyFor(name: string, policy: ReviewForgePolicy, headSha: string): { body: string; marker: string } {
      return input.commentBody ? input.commentBody(name, policy, headSha) : commentBodyFor(name, policy, headSha);
    },
    reviewerMarkerBodyFor(name: string, headSha: string): { body: string; marker: string } {
      return reviewerMarkerBodyFor(name, headSha);
    },
    isCopilotOverview(normalizedText: string, authorLogin?: string | null): boolean {
      return input.id === 'copilot' && isCopilotOverview(normalizedText, authorLogin);
    },
    isNonActionableSummary(text: string | undefined, authorLogin?: string | null): boolean {
      return isNonActionableSummary(text, authorLogin);
    },
    sanitizeFeedbackText(text: string | undefined): string {
      return sanitizeFeedbackText(text);
    },
  };
}

export function listGitHubReviewAgents(): ReviewAgentAdapter[] {
  return [
    createReviewAgentAdapter({
      id: 'copilot',
      aliases: ['copilot'],
      trigger: () => 'github-reviewer',
    }),
    createReviewAgentAdapter({
      id: 'coderabbit',
      aliases: ['coderabbit', 'coderabbitai'],
      commentBody: (name, policy, headSha) => commentBodyFor(name, policy, headSha),
    }),
    createReviewAgentAdapter({
      id: 'cubic',
      aliases: ['cubic', 'cubic-dev-ai'],
    }),
    createReviewAgentAdapter({
      id: 'qubereview',
      aliases: ['qubereview'],
      commentBody: (name, policy, headSha) => commentBodyFor(name, policy, headSha),
    }),
  ];
}

export function resolveReviewAgent(name: string): ReviewAgentAdapter | null {
  const id = reviewerId(name);
  return listGitHubReviewAgents().find(agent => agent.id === id || agent.aliases.includes(id)) ?? null;
}