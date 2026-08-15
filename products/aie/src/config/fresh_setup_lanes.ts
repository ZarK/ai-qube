import type { ReviewLanePolicy } from '../core/policy.js';

export const FRESH_SETUP_SECURITY_MATCH = [
  'package.json',
  '**/package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  '.github/**',
  '**/*auth*',
  '**/*token*',
  '**/*secret*',
] as const;

export const FRESH_SETUP_ROUTE_TIMEOUT_SECONDS = 900;
export const FRESH_SETUP_ROUTE_MAX_TURNS = 16;

function freshSetupLane(input: {
  id: ReviewLanePolicy['id'];
  required: ReviewLanePolicy['required'];
  match: readonly string[];
  rereview: ReviewLanePolicy['rereview'];
  carryForwardContext: ReviewLanePolicy['carryForwardContext'];
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
    route: null,
    carryForwardContext: input.carryForwardContext,
    tier: 'review',
    suppress: [],
    maxAdvisoryFindings: null,
    optOut: false,
  };
}

export function defaultFreshSetupLanes(): ReviewLanePolicy[] {
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
      id: 'security',
      required: 'when-matched',
      match: FRESH_SETUP_SECURITY_MATCH,
      rereview: 'delta',
      carryForwardContext: 'config',
    }),
  ];
}
