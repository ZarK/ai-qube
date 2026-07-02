import type { ReviewAgentAdapter } from '@tjalve/qube-core';

import { createReviewAgentAdapter, emptyOrPromptOnlyFeedback, normalizedFeedbackText } from './github_review_agent_common.js';

export function isCopilotOverview(normalizedText: string, authorLogin?: string | null): boolean {
  if ((authorLogin ?? '').toLowerCase() !== 'copilot-pull-request-reviewer') return false;
  return normalizedText.startsWith('## pull request overview')
    && normalizedText.includes('### reviewed changes')
    && /\bcopilot reviewed \d+ out of \d+ changed files in this pull request\b/i.test(normalizedText);
}

export function createCopilotReviewAgent(): ReviewAgentAdapter {
  return createReviewAgentAdapter({
    id: 'copilot',
    aliases: ['copilot'],
    trigger: () => 'github-reviewer',
    isCopilotOverview,
    isNonActionableSummary: (text, authorLogin) => emptyOrPromptOnlyFeedback(text) || isCopilotOverview(normalizedFeedbackText(text), authorLogin),
  });
}
