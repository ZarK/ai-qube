import { selectNextWork } from '../core/queue_rules';
import type { WorkItem } from '../core/work_item';
import { loadQueueState, workItemNumber, type LifecycleServiceContext } from './lifecycle_common';

export interface NextWorkServiceResult {
  workItem: WorkItem | null;
  reason: string;
  multipleInProgress: boolean;
  driftCount: number;
}

export async function runNextWorkService(context: LifecycleServiceContext): Promise<NextWorkServiceResult> {
  const { queue } = await loadQueueState(context);
  const selection = selectNextWork(queue);
  const active = queue.items.filter(item => item.effectiveStatus === 'InProgress');
  if (active.length === 1 && selection.workItem) {
    return { workItem: selection.workItem, reason: `Resuming the single active S-InProgress issue #${workItemNumber(selection.workItem)}`, multipleInProgress: false, driftCount: selection.driftCount };
  }
  if (active.length > 1) {
    return { workItem: null, reason: `Multiple S-InProgress issues detected (${active.length}). This is an actionable problem. Inspect the active issues with \`aie queue --json\`, choose the single issue to continue, and manually remove S-InProgress from the others before any new or resumed work. Selection fails.`, multipleInProgress: true, driftCount: selection.driftCount };
  }
  if (selection.workItem) {
    return { workItem: selection.workItem, reason: `Next ready issue #${workItemNumber(selection.workItem)} (no open blockers, highest priority)`, multipleInProgress: false, driftCount: selection.driftCount };
  }
  return {
    workItem: null,
    reason: 'No ready issues (queue empty or all blocked). Run `aie deps fix --dry-run` if drift exists.',
    multipleInProgress: false,
    driftCount: selection.driftCount,
  };
}
