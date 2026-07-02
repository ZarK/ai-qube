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

export function canonicalReviewAgentHandle(name: string): string {
  const id = reviewerId(name);
  if (id === 'coderabbit') return '@coderabbitai';
  if (id === 'cubic') return '@cubic-dev-ai';
  if (id === 'qubereview') return '@QUBEReview';
  return normalizeHandle(name);
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

export function normalizedFeedbackText(text: string | undefined): string {
  return sanitizeFeedbackText(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function emptyOrPromptOnlyFeedback(text: string | undefined): boolean {
  return normalizedFeedbackText(text) === '';
}

export function commentBodyFor(name: string, policy: ReviewForgePolicy, headSha: string): { body: string; marker: string } {
  const handle = canonicalReviewAgentHandle(name);
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

export function createReviewAgentAdapter(input: {
  id: string;
  aliases: readonly string[];
  trigger?: (name: string) => GitHubReviewRequestTrigger;
  commentBody?: (name: string, policy: ReviewForgePolicy, headSha: string) => { body: string; marker: string };
  isCopilotOverview?: (normalizedText: string, authorLogin?: string | null) => boolean;
  isNonActionableSummary?: (text: string | undefined, authorLogin?: string | null) => boolean;
}): ReviewAgentAdapter {
  return Object.freeze({
    id: input.id,
    aliases: Object.freeze([...input.aliases]),
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
      return input.isCopilotOverview ? input.isCopilotOverview(normalizedText, authorLogin) : false;
    },
    isNonActionableSummary(text: string | undefined, authorLogin?: string | null): boolean {
      return input.isNonActionableSummary ? input.isNonActionableSummary(text, authorLogin) : emptyOrPromptOnlyFeedback(text);
    },
    sanitizeFeedbackText(text: string | undefined): string {
      return sanitizeFeedbackText(text);
    },
  });
}
