import type { JsonObject } from './json_value.js';
import type { ProviderSource } from './provider_source.js';

export type WorkItemState = 'open' | 'closed';
export type WorkStatus = 'in-progress' | 'ready' | 'blocked' | 'unknown';
export type WorkPriority = 'critical' | 'high' | 'medium' | 'low' | 'none';

export interface WorkItemKey {
  providerId: string;
  id: string;
}

export interface WorkProject {
  id: string;
  title: string;
  state: 'open' | 'closed' | 'unknown';
  dueOn: string | null;
}

export interface WorkChecklist {
  total: number;
  completed: number;
}

export interface WorkItem {
  key: WorkItemKey;
  displayId: string;
  title: string;
  body: string;
  url: string | null;
  state: WorkItemState;
  status: WorkStatus;
  priority: WorkPriority;
  tags: string[];
  assignees: string[];
  project: WorkProject | null;
  blockers: WorkItemKey[];
  blockedBy: WorkItemKey[];
  sequence: string | null;
  checklist: WorkChecklist;
  trustedMetadata: JsonObject;
  source: ProviderSource;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === '') throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

export function normalizeWorkItemKey(providerId: string, id: string): WorkItemKey {
  return { providerId: nonEmpty(providerId, 'providerId'), id: nonEmpty(id, 'id') };
}

export function sameWorkItemKey(left: WorkItemKey, right: WorkItemKey): boolean {
  return left.providerId === right.providerId && left.id === right.id;
}

const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

export function workItemKeyNumber(key: WorkItemKey, context = `work item ${key.providerId}:${key.id}`): number {
  if (!CANONICAL_POSITIVE_INTEGER.test(key.id)) {
    throw new Error(`Failed to render issue number: ${context} key.id must be a canonical positive base-10 integer; use a provider-specific adapter before rendering issue-number commands.`);
  }
  const number = Number.parseInt(key.id, 10);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Failed to render issue number: ${context} key.id exceeds JavaScript's safe integer range; use a provider-specific adapter before rendering issue-number commands.`);
  }
  return number;
}

export function maybeWorkItemKeyNumber(key: WorkItemKey): number | null {
  if (!CANONICAL_POSITIVE_INTEGER.test(key.id)) return null;
  const number = Number.parseInt(key.id, 10);
  return Number.isSafeInteger(number) ? number : null;
}

export function workItemNumber(item: WorkItem): number {
  return workItemKeyNumber(item.key, item.displayId);
}

export function uniqueWorkItemKeys(keys: WorkItemKey[]): WorkItemKey[] {
  const seen = new Set<string>();
  const unique: WorkItemKey[] = [];
  for (const key of keys) {
    const normalizedKey = normalizeWorkItemKey(key.providerId, key.id);
    const stableKey = JSON.stringify([normalizedKey.providerId, normalizedKey.id]);
    if (!seen.has(stableKey)) {
      seen.add(stableKey);
      unique.push(normalizedKey);
    }
  }
  return unique;
}

export function normalizeWorkItem(input: Omit<WorkItem, 'blockers' | 'blockedBy' | 'tags' | 'assignees' | 'checklist' | 'trustedMetadata'> & {
  blockers?: WorkItemKey[];
  blockedBy?: WorkItemKey[];
  tags?: string[];
  assignees?: string[];
  checklist?: WorkChecklist;
  trustedMetadata?: JsonObject;
}): WorkItem {
  const checklist = input.checklist ?? { total: 0, completed: 0 };
  if (!Number.isFinite(checklist.total) || !Number.isInteger(checklist.total)) {
    throw new Error('checklist.total must be a finite integer.');
  }
  if (!Number.isFinite(checklist.completed) || !Number.isInteger(checklist.completed)) {
    throw new Error('checklist.completed must be a finite integer.');
  }
  if (checklist.total < 0) throw new Error('checklist.total must not be negative.');
  if (checklist.completed < 0) throw new Error('checklist.completed must not be negative.');
  if (checklist.completed > checklist.total) throw new Error('checklist.completed must not exceed checklist.total.');
  return {
    ...input,
    key: normalizeWorkItemKey(input.key.providerId, input.key.id),
    displayId: nonEmpty(input.displayId, 'displayId'),
    title: nonEmpty(input.title, 'title'),
    tags: [...new Set(input.tags ?? [])],
    assignees: [...new Set(input.assignees ?? [])],
    blockers: uniqueWorkItemKeys(input.blockers ?? []),
    blockedBy: uniqueWorkItemKeys(input.blockedBy ?? []),
    checklist,
    trustedMetadata: input.trustedMetadata ?? {},
  };
}
