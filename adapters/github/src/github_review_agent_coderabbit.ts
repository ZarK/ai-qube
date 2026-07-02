import type { ReviewAgentAdapter } from '@tjalve/qube-core';

import { createReviewAgentAdapter, emptyOrPromptOnlyFeedback, normalizedFeedbackText } from './github_review_agent_common.js';

export function createCoderabbitReviewAgent(): ReviewAgentAdapter {
  return createReviewAgentAdapter({
    id: 'coderabbit',
    aliases: ['coderabbit', 'coderabbitai'],
    isNonActionableSummary: (text) => {
      const normalized = normalizedFeedbackText(text);
      if (emptyOrPromptOnlyFeedback(text)) return true;
      if (normalized.includes('no actionable comments were generated')) return true;
      if (normalized.includes('review in progress')) return true;
      if (normalized.includes('currently processing new changes')) return true;
      if (normalized.includes('<summary>walkthrough</summary>')) return true;
      if (normalized.includes('walkthrough')) return true;
      return false;
    },
  });
}
