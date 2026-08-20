import type { ReviewLanePolicy, ReviewRoutePolicy, RoutedReviewHostId } from '../core/policy.js';

export const FRESH_SETUP_PERFORMANCE_MATCH = [
  '**/*indexer*',
  '**/*embed*',
  '**/*retrieval*',
  '**/*queue*',
  '**/*cache*',
  '**/*worker*',
  '**/*stream*',
  '**/*scheduler*',
  '**/*virtual*',
] as const;

export const FRESH_SETUP_UI_MATCH = [
  '**/*.css',
  '**/*.tsx',
  'apps/**',
  'design/**',
] as const;

export const FRESH_SETUP_SECURITY_MATCH = [
  '**/auth/**',
  '**/security/**',
  '**/crypto/**',
  '**/gateway/**',
  '.github/**',
  '.qube/**',
  'package.json',
  '**/package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  '**/*trust*',
  '**/*token*',
  '**/*auth*',
] as const;

export const FRESH_SETUP_ROUTE_TIMEOUT_SECONDS = 900;
export const FRESH_SETUP_ROUTE_MAX_TURNS = 16;

function freshSetupRoute(host: RoutedReviewHostId): ReviewRoutePolicy {
  return {
    host,
    tier: 'review',
    timeoutSeconds: FRESH_SETUP_ROUTE_TIMEOUT_SECONDS,
    maxTurns: FRESH_SETUP_ROUTE_MAX_TURNS,
  };
}

function freshSetupLane(input: {
  id: ReviewLanePolicy['id'];
  required: ReviewLanePolicy['required'];
  match: readonly string[];
  rereview: ReviewLanePolicy['rereview'];
  carryForwardContext: ReviewLanePolicy['carryForwardContext'];
  route?: ReviewRoutePolicy | null;
}): ReviewLanePolicy {
  return {
    id: input.id,
    required: input.required,
    match: [...input.match],
    severityThreshold: 'high',
    prompt: [],
    tools: [],
    runner: 'local-host',
    rereview: input.rereview,
    route: input.route ?? null,
    carryForwardContext: input.carryForwardContext,
    tier: 'review',
    suppress: [],
    maxAdvisoryFindings: null,
    optOut: false,
  };
}

export function defaultFreshSetupLanes(defaultHost: RoutedReviewHostId | null = null): ReviewLanePolicy[] {
  return [
    freshSetupLane({
      id: 'issue-compliance',
      required: 'always',
      match: [],
      rereview: 'always-rerun',
      carryForwardContext: 'all',
    }),
    freshSetupLane({
      id: 'code-quality',
      required: 'always',
      match: [],
      rereview: 'delta',
      carryForwardContext: 'scope',
    }),
    freshSetupLane({
      id: 'performance',
      required: 'when-matched',
      match: FRESH_SETUP_PERFORMANCE_MATCH,
      rereview: 'delta',
      carryForwardContext: 'scope',
    }),
    freshSetupLane({
      id: 'ui-ux-accessibility',
      required: 'when-matched',
      match: FRESH_SETUP_UI_MATCH,
      rereview: 'delta',
      carryForwardContext: 'scope',
    }),
    freshSetupLane({
      id: 'security',
      required: 'when-matched',
      match: FRESH_SETUP_SECURITY_MATCH,
      rereview: 'delta',
      carryForwardContext: 'config',
      route: defaultHost ? freshSetupRoute(defaultHost) : null,
    }),
  ];
}
