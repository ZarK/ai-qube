import type { JsonObject } from "./json_value.js";
import type { ProviderSource } from "./provider_source.js";
import { normalizeProviderSource } from "./provider_source.js";
import type { WorkItemKey } from "./work_item_key.js";
import { normalizeWorkItemKey, uniqueWorkItemKeys } from "./work_item_key.js";

export type WorkItemState = "open" | "closed";
export type WorkStatus = "in-progress" | "ready" | "blocked" | "unknown";
export type WorkPriority = "critical" | "high" | "medium" | "low" | "none";

export interface WorkProject {
  readonly id: string;
  readonly title: string;
  readonly state: "open" | "closed" | "unknown";
  readonly dueOn: string | null;
}

export interface WorkChecklist {
  readonly total: number;
  readonly completed: number;
}

export interface WorkChecklistItem {
  readonly text: string;
  readonly checked: boolean;
}

export interface WorkItem {
  readonly key: WorkItemKey;
  readonly displayId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly state: WorkItemState;
  readonly status: WorkStatus;
  readonly priority: WorkPriority;
  readonly tags: readonly string[];
  readonly assignees: readonly string[];
  readonly project: WorkProject | null;
  readonly blockers: readonly WorkItemKey[];
  readonly blockedBy: readonly WorkItemKey[];
  readonly sequence: string | null;
  readonly checklist: WorkChecklist;
  readonly trustedMetadata: JsonObject;
  readonly source: ProviderSource;
}

const CANONICAL_POSITIVE_INTEGER = /^[1-9]\d*$/;

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

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

export function parseWorkChecklistItems(body: string): WorkChecklistItem[] {
  const items: WorkChecklistItem[] = [];
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*+]\s*)?\[( |x|X)\]\s+(.+?)\s*$/);
    if (!match) continue;
    items.push({ checked: match[1].toLowerCase() === "x", text: match[2] });
  }
  return items;
}

export function parseWorkChecklist(body: string): WorkChecklist {
  const items = parseWorkChecklistItems(body);
  return { total: items.length, completed: items.filter(item => item.checked).length };
}

export function normalizeWorkItem(input: Omit<WorkItem, "blockers" | "blockedBy" | "tags" | "assignees" | "checklist" | "trustedMetadata"> & {
  readonly blockers?: readonly WorkItemKey[];
  readonly blockedBy?: readonly WorkItemKey[];
  readonly tags?: readonly string[];
  readonly assignees?: readonly string[];
  readonly checklist?: WorkChecklist;
  readonly trustedMetadata?: JsonObject;
}): WorkItem {
  const checklist = input.checklist ?? { total: 0, completed: 0 };
  if (!Number.isFinite(checklist.total) || !Number.isInteger(checklist.total)) {
    throw new Error("checklist.total must be a finite integer.");
  }
  if (!Number.isFinite(checklist.completed) || !Number.isInteger(checklist.completed)) {
    throw new Error("checklist.completed must be a finite integer.");
  }
  if (checklist.total < 0) throw new Error("checklist.total must not be negative.");
  if (checklist.completed < 0) throw new Error("checklist.completed must not be negative.");
  if (checklist.completed > checklist.total) throw new Error("checklist.completed must not exceed checklist.total.");
  return {
    ...input,
    key: normalizeWorkItemKey(input.key.providerId, input.key.id),
    source: normalizeProviderSource(input.source),
    displayId: nonEmpty(input.displayId, "displayId"),
    title: nonEmpty(input.title, "title"),
    tags: [...new Set(input.tags ?? [])],
    assignees: [...new Set(input.assignees ?? [])],
    blockers: uniqueWorkItemKeys(input.blockers ?? []),
    blockedBy: uniqueWorkItemKeys(input.blockedBy ?? []),
    checklist,
    trustedMetadata: input.trustedMetadata ?? {},
  };
}
