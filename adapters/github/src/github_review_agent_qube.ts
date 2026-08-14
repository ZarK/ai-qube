import type { ReviewAgentAdapter } from '@tjalve/qube-core';

import { createReviewAgentAdapter, emptyOrPromptOnlyFeedback, normalizedFeedbackText } from './github_review_agent_common.js';

export function createQubeReviewAgent(): ReviewAgentAdapter {
  return createReviewAgentAdapter({
    id: 'qubereview',
    aliases: ['qubereview'],
    isNonActionableSummary: (text) => {
      const normalized = normalizedFeedbackText(text);
      return emptyOrPromptOnlyFeedback(text)
        || normalized.startsWith('**no issues found**')
        || normalized.startsWith('no issues found')
        || /\bno issues found:/i.test(normalized);
    },
  });
}
