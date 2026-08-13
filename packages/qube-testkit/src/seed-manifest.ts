import type { WorkPriority, WorkStatus } from "@tjalve/qube-core";

export const LIVE_SUITE_ENV_VAR = "QUBE_TESTKIT_LIVE";
export const RESOURCE_TAG_PREFIX = "qube-testkit-";

export interface SeedWorkItem {
  readonly id: string;
  readonly title: string;
  readonly status: WorkStatus;
  readonly priority: WorkPriority;
  readonly blockedBy: readonly string[];
  readonly checklist: readonly { readonly text: string; readonly checked: boolean }[];
}

export interface SeedReviewItem {
  readonly id: string;
  readonly title: string;
  readonly comment: string;
}

export interface SeedManifest {
  readonly workItems: readonly SeedWorkItem[];
  readonly reviewItem: SeedReviewItem;
}

export const SHARED_SEED_MANIFEST: SeedManifest = Object.freeze({
  workItems: Object.freeze([
    Object.freeze({
      id: "ready-high",
      title: "Fixture ready issue",
      status: "ready",
      priority: "high",
      blockedBy: Object.freeze([]),
      checklist: Object.freeze([
        Object.freeze({ text: "map codec", checked: true }),
        Object.freeze({ text: "wire harness", checked: false }),
      ]),
    }),
    Object.freeze({
      id: "in-progress-critical",
      title: "Fixture in-progress issue",
      status: "in-progress",
      priority: "critical",
      blockedBy: Object.freeze([]),
      checklist: Object.freeze([
        Object.freeze({ text: "start work", checked: true }),
        Object.freeze({ text: "finish work", checked: false }),
      ]),
    }),
    Object.freeze({
      id: "ready-medium",
      title: "Fixture medium-priority issue",
      status: "ready",
      priority: "medium",
      blockedBy: Object.freeze([]),
      checklist: Object.freeze([Object.freeze({ text: "keep medium coverage", checked: false })]),
    }),
    Object.freeze({
      id: "blocker",
      title: "Fixture blocking issue",
      status: "in-progress",
      priority: "high",
      blockedBy: Object.freeze([]),
      checklist: Object.freeze([Object.freeze({ text: "block dependents", checked: true })]),
    }),
    Object.freeze({
      id: "blocked",
      title: "Fixture blocked issue",
      status: "blocked",
      priority: "high",
      blockedBy: Object.freeze(["blocker"]),
      checklist: Object.freeze([Object.freeze({ text: "wait on blocker", checked: false })]),
    }),
    Object.freeze({
      id: "ready-low",
      title: "Fixture low-priority issue",
      status: "ready",
      priority: "low",
      blockedBy: Object.freeze([]),
      checklist: Object.freeze([Object.freeze({ text: "keep low coverage", checked: false })]),
    }),
  ]),
  reviewItem: Object.freeze({
    id: "review-1",
    title: "Fixture review merge request",
    comment: "Fixture review comment",
  }),
});

export function resourceTag(runId: string): string {
  const normalized = runId.trim();
  if (normalized === "") throw new Error("Provisioner run id must be a non-empty string.");
  return `${RESOURCE_TAG_PREFIX}${normalized}`;
}

export function isResourceTag(value: string): boolean {
  return value.startsWith(RESOURCE_TAG_PREFIX) && value.length > RESOURCE_TAG_PREFIX.length;
}

export function seededTitle(tag: string, title: string): string {
  return `[${tag}] ${title}`;
}

export function renderSeedChecklist(items: SeedWorkItem["checklist"]): string {
  return items.map(item => `- [${item.checked ? "x" : " "}] ${item.text}`).join("\n");
}
