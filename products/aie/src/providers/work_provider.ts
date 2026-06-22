import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { WorkItem, WorkItemKey } from '../core/work_item.js';

export interface WorkProviderCapabilities {
  listOpenWork: boolean;
  loadWork: boolean;
  planStatusSync: boolean;
  planLifecycleMutations: boolean;
  applyLifecycleMutations: boolean;
}

export type WorkProviderId = 'github' | 'linear';

export interface WorkProvider {
  readonly id: WorkProviderId;
  capabilities(): WorkProviderCapabilities;
  listOpenWorkItems(): Promise<WorkItem[]>;
  getWorkItem(key: WorkItemKey): Promise<WorkItem>;
  planStatusSync(items: WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planStart(item: WorkItem, policy: ExecutorPolicy): ActionPlan;
  planPause(item: WorkItem, openItems: WorkItem[], policy: ExecutorPolicy): ActionPlan;
  planComplete(item: WorkItem, dependents: WorkItem[], policy: ExecutorPolicy): ActionPlan;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
}
