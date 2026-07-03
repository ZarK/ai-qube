import type { JsonObject } from "./json_value.js";

export type ActionMutation = "work-provider" | "review-provider" | "repository-provider" | "local-only" | "none";
export type ActionStatus = "planned" | "completed" | "failed" | "skipped";
export type ActionKind =
  | "assign-work"
  | "close-work"
  | "comment-work"
  | "create-branch"
  | "merge-review"
  | "pause-work"
  | "replace-status-labels"
  | "request-review"
  | "resume-work"
  | "sync-work-status"
  | "run-gate"
  | "start-work"
  | "update-policy"
  | "update-review"
  | "verify-repository";
export type ActionTargetKind = "work-item" | "review-item" | "repository" | "gate" | "policy";

export interface ActionTarget {
  readonly kind: ActionTargetKind;
  readonly id: string;
}

export interface ActionFailure {
  readonly operation: string;
  readonly cause: string;
  readonly nextAction: string;
}

export interface Action {
  readonly id: string;
  readonly kind: ActionKind;
  readonly target: ActionTarget;
  readonly mutation: ActionMutation;
  readonly description: string;
  readonly preconditions: readonly string[];
  readonly expectedResult: string;
  readonly status: ActionStatus;
  readonly details: JsonObject;
  readonly failure: ActionFailure | null;
}

export interface ActionResult {
  readonly actionId: string;
  readonly status: Exclude<ActionStatus, "planned">;
  readonly failure: ActionFailure | null;
  readonly details: JsonObject;
}

export interface ActionSummary {
  readonly plannedCount: number;
  readonly completedCount: number;
  readonly failedCount: number;
  readonly skippedCount: number;
}

export interface ActionPlan {
  readonly id: string;
  readonly purpose: string;
  readonly dryRun: boolean;
  readonly actions: readonly Action[];
  readonly summary: ActionSummary;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function createAction(input: Omit<Action, "preconditions" | "status" | "details" | "failure"> & {
  readonly preconditions?: readonly string[];
  readonly status?: ActionStatus;
  readonly details?: JsonObject;
  readonly failure?: ActionFailure | null;
}): Action {
  nonEmpty(input.kind, "kind");
  return {
    ...input,
    id: nonEmpty(input.id, "id"),
    kind: input.kind,
    target: { ...input.target, id: nonEmpty(input.target.id, "target.id") },
    description: nonEmpty(input.description, "description"),
    expectedResult: nonEmpty(input.expectedResult, "expectedResult"),
    preconditions: input.preconditions ?? [],
    status: input.status ?? "planned",
    details: input.details ?? {},
    failure: input.failure ?? null,
  };
}

export function summarizeActions(actions: readonly Action[]): ActionSummary {
  return {
    plannedCount: actions.filter((action) => action.status === "planned").length,
    completedCount: actions.filter((action) => action.status === "completed").length,
    failedCount: actions.filter((action) => action.status === "failed").length,
    skippedCount: actions.filter((action) => action.status === "skipped").length,
  };
}

export function createActionPlan(input: Omit<ActionPlan, "summary">): ActionPlan {
  return {
    ...input,
    id: nonEmpty(input.id, "id"),
    purpose: nonEmpty(input.purpose, "purpose"),
    summary: summarizeActions(input.actions),
  };
}
