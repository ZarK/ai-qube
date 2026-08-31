import type { ReviewRouteProvenance } from '@tjalve/qube-core';
import { redact } from './redact.js';

export interface ReviewRoutePlanIdentity {
  readonly host: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly tier: string;
}

export function sameReviewRouteIdentity(left: ReviewRoutePlanIdentity, right: ReviewRoutePlanIdentity): boolean {
  return left.host === right.host
    && left.model === right.model
    && left.effort === right.effort
    && left.tier === right.tier;
}

export function reviewRouteReasonMessage(code: string): string {
  if (code === 'model-route-model-unsupported') return 'The selected model is unavailable through the active Review transport.';
  if (code === 'model-route-probe-blocked') return 'The selected Review route failed its readiness probe.';
  if (code === 'model-route-policy-blocked') return 'The selected host rejected a required read-only inspection command.';
  if (code === 'model-route-authentication') return 'The selected Review route is not authenticated.';
  if (code === 'model-route-timeout') return 'The selected Review route exceeded its execution time limit.';
  if (code === 'model-route-process-failed') return 'The selected Review route reached the configured host-fault threshold.';
  if (code === 'model-route-result-decode') return 'The selected Review host returned an ambiguous or unsafe final-result shape.';
  return 'The selected Review route could not produce accepted lane evidence.';
}

const REVIEW_ROUTE_REASON_CODES = new Set([
  'model-route-artifact-digest',
  'model-route-authentication',
  'model-route-checkout-mismatch',
  'model-route-contract-mismatch',
  'model-route-malformed-json',
  'model-route-model-unavailable',
  'model-route-model-unsupported',
  'model-route-multiple-terminal',
  'model-route-nonterminal-result',
  'model-route-output-envelope',
  'model-route-policy-blocked',
  'model-route-probe-blocked',
  'model-route-process-failed',
  'model-route-prompt-delivery',
  'model-route-result-decode',
  'model-route-timeout',
  'model-route-unavailable',
]);

function stableReasonCode(value: string | null): string {
  const candidate = value?.trim() ?? '';
  return REVIEW_ROUTE_REASON_CODES.has(candidate) ? candidate : 'model-route-unavailable';
}

function safeIdentity(value: string): string {
  return redact(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
}

function routeLabel(route: ReviewRoutePlanIdentity): string {
  return `${safeIdentity(route.host)} / ${route.model ? safeIdentity(route.model) : 'host default'} / ${safeIdentity(route.tier)}${route.effort ? ` / ${safeIdentity(route.effort)}` : ''}`;
}

export function buildReviewRouteProvenance(input: {
  readonly selected: ReviewRoutePlanIdentity;
  readonly executed: ReviewRoutePlanIdentity;
  readonly source: 'configured' | 'fallback';
  readonly reasonCode: string | null;
  readonly transport: string | null;
  readonly transportModel: string | null;
  readonly reportedModel: string | null;
  readonly implementationHost: string | null;
}): ReviewRouteProvenance {
  const reportedModel = input.reportedModel ? safeIdentity(input.reportedModel) : null;
  const transportModel = input.transportModel ? safeIdentity(input.transportModel) : null;
  const requestedModel = input.executed.model ? safeIdentity(input.executed.model) : null;
  const modelSource = reportedModel
    ? 'host-reported' as const
    : transportModel
      ? 'transport-resolved' as const
      : requestedModel
        ? 'configured' as const
        : 'host-default' as const;
  const substitutions = [];
  if (input.source === 'fallback') substitutions.push({ kind: 'route' as const, from: routeLabel(input.selected), to: routeLabel(input.executed) });
  if (transportModel && requestedModel && transportModel !== requestedModel) substitutions.push({ kind: 'model' as const, from: requestedModel, to: transportModel });
  const reasonCode = input.source === 'fallback' ? stableReasonCode(input.reasonCode) : null;
  return {
    source: input.source,
    selected: {
      host: safeIdentity(input.selected.host),
      model: input.selected.model ? safeIdentity(input.selected.model) : null,
      effort: input.selected.effort ? safeIdentity(input.selected.effort) : null,
      tier: safeIdentity(input.selected.tier),
    },
    executed: {
      host: safeIdentity(input.executed.host),
      requestedModel,
      transportModel,
      reportedModel,
      modelSource,
      effort: input.executed.effort ? safeIdentity(input.executed.effort) : null,
      tier: safeIdentity(input.executed.tier),
      transport: input.transport ? safeIdentity(input.transport) : null,
    },
    reason: reasonCode ? { code: reasonCode, message: reviewRouteReasonMessage(reasonCode) } : null,
    substitutions,
    degradedReviewerSeparation: input.source === 'fallback'
      && input.implementationHost !== null
      && input.executed.host === input.implementationHost,
  };
}
