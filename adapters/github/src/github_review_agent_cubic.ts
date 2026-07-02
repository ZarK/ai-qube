import type { ReviewAgentAdapter } from '@tjalve/qube-core';

import { createReviewAgentAdapter, emptyOrPromptOnlyFeedback, normalizedFeedbackText } from './github_review_agent_common.js';

export function createCubicReviewAgent(): ReviewAgentAdapter {
  return createReviewAgentAdapter({
    id: 'cubic',
    aliases: ['cubic', 'cubic-dev-ai'],
    isNonActionableSummary: (text) => {
      const normalized = normalizedFeedbackText(text);
      return emptyOrPromptOnlyFeedback(text) || normalized.startsWith('**no issues found**') || normalized.startsWith('no issues found');
    },
  });
}
