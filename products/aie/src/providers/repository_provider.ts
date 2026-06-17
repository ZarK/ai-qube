import type { ActionPlan, ActionResult } from '../core/action_plan.js';
import type { ExecutorPolicy } from '../core/policy.js';
import type { RepoState } from '../core/repo_state.js';
import type { WorkItem } from '../core/work_item.js';

export interface RepositoryProviderCapabilities {
  inspectRepository: boolean;
  inspectBranch: boolean;
  planBranchActions: boolean;
  applyBranchActions: boolean;
}

export interface BranchInspection {
  branchName: string;
  currentBranch: string | null;
  matches: boolean;
  exists: boolean;
  validName: boolean;
  validationError: string | null;
  repoState: RepoState;
}

export interface RepositoryProvider {
  readonly id: 'local-git';
  capabilities(): RepositoryProviderCapabilities;
  inspect(policy: ExecutorPolicy): Promise<RepoState>;
  inspectBranch(item: WorkItem, policy: ExecutorPolicy): Promise<BranchInspection>;
  planBranchSuggestion(item: WorkItem, policy: ExecutorPolicy): Promise<ActionPlan>;
  planBranchCheck(item: WorkItem, policy: ExecutorPolicy): Promise<ActionPlan>;
  planBranchCreate(item: WorkItem, policy: ExecutorPolicy, options: { dryRun: boolean }): Promise<ActionPlan>;
  apply(plan: ActionPlan): Promise<ActionResult[]>;
}
