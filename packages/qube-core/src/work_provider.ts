import type { ActionPlan, ActionResult } from "./action_plan.js";
import type { WorkItem } from "./work_item.js";
import type { WorkItemKey } from "./work_item_key.js";

export interface ExecutorPolicy {
  readonly branchPattern: string;
  readonly baseBranch: string;
  readonly requireCleanWorktree: boolean;
  readonly requireBaseCurrent: boolean;
  readonly maxActiveIssues: number;
  readonly blockOnOpenPullRequests: boolean;
  readonly linkedWorktreeExecution: boolean;
  readonly statusLabels: {
    readonly ready: string;
    readonly inProgress: string;
    readonly blocked: string;
    readonly completed: string;
  };
}

export interface WorkProviderCapabilities {
  readonly listOpenWork: boolean;
  readonly loadWork: boolean;
  readonly planStatusSync: boolean;
  readonly planLifecycleMutations: boolean;
  readonly applyLifecycleMutations: boolean;
  readonly commentMutations: boolean;
  readonly reviewIntegration: boolean;
  readonly ciMergeStatus: boolean;
}

export type WorkProviderId = "github" | "gitlab" | "linear" | "jira";

export interface WorkProvider {
  readonly id: WorkProviderId;
  capabilities(): WorkProviderCapabilities;
  listOpenWorkItems(): Promise<readonly WorkItem[]>;
  getWorkItem(key: WorkItemKey): Promise<WorkItem>;
  planStatusSync(items: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planStart(item: WorkItem, policy: ExecutorPolicy): ActionPlan;
  planPause(item: WorkItem, openItems: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planComplete(item: WorkItem, dependents: readonly WorkItem[], policy: ExecutorPolicy): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
}
