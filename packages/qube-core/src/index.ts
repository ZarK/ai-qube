import type { JsonObject } from "./json_value.js";

export type { JsonObject, JsonValue } from "./json_value.js";
export type {
  EvidenceSource,
  EvidenceTrust,
  GateDefinition,
  GateEvidence,
  GateEvidenceReasonCode,
  GateResult,
  GateStage,
} from "./gate_evidence.js";
export { isVerifiedGateEvidence, normalizeGateEvidence } from "./gate_evidence.js";
export type {
  FeedbackTrust,
  Mergeability,
  ResolveReviewThreadInput,
  ResolveReviewThreadResult,
  ReviewConversation,
  ReviewDecision,
  ReviewFeedback,
  ReviewFeedbackSource,
  ReviewItem,
  ReviewItemKey,
  ReviewMergeBlock,
  ReviewMergeBlockReason,
  ReviewState,
} from "./review_item.js";
export { normalizeReviewFeedback, normalizeReviewItem, normalizeReviewItemKey } from "./review_item.js";
export type {
  ReviewAgentAdapter,
  ReviewAgentCommentBody,
  ReviewForgeAdapterKind,
  ReviewForgeCapabilities,
  ReviewForgePlanOptions,
  ReviewForgePolicy,
  ReviewForgeProvider,
  ReviewForgeSnapshot,
  ReviewRequestTrigger,
} from "./review_forge.js";

export type QubeProductId = "bootstrap" | "executor" | "quality" | "umpire";

export type QubeIntegrationSurface = "cli" | "github" | "gitlab" | "linear" | "codex" | "opencode" | "claude-code";
export type QubeCommandClassification =
  | "qube-facing workflow command"
  | "standalone package command"
  | "internal adapter command"
  | "compatibility command";
export type QubePathClassification =
  | "shared QUBE namespace"
  | "standalone product config"
  | "standalone product state"
  | "generated host integration"
  | "implementation-time workflow policy"
  | "test fixture or sample";

export interface QubeProductContract {
  readonly id: QubeProductId;
  readonly packageName: string;
  readonly commandName: string;
  readonly role: string;
  readonly standalone: true;
  readonly surfaces: readonly QubeIntegrationSurface[];
}

export interface QubeAdapterContract {
  readonly id: "github" | "gitlab" | "linear" | "codex" | "opencode" | "claude-code";
  readonly packageName: string;
  readonly surface: QubeIntegrationSurface;
  readonly owns: readonly string[];
  readonly boundary: string;
  readonly capabilities?: readonly QubeAdapterCapability[];
  readonly contractOnly: boolean;
}

export interface QubeAdapterCapability {
  readonly id: string;
  readonly support: "supported" | "standalone" | "unsupported";
  readonly owner: string;
  readonly summary: string;
}

export interface QubeCommandSurfaceContract {
  readonly productId: QubeProductId;
  readonly packageName: string;
  readonly commandPattern: string;
  readonly classification: QubeCommandClassification;
  readonly qubeFacing: boolean;
  readonly schemaRequired: boolean;
  readonly notes: string;
}

export type ProviderResourceKind = "work-item" | "review-item" | "repository" | "gate-evidence" | "policy" | "action-plan";

export interface ProviderSource {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId: string | null;
  readonly url: string | null;
  readonly metadata: JsonObject;
}

export type WorkItemState = "open" | "closed";
export type WorkStatus = "in-progress" | "ready" | "blocked" | "unknown";
export type WorkPriority = "critical" | "high" | "medium" | "low" | "none";

export interface WorkItemKey {
  readonly providerId: string;
  readonly id: string;
}

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

export type WorkProviderId = "github" | "gitlab" | "linear";

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

export interface QubePathContract {
  readonly owner: "qube" | QubeProductId | "repository";
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly committed: boolean;
  readonly migrationPolicy: string;
}

export interface QubeRepoArtifactContract {
  readonly pathPattern: string;
  readonly classification: QubePathClassification;
  readonly productInstalledSurface: boolean;
  readonly notes: string;
}

export const qubeProductContracts = [
  {
    id: "bootstrap",
    packageName: "@tjalve/aib",
    commandName: "aib",
    role: "Plan and bootstrap work from idea to issue queue.",
    standalone: true,
    surfaces: ["cli", "github", "gitlab", "linear", "codex", "opencode", "claude-code"],
  },
  {
    id: "executor",
    packageName: "@tjalve/aie",
    commandName: "aie",
    role: "Execute issue-driven work through repository and review gates.",
    standalone: true,
    surfaces: ["cli", "github", "gitlab", "linear", "codex", "opencode", "claude-code"],
  },
  {
    id: "quality",
    packageName: "@tjalve/aiq",
    commandName: "aiq",
    role: "Evaluate code quality and package readiness across languages.",
    standalone: true,
    surfaces: ["cli"],
  },
  {
    id: "umpire",
    packageName: "@tjalve/aiu",
    commandName: "aiu",
    role: "Coordinate safe agent continuation and host stop hooks.",
    standalone: true,
    surfaces: ["cli", "opencode", "claude-code"],
  },
] as const satisfies readonly QubeProductContract[];

export const qubeCommandSurfaceContracts = [
  {
    productId: "bootstrap",
    packageName: "@tjalve/aib",
    commandPattern: "aib init|status|next|answer|spec *|milestones *|work-items *",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Bootstrap planning commands are safe to discover through QUBE and keep provider mutation behind dry-run or local-file guards.",
  },
  {
    productId: "executor",
    packageName: "@tjalve/aie",
    commandPattern: "aie queue|start|switch|branch *|pr *|complete|review|doctor|schema|init|migrate",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Executor owns GitHub issue, PR, and review workflow behavior plus host instruction init/migration.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq run|check|plan|doctor|setup|status|config|evidence|schema",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Quality workflow commands are discoverable by QUBE; mutating or tool-running commands expose dry-run and supply-chain metadata.",
  },
  {
    productId: "quality",
    packageName: "@tjalve/aiq",
    commandPattern: "aiq bench|watch|serve|hook install|ci setup|ignore write",
    classification: "standalone package command",
    qubeFacing: false,
    schemaRequired: true,
    notes: "AIQ benchmark, daemon, and adapter-guidance commands remain standalone package surfaces and are documented as such.",
  },
  {
    productId: "umpire",
    packageName: "@tjalve/aiu",
    commandPattern: "aiu config|doctor|status|paths|init|migrate|hook-stop|whip",
    classification: "qube-facing workflow command",
    qubeFacing: true,
    schemaRequired: true,
    notes: "Umpire exposes continuation policy, trusted-state, OpenCode host integration, and local whip state commands.",
  },
] as const satisfies readonly QubeCommandSurfaceContract[];

export const qubePathContracts = [
  {
    owner: "qube",
    pathPattern: ".qube/",
    classification: "shared QUBE namespace",
    committed: false,
    migrationPolicy: "Shared namespace for package config, state, logs, locks, cache, and generated artifacts; product migrations preserve legacy paths unless explicitly applied.",
  },
  {
    owner: "bootstrap",
    pathPattern: ".qube/aib/session.json",
    classification: "standalone product state",
    committed: false,
    migrationPolicy: "AIB defaults write QUBE-prefixed state; explicit legacy .bootstrap/session.json paths remain readable and migration must preserve existing state.",
  },
  {
    owner: "quality",
    pathPattern: ".qube/aiq/config.json, .qube/aiq/progress.json, and .qube/aiq/out/",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIQ setup creates missing QUBE-prefixed files only; legacy .aiq/ and aiq.config.json discovery remain migration/backward-compatible inputs.",
  },
  {
    owner: "umpire",
    pathPattern: ".qube/aiu/config.json",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIU init and migrate prefer QUBE-prefixed config, fall back to legacy aiu.config.json, and preserve existing config unless explicit replacement is confirmed.",
  },
  {
    owner: "umpire",
    pathPattern: ".qube/aiu/state, .qube/aiu/locks, .qube/aiu/logs, and .qube/aiu/whip.json",
    classification: "standalone product state",
    committed: false,
    migrationPolicy: "AIU defaults write QUBE-prefixed state; migration detects and preserves legacy .umpire state unless cleanup is explicitly confirmed.",
  },
  {
    owner: "executor",
    pathPattern: ".qube/aie/config.json, .qube/aie/gates/, .qube/aie/reviews/, and .qube/aie/runs/",
    classification: "standalone product config",
    committed: true,
    migrationPolicy: "AIE init writes QUBE-prefixed product config and runtime evidence; legacy aie.config.json remains a repo-policy fallback and copied workflow files remain separate.",
  },
  {
    owner: "repository",
    pathPattern: "products/*/AGENTS.md and products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    committed: true,
    migrationPolicy: "Repository-local implementation artifacts are not package-installed product surfaces unless a product command documents and writes them.",
  },
] as const satisfies readonly QubePathContract[];

export const qubeRepoArtifactContracts = [
  {
    pathPattern: "AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Root agent policy guides monorepo implementation and is not installed by QUBE packages.",
  },
  {
    pathPattern: "products/*/AGENTS.md",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Package-directory agent policies guide repo work on that package; they do not imply installed package behavior.",
  },
  {
    pathPattern: "products/*/aie.config.json",
    classification: "implementation-time workflow policy",
    productInstalledSurface: false,
    notes: "Copied Executor config under package directories is local workflow policy, not evidence that those products own review-agent config.",
  },
  {
    pathPattern: "products/*/test-projects/**",
    classification: "test fixture or sample",
    productInstalledSurface: false,
    notes: "Fixture projects are used by tests and are not product config defaults.",
  },
] as const satisfies readonly QubeRepoArtifactContract[];

export function findQubeProduct(value: string): QubeProductContract | undefined {
  return qubeProductContracts.find((product) =>
    product.id === value || product.packageName === value || product.commandName === value
  );
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function nonEmptyProviderSource(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} was empty or whitespace-only.`);
  return normalized;
}

export function normalizeProviderSource(input: {
  readonly providerId: string;
  readonly resourceKind: ProviderResourceKind;
  readonly resourceId?: string | null;
  readonly url?: string | null;
  readonly metadata?: JsonObject;
}): ProviderSource {
  return {
    providerId: nonEmptyProviderSource(input.providerId, "providerId"),
    resourceKind: input.resourceKind,
    resourceId: input.resourceId === undefined || input.resourceId === null ? null : nonEmptyProviderSource(input.resourceId, "resourceId"),
    url: input.url === undefined ? null : input.url,
    metadata: input.metadata ?? {},
  };
}

export function normalizeWorkItemKey(providerId: string, id: string): WorkItemKey {
  return { providerId: nonEmpty(providerId, "providerId"), id: nonEmpty(id, "id") };
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

export function sourceKey(source: ProviderSource): string {
  return JSON.stringify([source.providerId, source.resourceKind, source.resourceId]);
}

export function uniqueWorkItemKeys(keys: readonly WorkItemKey[]): readonly WorkItemKey[] {
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

export function defineQubeAdapter<T extends QubeAdapterContract>(adapter: T): Readonly<T> {
  return Object.freeze({ ...adapter });
}

export * from "./review.js";
