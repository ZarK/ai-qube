import type { JsonObject } from './json_value.js';

export type ActionMutation = 'work-provider' | 'review-provider' | 'repository-provider' | 'local-only' | 'none';
export type ActionStatus = 'planned' | 'completed' | 'failed' | 'skipped';
export type ActionKind =
  | 'assign-work'
  | 'close-work'
  | 'comment-work'
  | 'create-branch'
  | 'merge-review'
  | 'pause-work'
  | 'replace-status-labels'
  | 'request-review'
  | 'resume-work'
  | 'sync-work-status'
  | 'run-gate'
  | 'start-work'
  | 'update-policy'
  | 'update-review'
  | 'verify-repository';
export type ActionTargetKind = 'work-item' | 'review-item' | 'repository' | 'gate' | 'policy';

export interface ActionTarget {
  kind: ActionTargetKind;
  id: string;
}

export interface ActionFailure {
  operation: string;
  cause: string;
  nextAction: string;
}

export interface Action {
  id: string;
  kind: ActionKind;
  target: ActionTarget;
  mutation: ActionMutation;
  description: string;
  preconditions: string[];
  expectedResult: string;
  status: ActionStatus;
  details: JsonObject;
  failure: ActionFailure | null;
}

export interface ActionResult {
  actionId: string;
  status: Exclude<ActionStatus, 'planned'>;
  failure: ActionFailure | null;
  details: JsonObject;
}

export interface ActionSummary {
  plannedCount: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface ActionPlan {
  id: string;
  purpose: string;
  dryRun: boolean;
  actions: Action[];
  summary: ActionSummary;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function createAction(input: Omit<Action, 'preconditions' | 'status' | 'details' | 'failure'> & {
  preconditions?: string[];
  status?: ActionStatus;
  details?: JsonObject;
  failure?: ActionFailure | null;
}): Action {
  nonEmpty(input.kind, 'kind');
  return {
    ...input,
    id: nonEmpty(input.id, 'id'),
    kind: input.kind,
    target: { ...input.target, id: nonEmpty(input.target.id, 'target.id') },
    description: nonEmpty(input.description, 'description'),
    expectedResult: nonEmpty(input.expectedResult, 'expectedResult'),
    preconditions: input.preconditions ?? [],
    status: input.status ?? 'planned',
    details: input.details ?? {},
    failure: input.failure ?? null,
  };
}

export function summarizeActions(actions: Action[]): ActionSummary {
  return {
    plannedCount: actions.filter(action => action.status === 'planned').length,
    completedCount: actions.filter(action => action.status === 'completed').length,
    failedCount: actions.filter(action => action.status === 'failed').length,
    skippedCount: actions.filter(action => action.status === 'skipped').length,
  };
}

export function createActionPlan(input: Omit<ActionPlan, 'summary'>): ActionPlan {
  return {
    ...input,
    id: nonEmpty(input.id, 'id'),
    purpose: nonEmpty(input.purpose, 'purpose'),
    summary: summarizeActions(input.actions),
  };
}
