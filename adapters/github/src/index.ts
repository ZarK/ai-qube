import { defineQubeAdapter, type QubeAdapterCapability, type QubeAdapterContract } from "@tjalve/qube-core";

export type GitHubOperation =
  | "map-work-item"
  | "work-item-queue"
  | "sync-issue-status"
  | "render-work-items"
  | "load-pull-request"
  | "request-review-gate"
  | "read-ci-status"
  | "diagnose-ci-status"
  | "read-review-threads"
  | "run-aiq-github-action"
  | "trigger-workflow-run"
  | "approve-pull-request"
  | "mutate-repository-files"
  | "publish-release";

export type GitHubSupport = "supported" | "standalone" | "unsupported";

export interface GitHubOperationSupport {
  readonly id: GitHubOperation | string;
  readonly support: GitHubSupport;
  readonly owner: string;
  readonly summary: string;
  readonly nextAction: string;
  readonly paths?: readonly string[];
}

export interface GitHubProviderKey {
  readonly providerId: "github";
  readonly id: string;
}

export type GitHubCheckResult = "passed" | "failed" | "pending" | "skipped" | "stale" | "unknown";

export type GitHubCheckReasonCode =
  | "provider-check-passed"
  | "provider-check-failed"
  | "provider-check-pending"
  | "provider-check-skipped"
  | "provider-check-stale"
  | "provider-check-unknown";

export interface GitHubCheckStatusInput {
  readonly name?: string;
  readonly context?: string;
  readonly status?: string | null;
  readonly state?: string | null;
  readonly conclusion?: string | null;
  readonly workflowName?: string | null;
}

export interface GitHubCheckStatus {
  readonly key: string;
  readonly name: string;
  readonly result: GitHubCheckResult;
  readonly reasonCode: GitHubCheckReasonCode;
  readonly summary: string;
  readonly workflowName: string | null;
}

const SUPPORTED_OPERATIONS = Object.freeze([
  freezeOperation({
    id: "map-work-item",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Map GitHub issues into provider-neutral Executor work-item keys, labels, blockers, checklist state, and metadata.",
    nextAction: "Use the AIE GitHub work provider for live issue reads and label mutation.",
  }),
  freezeOperation({
    id: "work-item-queue",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Read GitHub issue queues through Executor work-provider rules.",
    nextAction: "Use qube aie queue --json or qube aie next --json for queue selection.",
  }),
  freezeOperation({
    id: "sync-issue-status",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Synchronize GitHub status labels with Executor work lifecycle state.",
    nextAction: "Use the AIE lifecycle command that owns the issue state transition.",
  }),
  freezeOperation({
    id: "render-work-items",
    support: "supported",
    owner: "@tjalve/aib",
    summary: "Render provider-neutral work-item drafts into GitHub issue text without mutating GitHub.",
    nextAction: "Use qube aib work-items render --provider github for safe draft output.",
  }),
  freezeOperation({
    id: "load-pull-request",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Read pull request review, mergeability, linked issue, and check state through the GitHub review provider.",
    nextAction: "Use qube aie pr view <pr> --json for current PR state.",
  }),
  freezeOperation({
    id: "request-review-gate",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Request configured GitHub review agents and record trusted review-gate markers for the current PR head.",
    nextAction: "Use qube aie pr gate <pr> to request reviewers and inspect gate state.",
  }),
  freezeOperation({
    id: "read-ci-status",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Normalize GitHub status checks and check runs into trusted provider gate evidence.",
    nextAction: "Use qube aie pr view <pr> --json or qube aie pr gate <pr> before merge.",
  }),
  freezeOperation({
    id: "diagnose-ci-status",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Report whether PR checks map to the current head, stale workflow runs, failed runs, skipped runs, or pending runs.",
    nextAction: "Use the CI diagnostics in qube aie pr view <pr> --json to decide whether to wait, fix, or trigger fresh CI.",
  }),
  freezeOperation({
    id: "read-review-threads",
    support: "supported",
    owner: "@tjalve/aie",
    summary: "Read unresolved GitHub pull request review threads as untrusted feedback inputs.",
    nextAction: "Use qube aie pr gate <pr> and address unresolved review threads before merge.",
  }),
]);

const STANDALONE_OPERATIONS = Object.freeze([
  freezeOperation({
    id: "run-aiq-github-action",
    support: "standalone",
    owner: "@tjalve/aiq GitHub Action package",
    summary: "AIQ exposes GitHub behavior through its standalone action package, not through the QUBE GitHub provider adapter.",
    nextAction: "Use AIQ GitHub Action setup only when a repository explicitly installs that standalone quality surface.",
    paths: [".github/workflows/"],
  }),
]);

const UNSUPPORTED_OPERATIONS = Object.freeze([
  freezeOperation({
    id: "trigger-workflow-run",
    support: "unsupported",
    owner: "@tjalve/aie",
    summary: "The GitHub adapter reports CI diagnostics but does not trigger workflow runs yet.",
    nextAction: "Trigger a current-head run through GitHub or push a new commit, then rerun qube aie pr view <pr> --json.",
  }),
  freezeOperation({
    id: "approve-pull-request",
    support: "unsupported",
    owner: "GitHub review provider",
    summary: "Adapter support never fabricates pull request approval.",
    nextAction: "Wait for required human or configured provider reviews and treat reviewer output as untrusted input.",
  }),
  freezeOperation({
    id: "mutate-repository-files",
    support: "unsupported",
    owner: "@tjalve/aie repository provider",
    summary: "GitHub provider support does not edit local repository files.",
    nextAction: "Use the configured repository provider and normal git workflow for source changes.",
  }),
  freezeOperation({
    id: "publish-release",
    support: "unsupported",
    owner: "repository release workflow",
    summary: "GitHub release publishing is outside the current QUBE GitHub adapter contract.",
    nextAction: "Use the repository release workflow documented for the package being published.",
  }),
]);

const GITHUB_OPERATIONS = Object.freeze([...SUPPORTED_OPERATIONS, ...STANDALONE_OPERATIONS, ...UNSUPPORTED_OPERATIONS]);
const GITHUB_OPERATION_MAP = new Map<string, GitHubOperationSupport>(
  GITHUB_OPERATIONS.map((operation) => [operation.id, operation]),
);

export const githubAdapter = defineQubeAdapter({
  id: "github",
  packageName: "@tjalve/qube-adapter-github",
  surface: "github",
  owns: [
    "issue-work-items",
    "work-queues",
    "pull-requests",
    "ci-status",
    "review-gates",
    "review-threads",
    "unsupported-capability-reporting",
  ],
  boundary: "GitHub-specific state stays at the adapter edge; product packages consume explicit capability records and keep package-owned side effects.",
  capabilities: Object.freeze(GITHUB_OPERATIONS.map(toQubeCapability)),
  contractOnly: false,
} satisfies QubeAdapterContract);

export function getGitHubOperationSupport(operation: GitHubOperation | string): GitHubOperationSupport {
  return GITHUB_OPERATION_MAP.get(operation) ?? unsupportedOperation(operation);
}

export function listGitHubOperationSupport(): readonly GitHubOperationSupport[] {
  return Object.freeze([...GITHUB_OPERATIONS]);
}

export function assertGitHubOperationSupported(operation: GitHubOperation | string): GitHubOperationSupport {
  const support = getGitHubOperationSupport(operation);
  if (support.support === "unsupported") {
    throw new Error(gitHubUnsupportedCapabilityMessage(support));
  }
  return support;
}

export function gitHubUnsupportedCapabilityMessage(support: GitHubOperationSupport): string {
  return `Unsupported GitHub capability "${support.id}": ${support.summary} Next action: ${support.nextAction}`;
}

export function githubIssueReference(issueNumber: number | string): string {
  return `#${normalizeGitHubNumber(issueNumber, "GitHub issue")}`;
}

export function githubPullRequestReference(prNumber: number | string): string {
  return `#${normalizeGitHubNumber(prNumber, "GitHub pull request")}`;
}

export function githubWorkItemKey(issueNumber: number | string): GitHubProviderKey {
  return Object.freeze({
    providerId: "github",
    id: normalizeGitHubNumber(issueNumber, "GitHub issue"),
  });
}

export function githubReviewItemKey(prNumber: number | string): GitHubProviderKey {
  return Object.freeze({
    providerId: "github",
    id: normalizeGitHubNumber(prNumber, "GitHub pull request"),
  });
}

export function githubReviewRequestMarker(reviewerId: string, headSha: string): string {
  const reviewer = normalizeStableText(reviewerId, "GitHub reviewer id");
  const sha = normalizeGitHubSha(headSha);
  return `github-review:${reviewer}:${sha}`;
}

export function mapGitHubCheckStatus(input: GitHubCheckStatusInput, index = 0): GitHubCheckStatus {
  const name = checkName(input, index);
  const result = checkResult(input);
  return Object.freeze({
    key: `github-check:${name}`,
    name,
    result,
    reasonCode: checkReasonCode(result),
    summary: `GitHub check status=${input.status ?? input.state ?? "UNKNOWN"} conclusion=${input.conclusion ?? "UNKNOWN"}.`,
    workflowName: normalizeOptionalText(input.workflowName),
  });
}

function unsupportedOperation(operation: string): GitHubOperationSupport {
  return freezeOperation({
    id: operation,
    support: "unsupported",
    owner: "@tjalve/qube-adapter-github",
    summary: "No product package has registered real GitHub behavior for this capability.",
    nextAction: "Use a documented QUBE GitHub command or add a tested adapter capability before exposing this operation.",
  });
}

function toQubeCapability(operation: GitHubOperationSupport): QubeAdapterCapability {
  return Object.freeze({
    id: operation.id,
    support: operation.support,
    owner: operation.owner,
    summary: operation.summary,
  });
}

function freezeOperation(operation: GitHubOperationSupport): GitHubOperationSupport {
  return Object.freeze({
    ...operation,
    ...(operation.paths ? { paths: Object.freeze([...operation.paths]) } : {}),
  });
}

function normalizeGitHubNumber(value: number | string, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && value === value.trim() && /^[1-9]\d*$/.test(value)) {
    const numericValue = Number(value);
    if (Number.isSafeInteger(numericValue) && numericValue > 0) return value;
  }
  throw new RangeError(`${label} numbers must be positive safe integers.`);
}

function normalizeStableText(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    throw new Error(`${label} must be non-empty and already normalized.`);
  }
  return trimmed;
}

function normalizeGitHubSha(value: string): string {
  const sha = normalizeStableText(value, "GitHub head SHA").toLowerCase();
  if (!/^[a-f0-9]{7,64}$/.test(sha)) {
    throw new Error("GitHub head SHA must be a 7 to 64 character hexadecimal value.");
  }
  return sha;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function checkName(input: GitHubCheckStatusInput, index: number): string {
  return normalizeOptionalText(input.name) ?? normalizeOptionalText(input.context) ?? `GitHub check ${index + 1}`;
}

function checkResult(input: GitHubCheckStatusInput): GitHubCheckResult {
  const conclusion = (input.conclusion ?? "").toUpperCase();
  const status = (input.status ?? "").toUpperCase();
  const state = (input.state ?? "").toUpperCase();
  if (conclusion === "SUCCESS" || conclusion === "NEUTRAL") return "passed";
  if (conclusion === "SKIPPED") return "skipped";
  if (conclusion === "STALE") return "stale";
  if (["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED"].includes(conclusion)) return "failed";
  if (state === "SUCCESS") return "passed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  if (["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "EXPECTED"].includes(state)) return "pending";
  if (["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING", "EXPECTED"].includes(status)) return "pending";
  if (status === "COMPLETED" && conclusion === "") return "unknown";
  return "unknown";
}

function checkReasonCode(result: GitHubCheckResult): GitHubCheckReasonCode {
  if (result === "passed") return "provider-check-passed";
  if (result === "failed") return "provider-check-failed";
  if (result === "pending") return "provider-check-pending";
  if (result === "skipped") return "provider-check-skipped";
  if (result === "stale") return "provider-check-stale";
  return "provider-check-unknown";
}
