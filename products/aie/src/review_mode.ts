import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewAdapterKind, ReviewMode, ReviewRoutePolicy } from './core/policy.js';
import type { Config } from './config/types.js';

export const REVIEW_MODES: readonly ReviewMode[] = ['external', 'host', 'isolated'];
export type { ReviewMode };

export interface ReviewModeInputs {
  readonly mode?: ReviewMode | null;
  readonly adapter: ReviewAdapterKind;
  readonly route: ReviewRoutePolicy | null;
  readonly lanes?: ReadonlyArray<{ readonly route?: ReviewRoutePolicy | null }>;
}

export function isReviewMode(value: unknown): value is ReviewMode {
  return REVIEW_MODES.includes(value as ReviewMode);
}

export function inferReviewMode(input: Omit<ReviewModeInputs, 'mode'>): ReviewMode {
  const hasRoute = input.route !== null || (input.lanes ?? []).some(lane => lane.route != null);
  if (hasRoute) return 'isolated';
  if (input.adapter === 'local' || input.adapter === 'mixed' || input.adapter === 'shadow') return 'host';
  return 'external';
}

export function resolveReviewMode(input: ReviewModeInputs): ReviewMode {
  if (input.mode) return input.mode;
  return inferReviewMode(input);
}

export function reviewModeOf(config: Pick<Config, 'reviewMode' | 'reviewAdapter' | 'reviewRoute' | 'reviewLanes'>): ReviewMode {
  return resolveReviewMode({
    mode: config.reviewMode,
    adapter: config.reviewAdapter,
    route: config.reviewRoute,
    lanes: config.reviewLanes,
  });
}

export function reviewModeDisplayName(mode: ReviewMode): string {
  if (mode === 'external') return 'external';
  if (mode === 'host') return 'host';
  return 'isolated';
}

export function readAiePackageVersion(): string {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = require(join(here, '..', 'package.json')) as { version?: string };
  return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version : '0.0.0';
}
