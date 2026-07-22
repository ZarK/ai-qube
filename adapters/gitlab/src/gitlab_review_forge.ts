import {
  createAction,
  createActionPlan,
  normalizeGateEvidence,
  normalizeProviderSource,
  normalizeReviewFinding,
  normalizeReviewItem,
  type Action,
  type ActionPlan,
  type ActionResult,
  type GateEvidence,
  type JsonObject,
  type ReviewFeedback,
  type ReviewFinding,
  type ReviewForgeCapabilities,
  type ReviewForgePlanOptions,
  type ReviewForgePolicy,
  type ReviewForgeProvider,
  type ResolveReviewThreadInput,
  type ResolveReviewThreadResult,
  type ReviewItem,
  type ReviewItemKey,
  type ReviewLaneReviewPublishInput,
  type ReviewLaneReviewPublishResult,
  type ReviewMergeBlock,
} from "@tjalve/qube-core";
import { createHash } from "node:crypto";
import { FetchGitLabReviewRestClient, normalizeMergeRequestIid, required } from "./gitlab_review_client.js";
import { displayId, headSha, jsonValue, metadataLine, normalizeHandle, noteMetadata, reviewerId, userName } from "./gitlab_review_metadata.js";
import type {
  GitLabCiDiagnostic,
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabMetadata,
  GitLabNote,
  GitLabReviewProviderOptions,
  GitLabReviewPullRequest,
  GitLabReviewRestClient,
  GitLabReviewSnapshot,
} from "./gitlab_review_types.js";

function mapMergeState(mr: GitLabMergeRequest): ReviewItem["state"] {
  if (mr.draft || mr.work_in_progress) return "draft";
  if (mr.state === "merged") return "merged";
  if (mr.state === "closed") return "closed";
  if (mr.state === "opened") return "open";
  return "unknown";
}

function mapMergeability(mr: GitLabMergeRequest): ReviewItem["mergeability"] {
  const status = (mr.detailed_merge_status ?? mr.merge_status ?? "").toLowerCase();
  if (status === "mergeable" || status === "can_be_merged") return "mergeable";
  if (status === "conflict" || status.includes("conflict") || status === "cannot_be_merged") return "conflicting";
  if (gitLabMergeStatusBlocker(status) !== null || status.includes("blocked") || status.includes("checking") || status.includes("approval") || status.includes("pipeline")) return "blocked";
  return "unknown";
}

function gitLabMergeStatusBlocker(status: string): Omit<ReviewMergeBlock, "url"> | null {
  switch (status) {
    case "approvals_syncing":
      return { reason: "merge-state-blocked", summary: "GitLab merge approvals are still syncing." };
    case "checking":
    case "unchecked":
    case "preparing":
      return { reason: "merge-state-blocked", summary: `GitLab merge status is ${status}; mergeability is still being calculated.` };
    case "ci_must_pass":
    case "ci_still_running":
    case "commits_status":
    case "security_policy_pipeline_check":
    case "status_checks_must_pass":
      return { reason: "checks-pending", summary: `GitLab merge status is ${status}; required pipeline or status checks must pass before merge.` };
    case "conflict":
    case "cannot_be_merged":
    case "cannot_be_merged_recheck":
      return { reason: "conflict", summary: "GitLab reports this merge request cannot merge cleanly." };
    case "discussions_not_resolved":
      return { reason: "unresolved-review-thread", summary: "GitLab reports unresolved discussions that must be resolved before merge." };
    case "draft_status":
      return { reason: "draft", summary: "GitLab reports this merge request is a draft." };
    case "jira_association_missing":
      return { reason: "merge-state-blocked", summary: "GitLab reports a required Jira association is missing." };
    case "merge_request_blocked":
      return { reason: "merge-state-blocked", summary: "GitLab reports this merge request is blocked by another merge request." };
    case "merge_time":
      return { reason: "merge-state-blocked", summary: "GitLab reports this merge request cannot be merged until the configured merge time." };
    case "need_rebase":
      return { reason: "merge-state-blocked", summary: "GitLab reports this merge request must be rebased before merge." };
    case "not_approved":
      return { reason: "review-required", summary: "GitLab reports approval is required before merge." };
    case "not_open":
      return { reason: "merge-state-blocked", summary: "GitLab reports this merge request must be open before merge." };
    case "requested_changes":
      return { reason: "changes-requested", summary: "GitLab reports requested changes on the merge request." };
    case "security_policy_violations":
      return { reason: "merge-state-blocked", summary: "GitLab reports security policy violations that must be resolved before merge." };
    case "locked_paths":
      return { reason: "merge-state-blocked", summary: "GitLab reports locked paths that must be unlocked before merge." };
    case "locked_lfs_files":
      return { reason: "merge-state-blocked", summary: "GitLab reports locked LFS files that must be unlocked before merge." };
    case "title_regex":
      return { reason: "merge-state-blocked", summary: "GitLab reports the merge request title does not satisfy the configured pattern." };
    default:
      return null;
  }
}

function normalizePr(mr: GitLabMergeRequest): GitLabReviewPullRequest {
  const mergeStatus = (mr.detailed_merge_status ?? mr.merge_status ?? "").toLowerCase();
  return {
    number: mr.iid,
    title: mr.title,
    state: mr.state.toUpperCase(),
    url: mr.web_url,
    headRefOid: headSha(mr),
    reviewDecision: mergeStatus === "not_approved" ? "REVIEW_REQUIRED" : mergeStatus === "requested_changes" ? "CHANGES_REQUESTED" : "UNKNOWN",
    mergeStateStatus: (mr.detailed_merge_status ?? mr.merge_status ?? "UNKNOWN").toUpperCase(),
    mergeable: mapMergeability(mr) === "mergeable" ? "MERGEABLE" : mapMergeability(mr) === "conflicting" ? "CONFLICTING" : "UNKNOWN",
    isDraft: mr.draft === true || mr.work_in_progress === true,
  };
}

function mapReviewDecision(reviewDecision: GitLabReviewPullRequest["reviewDecision"]): ReviewItem["reviewDecision"] {
  if (reviewDecision === "REVIEW_REQUIRED") return "review-required";
  if (reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  return "none";
}

function pipelineDiagnostic(mr: GitLabMergeRequest): GitLabCiDiagnostic[] {
  const pipeline = mr.head_pipeline;
  const sha = headSha(mr);
  if (!pipeline) {
    return [{
      checkName: "gitlab-pipeline",
      status: "unknown",
      reasonCode: "ci-mapping-unknown",
      currentHeadSha: sha,
      mappedToCurrentHeadCheckRun: false,
      mappedToCurrentHeadWorkflowRun: false,
      currentHeadSuiteIds: [],
      currentHeadRunIds: [],
      staleRunIds: [],
      workflowDispatchSupported: null,
      summary: "GitLab merge request has no head pipeline state.",
      nextAction: "Inspect the GitLab merge request pipeline configuration, then rerun `aie pr view <mr> --json`.",
    }];
  }
  const status = pipeline.status.toLowerCase();
  const matchesHead = pipeline.sha === sha;
  const passed = status === "success" && matchesHead;
  const failed = matchesHead && ["failed", "canceled", "manual"].includes(status);
  const pending = matchesHead && ["created", "waiting_for_resource", "preparing", "pending", "running"].includes(status);
  return [{
    checkName: "gitlab-pipeline",
    status: passed ? "mapped" : failed ? "failed-current-head-run" : pending ? "pending-current-head-run" : "unknown",
    reasonCode: passed ? "current-head-workflow-run-found" : failed ? "current-head-check-run-failed" : pending ? "current-head-check-run-pending" : "ci-mapping-unknown",
    currentHeadSha: sha,
    mappedToCurrentHeadCheckRun: false,
    mappedToCurrentHeadWorkflowRun: matchesHead,
    currentHeadSuiteIds: [],
    currentHeadRunIds: matchesHead ? [String(pipeline.id)] : [],
    staleRunIds: matchesHead ? [] : [String(pipeline.id)],
    workflowDispatchSupported: null,
    summary: matchesHead ? `GitLab pipeline status=${pipeline.status}.` : `GitLab pipeline status=${pipeline.status}, but pipeline sha ${pipeline.sha} does not match merge request head ${sha}.`,
    nextAction: passed ? "No CI retrigger needed for this pipeline." : "Inspect the GitLab merge request pipeline, then rerun `aie pr view <mr> --json`.",
  }];
}

function checks(mr: GitLabMergeRequest, diagnostics: GitLabCiDiagnostic[]): GateEvidence[] {
  return diagnostics.map(diagnostic => normalizeGateEvidence({
    key: `gitlab-pipeline:${diagnostic.currentHeadRunIds[0] ?? "unknown"}`,
    name: "GitLab pipeline",
    stage: "pre-merge",
    result: diagnostic.status === "mapped" ? "passed" : diagnostic.status === "failed-current-head-run" ? "failed" : diagnostic.status === "skipped-current-head-run" ? "skipped" : diagnostic.status === "pending-current-head-run" ? "unknown" : "unknown",
    source: "provider-check",
    trust: "trusted-provider",
    command: null,
    providerRunId: diagnostic.currentHeadRunIds[0] ?? null,
    path: mr.head_pipeline?.web_url ?? null,
    summary: diagnostic.summary,
    recordedAt: null,
    reasonCode: diagnostic.status === "mapped" || diagnostic.status === "failed-current-head-run" ? "trusted-provider-result" : diagnostic.status === "skipped-current-head-run" ? "provider-check-skipped" : "provider-check-pending",
    metadata: { ciDiagnostic: jsonValue(diagnostic) as JsonObject },
  }));
}

function mergeBlockers(mr: GitLabMergeRequest, checkEvidence: readonly GateEvidence[], conversations: readonly { resolved: boolean }[]): ReviewMergeBlock[] {
  const blockers: ReviewMergeBlock[] = [];
  const status = (mr.detailed_merge_status ?? mr.merge_status ?? "").toLowerCase();
  const statusBlocker = gitLabMergeStatusBlocker(status);
  if (mr.draft || mr.work_in_progress) blockers.push({ reason: "draft", summary: "GitLab merge request is a draft.", url: mr.web_url });
  if (mapMergeability(mr) === "conflicting") blockers.push({ reason: "conflict", summary: "GitLab reports merge conflicts for this merge request.", url: mr.web_url });
  if (statusBlocker) blockers.push({ ...statusBlocker, summary: `${statusBlocker.summary} (status=${status})`, url: mr.web_url });
  else if (mapMergeability(mr) === "blocked") blockers.push({ reason: "merge-state-blocked", summary: `GitLab merge status is ${mr.detailed_merge_status ?? mr.merge_status ?? "unknown"}.`, url: mr.web_url });
  if (checkEvidence.some(check => check.result === "failed")) blockers.push({ reason: "checks-failed", summary: "One or more GitLab pipelines failed.", url: mr.head_pipeline?.web_url ?? mr.web_url });
  if (checkEvidence.some(check => check.result === "unknown")) blockers.push({ reason: "checks-pending", summary: "One or more GitLab pipelines are pending or unknown.", url: mr.head_pipeline?.web_url ?? mr.web_url });
  if (conversations.some(conversation => !conversation.resolved)) blockers.push({ reason: "unresolved-review-thread", summary: "One or more GitLab merge request discussions are unresolved.", url: mr.web_url });
  return blockers;
}

function reviewRequestBody(handle: string, head: string, requestText: string): string {
  const id = reviewerId(handle);
  return [
    metadataLine({ version: 1, kind: "review-request", head, reviewerId: id }),
    `${normalizeHandle(handle)} review`,
    requestText.trim() || "Review this merge request as a production-focused reviewer.",
  ].join("\n");
}

function laneRunId(input: ReviewLaneReviewPublishInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ head: input.headSha, lane: input.lane, issueNumber: input.issueNumber, prNumber: input.prNumber }))
    .digest("hex")
    .slice(0, 16);
}

const TOKEN_PATTERNS: RegExp[] = [
  /\b(ghp_[A-Za-z0-9_]{10,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghs_[A-Za-z0-9_]{10,})\b/g,
  /\b(gho_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghu_[A-Za-z0-9_]{10,})\b/g,
  /\b(glpat-[A-Za-z0-9_-]{10,})\b/g,
];

function redact(value: string): string {
  let redacted = value;
  for (const pattern of TOKEN_PATTERNS) redacted = redacted.replace(pattern, "[REDACTED]");
  return redacted
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, match => /[A-Z]/.test(match) && /[a-z]/.test(match) && /[0-9]/.test(match) ? "[REDACTED]" : match)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s'"`]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|pwd|client[_-]?secret|access[_-]?token)[A-Za-z0-9_.-]*)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;&)]+)/gi, "$1$2[REDACTED]")
    .replace(/\\\\[A-Za-z0-9._$-]+\\[^\r\n)<>]+/g, "[local-path]")
    .replace(/\b[A-Za-z]:[\\/][^\r\n)<>]+/g, "[local-path]")
    .replace(/(^|[\s(:`"'])\/(?:Users|home|tmp|var|private|mnt|Volumes|workspace|workspaces|code)\/[^\r\n)<>]+/g, "$1[local-path]");
}

function sanitizeFeedbackText(value: string | undefined): string {
  return redact(value ?? "")
    .replace(/<!--\s*internal state start\s*-->[\s\S]*?<!--\s*internal state end\s*-->/gi, "")
    .replace(/<details>\s*<summary>\s*Prompt for AI Agents[\s\S]*?<\/details>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/Prompt for AI Agents[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function feedbackSummary(value: string | undefined, fallback: string): string {
  const sanitized = sanitizeFeedbackText(value);
  const summary = sanitized === "" ? fallback : sanitized;
  return summary.length > 500 ? summary.slice(0, 500) : summary;
}

const MAX_PUBLISHED_COMPLETENESS_LENGTH = 12000;

function truncatePublishedCompleteness(value: string): string {
  const text = redact(value);
  if (text.length <= MAX_PUBLISHED_COMPLETENESS_LENGTH) return text;
  const suffix = " [truncated; full self-check retained in local evidence JSON]";
  return `${text.slice(0, MAX_PUBLISHED_COMPLETENESS_LENGTH - suffix.length).trimEnd()}${suffix}`;
}

function laneBody(input: ReviewLaneReviewPublishInput): { body: string; marker: string; runId: string; bodyFindingCount: number } {
  const findings = input.findings.map(finding => {
    if (typeof finding === "string") return redact(finding);
    const normalized = normalizeReviewFinding(finding);
    const confidence = typeof normalized.confidence === "number" ? ` (confidence ${normalized.confidence.toFixed(2)})` : "";
    return `${redact(normalized.message)}${confidence}`;
  });
  const runId = laneRunId(input);
  const summary = redact(input.summary);
  // The digest covers the rendered finding text (including confidence) and
  // the withheld counts, so a rescore or synthesis-accounting change
  // republishes instead of skip-matching on stale note content.
  const findingDigest = createHash("sha256")
    .update(JSON.stringify({ summary, findings, completeness: input.completeness && input.completeness.trim() !== "" ? redact(input.completeness) : null, withheld: input.withheld ?? null }))
    .digest("hex")
    .slice(0, 16);
  const metadata: GitLabMetadata = {
    version: 1,
    kind: "lane-review",
    head: input.headSha,
    lane: input.lane,
    expectedLanes: [...new Set(input.expectedLanes)].sort(),
    round: input.round,
    profile: input.profile,
    runId,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    host: input.host,
    recommendation: input.recommendation,
    status: input.status,
    summary,
    inline: "gitlab-note",
    bodyFindingCount: findings.length,
    inlineCommentCount: 0,
    findingDigest,
  };
  const withheld = input.withheld;
  const withheldTotal = withheld ? withheld.duplicates + withheld.offDiff + withheld.byCap : 0;
  const body = [
    metadataLine(metadata),
    `QUBE ${redact(input.lane)} review: ${input.recommendation}`,
    summary,
    ...findings.map(finding => `- ${finding}`),
    withheldTotal > 0
      ? `Synthesis withheld ${withheldTotal} finding(s): ${withheld!.duplicates} cross-lane duplicate(s), ${withheld!.offDiff} outside the current diff, ${withheld!.byCap} beyond the advisory cap; see local evidence.`
      : "",
    input.completeness && input.completeness.trim() !== "" ? `Completeness self-check: ${truncatePublishedCompleteness(input.completeness)}` : "",
    input.evidencePath ? `Evidence: ${redact(input.evidencePath)}` : "",
  ].filter(line => line !== "").join("\n");
  return { body, marker: JSON.stringify(metadata), runId, bodyFindingCount: findings.length };
}

function actionResult(action: Action, status: "completed" | "failed", failure: ActionResult["failure"] = null): ActionResult {
  return { actionId: action.id, status, failure, details: action.details };
}

export class GitLabReviewForgeProvider implements ReviewForgeProvider {
  readonly id = "gitlab" as const;
  private readonly client: GitLabReviewRestClient;
  private readonly projectId: string;

  constructor(private readonly options: GitLabReviewProviderOptions = {}) {
    this.client = options.client ?? new FetchGitLabReviewRestClient(options);
    this.projectId = required(options.projectId ?? process.env.GITLAB_PROJECT_ID, "GITLAB_PROJECT_ID");
  }

  capabilities(): ReviewForgeCapabilities {
    return { loadReview: true, loadReviewSnapshot: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true, publishLaneReview: true, publishLaneReviewInline: false, resolveReviewThreads: true };
  }

  async getReviewItem(key: ReviewItemKey): Promise<ReviewItem> {
    if (key.providerId !== this.id) throw new Error(`load GitLab review item failed: providerId ${key.providerId} is unsupported. Use a gitlab review item key.`);
    return (await this.loadPullRequestReview(Number(normalizeMergeRequestIid(key.id)))).item;
  }

  async loadReviewSnapshot(key: ReviewItemKey): Promise<GitLabReviewSnapshot> {
    if (key.providerId !== this.id) throw new Error(`load GitLab review snapshot failed: providerId ${key.providerId} is unsupported.`);
    return this.loadPullRequestReview(Number(normalizeMergeRequestIid(key.id)));
  }

  async findReviewForCurrentBranch(): Promise<ReviewItem | null> {
    return (await this.findCurrentReview()).item;
  }

  async findCurrentReview(): Promise<{ item: ReviewItem | null; pr: GitLabReviewPullRequest | null; warning: string | null }> {
    const branch = this.options.currentBranch;
    if (!branch || !this.client.findMergeRequestForBranch) return { item: null, pr: null, warning: "Current-branch GitLab merge request lookup requires currentBranch and adapter branch lookup support." };
    const mr = await this.client.findMergeRequestForBranch({ projectId: this.projectId, sourceBranch: branch });
    if (!mr) return { item: null, pr: null, warning: `No open GitLab merge request found for branch ${branch}.` };
    const snapshot = await this.loadPullRequestReview(mr.iid);
    return { item: snapshot.item, pr: snapshot.pr, warning: null };
  }

  async loadPullRequestReviewTarget(prNumber: number): Promise<{ pr: GitLabReviewPullRequest; closingIssueNumbers: number[] }> {
    const mr = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(prNumber) });
    return { pr: normalizePr(mr), closingIssueNumbers: closingIssueNumbers(mr) };
  }

  async loadPullRequestReview(prNumber: number): Promise<GitLabReviewSnapshot> {
    const mr = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(prNumber) });
    const unavailable: string[] = [];
    let notes: GitLabNote[] = [];
    let discussions: GitLabDiscussion[] = [];
    try { notes = await this.client.listMergeRequestNotes({ projectId: this.projectId, iid: String(prNumber) }); } catch (error) { unavailable.push(`GitLab MR notes unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    try { discussions = await this.client.listMergeRequestDiscussions({ projectId: this.projectId, iid: String(prNumber) }); } catch (error) { unavailable.push(`GitLab MR discussions unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    const trustedMarkerAuthor = await this.trustedMarkerAuthor();
    const ciDiagnostics = pipelineDiagnostic(mr);
    const pr = normalizePr(mr);
    return {
      item: this.reviewItem(mr, notes, discussions, unavailable, trustedMarkerAuthor, ciDiagnostics),
      pr,
      ciDiagnostics,
      closingIssueNumbers: closingIssueNumbers(mr),
      reviewRequests: [],
      commentsCount: notes.length,
      reviewsCount: 0,
      reviewCommentsCount: discussions.flatMap(discussion => discussion.notes ?? []).length,
      unresolvedThreadsCount: discussions.filter(discussion => discussion.notes?.some(note => note.resolvable && !note.resolved)).length,
      conversationsCount: discussions.length,
      unavailable,
    };
  }

  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options: ReviewForgePlanOptions = {}): ActionPlan {
    const head = typeof item.trustedMetadata.headRefOid === "string" ? item.trustedMetadata.headRefOid : "UNKNOWN";
    const reviewRequests = new Set((Array.isArray(item.trustedMetadata.reviewRequests) ? item.trustedMetadata.reviewRequests : []).filter((value): value is string => typeof value === "string").map(value => value.toLowerCase().replace(/^@/, "")));
    const markers = new Set((Array.isArray(item.trustedMetadata.reviewRequestMarkers) ? item.trustedMetadata.reviewRequestMarkers : []).filter((value): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value)).map(value => `${value.reviewerId}:${value.head}`));
    const names = [...new Set([...policy.reviewers, ...(options.activeLanes && options.activeLanes.length > 0 ? ["QUBEReview"] : [])].map(name => name.trim()).filter(name => name !== ""))];
    const actions = names.map(name => {
      const id = reviewerId(name);
      const requestedForHead = markers.has(`${id}:${head}`);
      const pending = reviewRequests.has(id);
      const body = reviewRequestBody(name, head, policy.requestText);
      return createAction({
        id: `gitlab:review-request:${item.key.id}:${id}:${head}`,
        kind: "request-review",
        target: { kind: "review-item", id: item.key.id },
        mutation: "review-provider",
        description: requestedForHead ? `GitLab review request for ${normalizeHandle(name)} is already recorded for ${displayId(item.key.id)}.` : `Post GitLab review request note for ${normalizeHandle(name)} on ${displayId(item.key.id)}.`,
        expectedResult: "GitLab merge request contains a provider-visible review request note with stable QUBE metadata.",
        status: requestedForHead || pending ? "skipped" : "planned",
        details: { providerId: "gitlab", requestKind: "comment", handle: normalizeHandle(name), body, requestedForHead, pending },
      });
    });
    return createActionPlan({ id: `gitlab:review-request:${item.key.id}`, purpose: `Request configured GitLab merge request reviewers for ${displayId(item.key.id)}.`, dryRun: true, actions });
  }

  async apply(plan: ActionPlan): Promise<readonly ActionResult[]> {
    const results: ActionResult[] = [];
    for (const action of plan.actions) {
      if (action.status === "skipped") {
        results.push(actionResult(action, "completed"));
        continue;
      }
      const body = typeof action.details.body === "string" ? action.details.body : "";
      try {
        await this.client.createMergeRequestNote({ projectId: this.projectId, iid: action.target.id, body });
        results.push(actionResult(action, "completed"));
      } catch (error) {
        results.push(actionResult(action, "failed", {
          operation: action.description,
          cause: error instanceof Error ? error.message : String(error),
          nextAction: "Verify GitLab token permissions, project id, merge request iid, and note permissions, then rerun `aie pr gate <mr> --dry-run` before retrying.",
        }));
      }
    }
    return results;
  }

  async publishLaneReviewFeedback(item: ReviewItem, input: ReviewLaneReviewPublishInput): Promise<ReviewLaneReviewPublishResult> {
    const planned = laneBody(input);
    if (this.hasMatchingLaneReview(item, input, planned.runId)) {
      return { status: "skipped", runId: planned.runId, marker: planned.marker, body: null, url: null, failure: null, nextAction: `Provider-visible GitLab lane review for ${input.lane} is already published for this MR head and run id.` };
    }
    if (input.dryRun) {
      return { status: "planned", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: null, nextAction: `Rerun \`aie pr review publish <mr> --lane ${input.lane}\` without --dry-run to publish provider-visible GitLab note feedback.` };
    }
    try {
      // Same head-freshness contract as the ForPullRequest path: an
      // unobservable or advanced head must fail instead of publishing lane
      // feedback against an obsolete commit.
      const mergeRequest = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(input.prNumber) });
      const currentHead = typeof (mergeRequest as { sha?: unknown }).sha === "string" ? String((mergeRequest as { sha?: unknown }).sha) : "";
      if (currentHead === "") {
        throw new Error(`merge request !${input.prNumber} did not report a head SHA, so the publish head cannot be verified; fail closed and retry once GitLab reports the current head.`);
      }
      if (currentHead !== input.headSha) {
        throw new Error(`merge request !${input.prNumber} head changed from ${input.headSha} to ${currentHead}; rerun pr gate for the current head.`);
      }
      // Revalidate the head immediately before the note create: work since
      // the initial head check (note listing, metadata) is asynchronous, so a
      // merge request that advanced meanwhile must not receive stale feedback.
      const headCheck = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(input.prNumber) });
      const latestHead = typeof (headCheck as { sha?: unknown }).sha === "string" ? String((headCheck as { sha?: unknown }).sha) : "";
      if (latestHead === "" || latestHead !== input.headSha) {
        throw new Error(latestHead === ""
          ? `merge request !${input.prNumber} stopped reporting a head SHA before publication; fail closed and rerun pr gate.`
          : `merge request !${input.prNumber} head changed from ${input.headSha} to ${latestHead} before publication; rerun pr gate for the current head.`);
      }
      const note = await this.client.createMergeRequestNote({ projectId: this.projectId, iid: String(input.prNumber), body: planned.body });
      return { status: "published", runId: planned.runId, marker: planned.marker, body: planned.body, url: note.web_url ?? null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: null, nextAction: `Provider-visible GitLab note feedback for ${input.lane} was published; rerun MR view/gate to inspect provider state.` };
    } catch (error) {
      return { status: "failed", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: error instanceof Error ? error.message : String(error), nextAction: `Fix GitLab note permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.` };
    }
  }

  async publishLaneReviewFeedbackForPullRequest(input: ReviewLaneReviewPublishInput): Promise<ReviewLaneReviewPublishResult> {
    const planned = laneBody(input);
    let notes: GitLabNote[];
    try {
      // Lane feedback must bind to the merge request's current head; a
      // caller-supplied head the MR has advanced past must fail instead of
      // publishing review state against an obsolete commit.
      const mergeRequest = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(input.prNumber) });
      const currentHead = typeof (mergeRequest as { sha?: unknown }).sha === "string" ? String((mergeRequest as { sha?: unknown }).sha) : "";
      if (currentHead === "") {
        throw new Error(`merge request !${input.prNumber} did not report a head SHA, so the publish head cannot be verified; fail closed and retry once GitLab reports the current head.`);
      }
      if (currentHead !== input.headSha) {
        throw new Error(`merge request !${input.prNumber} head changed from ${input.headSha} to ${currentHead}; rerun pr gate for the current head.`);
      }
      notes = await this.client.listMergeRequestNotes({ projectId: this.projectId, iid: String(input.prNumber) });
    } catch (error) {
      return { status: "failed", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: error instanceof Error ? error.message : String(error), nextAction: `Fix GitLab note visibility or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.` };
    }
    const trustedMetadata = trustedLaneReviewMetadata({
      notes,
      trustedMarkerAuthor: await this.trustedMarkerAuthor(),
      head: input.headSha,
      prNumber: input.prNumber,
    });
    if (this.hasMatchingLaneReviewMetadata(trustedMetadata, input, planned.runId)) {
      return { status: "skipped", runId: planned.runId, marker: planned.marker, body: null, url: null, failure: null, nextAction: `Provider-visible GitLab lane review for ${input.lane} is already published for this MR head and run id.` };
    }
    if (input.dryRun) {
      return { status: "planned", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: null, nextAction: `Rerun \`aie pr review publish <mr> --lane ${input.lane}\` without --dry-run to publish provider-visible GitLab note feedback.` };
    }
    try {
      // Revalidate the head immediately before the note create: work since
      // the initial head check (note listing, metadata) is asynchronous, so a
      // merge request that advanced meanwhile must not receive stale feedback.
      const headCheck = await this.client.getMergeRequest({ projectId: this.projectId, iid: String(input.prNumber) });
      const latestHead = typeof (headCheck as { sha?: unknown }).sha === "string" ? String((headCheck as { sha?: unknown }).sha) : "";
      if (latestHead === "" || latestHead !== input.headSha) {
        throw new Error(latestHead === ""
          ? `merge request !${input.prNumber} stopped reporting a head SHA before publication; fail closed and rerun pr gate.`
          : `merge request !${input.prNumber} head changed from ${input.headSha} to ${latestHead} before publication; rerun pr gate for the current head.`);
      }
      const note = await this.client.createMergeRequestNote({ projectId: this.projectId, iid: String(input.prNumber), body: planned.body });
      return { status: "published", runId: planned.runId, marker: planned.marker, body: planned.body, url: note.web_url ?? null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: null, nextAction: `Provider-visible GitLab note feedback for ${input.lane} was published; rerun MR view/gate to inspect provider state.` };
    } catch (error) {
      return { status: "failed", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: error instanceof Error ? error.message : String(error), nextAction: `Fix GitLab note permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.` };
    }
  }

  async resolveReviewThreads(input: ResolveReviewThreadInput): Promise<ResolveReviewThreadResult> {
    const threadIds = [...new Set(input.threadIds.map(id => id.trim()).filter(id => id !== ""))];
    if (threadIds.length === 0) {
      return {
        status: "skipped",
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: [],
        failedThreadIds: [],
        nextAction: "No GitLab discussion ids were selected; rerun `aie pr view <mr> --json` to inspect unresolved reviewThreads.",
      };
    }
    if (input.dryRun) {
      return {
        status: "planned",
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: threadIds,
        failedThreadIds: [],
        nextAction: `Rerun without --dry-run to resolve ${threadIds.length} GitLab discussion${threadIds.length === 1 ? "" : "s"}.`,
      };
    }
    if (!this.client.resolveMergeRequestDiscussion) {
      return {
        status: "failed",
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: [],
        failedThreadIds: threadIds,
        nextAction: "GitLab discussion resolution requires a review client with resolveMergeRequestDiscussion support.",
      };
    }
    let discussions: GitLabDiscussion[];
    try {
      discussions = await this.client.listMergeRequestDiscussions({ projectId: this.projectId, iid: String(input.prNumber) });
    } catch {
      return {
        status: "failed",
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds: [],
        failedThreadIds: threadIds,
        nextAction: `Could not verify GitLab discussion ids against MR !${input.prNumber}. Rerun \`aie pr view ${input.prNumber} --json\` to inspect unresolved reviewThreads, then retry.`,
      };
    }
    const unresolvedDiscussionIds = new Set(discussions
      .filter(discussion => discussion.notes?.some(note => note.resolvable) && !discussion.notes.every(note => !note.resolvable || note.resolved === true))
      .map(discussion => discussion.id));
    const skippedThreadIds = threadIds.filter(threadId => !unresolvedDiscussionIds.has(threadId));
    const selectedThreadIds = threadIds.filter(threadId => unresolvedDiscussionIds.has(threadId));
    if (selectedThreadIds.length === 0) {
      return {
        status: "skipped",
        prNumber: input.prNumber,
        resolvedThreadIds: [],
        skippedThreadIds,
        failedThreadIds: [],
        nextAction: `No selected GitLab discussion ids belong to unresolved discussions on MR !${input.prNumber}; rerun \`aie pr view ${input.prNumber} --json\` to inspect current reviewThreads.`,
      };
    }
    const resolvedThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    for (const threadId of selectedThreadIds) {
      try {
        await this.client.resolveMergeRequestDiscussion({ projectId: this.projectId, iid: String(input.prNumber), discussionId: threadId });
        resolvedThreadIds.push(threadId);
      } catch {
        failedThreadIds.push(threadId);
      }
    }
    return {
      status: failedThreadIds.length > 0 ? "failed" : "resolved",
      prNumber: input.prNumber,
      resolvedThreadIds,
      skippedThreadIds,
      failedThreadIds,
      nextAction: failedThreadIds.length > 0
        ? `Some GitLab discussions could not be resolved. Verify token permissions and rerun \`aie pr thread resolve ${input.prNumber} --thread <id>\` for the failed ids.`
        : `Resolved ${resolvedThreadIds.length} GitLab discussion${resolvedThreadIds.length === 1 ? "" : "s"}${skippedThreadIds.length > 0 ? ` and skipped ${skippedThreadIds.length} id${skippedThreadIds.length === 1 ? "" : "s"} not unresolved on MR !${input.prNumber}` : ""}; rerun \`aie pr view ${input.prNumber} --json\` or \`aie pr gate ${input.prNumber}\` to confirm merge blockers cleared.`,
    };
  }

  private reviewItem(mr: GitLabMergeRequest, notes: GitLabNote[], discussions: GitLabDiscussion[], unavailable: string[], trustedMarkerAuthor: string | null, ciDiagnostics: GitLabCiDiagnostic[]): ReviewItem {
    const pr = normalizePr(mr);
    const checkEvidence = checks(mr, ciDiagnostics);
    const conversations = reviewConversations(discussions);
    return normalizeReviewItem({
      key: { providerId: this.id, id: String(mr.iid) },
      displayId: displayId(mr.iid),
      title: mr.title,
      url: mr.web_url,
      sourceRef: pr.headRefOid,
      targetRef: mr.target_branch ?? "base",
      state: mapMergeState(mr),
      reviewDecision: mapReviewDecision(pr.reviewDecision),
      mergeability: mapMergeability(mr),
      linkedWorkItems: closingIssueNumbers(mr).map(number => ({ providerId: "gitlab", id: String(number) })),
      feedback: feedback(notes, discussions, trustedMarkerAuthor),
      mergeBlockers: mergeBlockers(mr, checkEvidence, conversations),
      conversations,
      checks: checkEvidence,
      trustedMetadata: metadata({ mr, notes, trustedMarkerAuthor, unavailable, ciDiagnostics }),
      source: normalizeProviderSource({ providerId: this.id, resourceKind: "review-item", resourceId: String(mr.iid), url: mr.web_url }),
    });
  }

  private async trustedMarkerAuthor(): Promise<string | null> {
    if (!this.client.getCurrentUser) return null;
    try {
      return userName(await this.client.getCurrentUser());
    } catch {
      return null;
    }
  }

  private hasMatchingLaneReview(item: ReviewItem, input: ReviewLaneReviewPublishInput, runId: string): boolean {
    return this.hasMatchingLaneReviewMetadata(item.trustedMetadata, input, runId);
  }

  private hasMatchingLaneReviewMetadata(trustedMetadata: JsonObject, input: ReviewLaneReviewPublishInput, runId: string): boolean {
    const planned = laneBody(input);
    const plannedMetadata = JSON.parse(planned.marker) as GitLabMetadata;
    const records = Array.isArray(trustedMetadata.trustedLaneReviews) ? trustedMetadata.trustedLaneReviews : [];
    return records.some(record => record !== null && typeof record === "object" && !Array.isArray(record)
      && record.head === input.headSha
      && record.lane === input.lane
      && record.round === input.round
      && record.runId === runId
      && record.recommendation === input.recommendation
      && record.status === input.status
      && record.summary === redact(input.summary)
      && record.findingDigest === plannedMetadata.findingDigest
      && record.stale !== true);
  }
}

function feedback(notes: readonly GitLabNote[], discussions: readonly GitLabDiscussion[], trustedMarkerAuthor: string | null): ReviewFeedback[] {
  const noteFeedback = notes
    .filter(note => !note.system && trustedMetadataNote(note, trustedMarkerAuthor) === null)
    .map(note => ({ source: "comment" as const, author: userName(note.author), summary: feedbackSummary(note.body, "GitLab merge request note"), url: note.web_url ?? null, state: null, trust: "untrusted" as const }));
  const discussionFeedback = discussions
    .filter(discussion => discussion.notes?.some(note => note.resolvable && !note.resolved))
    .flatMap(discussion => {
      const latest = discussion.notes?.at(-1);
      return latest ? [{ source: "thread" as const, author: userName(latest.author), summary: feedbackSummary(latest.body, "GitLab discussion comment"), url: latest.web_url ?? null, state: "unresolved", trust: "untrusted" as const }] : [];
    });
  return [...noteFeedback, ...discussionFeedback].filter(item => item.summary !== "");
}

function trustedMetadataNote(note: GitLabNote, trustedMarkerAuthor: string | null): GitLabMetadata | null {
  if (trustedMarkerAuthor === null || userName(note.author) !== trustedMarkerAuthor) return null;
  return noteMetadata(note);
}

function reviewConversations(discussions: readonly GitLabDiscussion[]) {
  return discussions.flatMap(discussion => {
    const latest = discussion.notes?.at(-1);
    const anchor = discussion.notes ? [...discussion.notes].reverse().find(note => note.position?.new_path || note.position?.old_path || note.position?.new_line || note.position?.old_line) : undefined;
    if (!latest || !discussion.notes?.some(note => note.resolvable)) return [];
    return [{
      providerId: "gitlab",
      id: discussion.id,
      resolved: discussion.notes.every(note => !note.resolvable || note.resolved === true),
      outdated: isOutdatedDiscussion(discussion),
      viewerCanResolve: true,
      path: anchor?.position?.new_path ?? anchor?.position?.old_path ?? null,
      line: anchor?.position?.new_line ?? null,
      originalLine: anchor?.position?.old_line ?? null,
      author: userName(latest.author),
      summary: feedbackSummary(latest.body, "GitLab discussion comment"),
      url: latest.web_url ?? null,
    }];
  });
}

function isOutdatedDiscussion(discussion: GitLabDiscussion): boolean {
  return discussion.notes?.some(note => note.position?.outdated === true
    || note.position?.line_range?.start?.outdated === true
    || note.position?.line_range?.end?.outdated === true) ?? false;
}

function metadata(input: { mr: GitLabMergeRequest; notes: GitLabNote[]; trustedMarkerAuthor: string | null; unavailable: string[]; ciDiagnostics: GitLabCiDiagnostic[] }): JsonObject {
  const head = headSha(input.mr);
  const laneReviews = trustedLaneReviews({
    notes: input.notes,
    trustedMarkerAuthor: input.trustedMarkerAuthor,
    head,
    prNumber: input.mr.iid,
  });
  const requestMarkers = input.notes.flatMap(note => {
    const parsed = trustedMetadataNote(note, input.trustedMarkerAuthor);
    if (parsed?.kind !== "review-request" || !parsed.reviewerId) return [];
    return [{ reviewerId: parsed.reviewerId, head: parsed.head, author: userName(note.author), url: note.web_url ?? null }];
  });
  const syntheticComments = requestMarkers.map(marker => ({
    author: marker.author,
    body: `<!-- aie:pr-gate:${marker.reviewerId}:${marker.head} -->`,
    url: marker.url,
  }));
  return {
    provider: "gitlab",
    headRefOid: head,
    mergeStatus: input.mr.detailed_merge_status ?? input.mr.merge_status ?? null,
    reviewRequests: [],
    trustedMarkerAuthor: input.trustedMarkerAuthor,
    comments: syntheticComments,
    trustedLaneReviews: laneReviews,
    reviewRequestMarkers: requestMarkers,
    gitlabReviewers: (input.mr.reviewers ?? []).map(userName),
    unavailable: input.unavailable,
    ciDiagnostics: input.ciDiagnostics.map(diagnostic => jsonValue(diagnostic)),
  };
}

function trustedLaneReviewMetadata(input: { notes: GitLabNote[]; trustedMarkerAuthor: string | null; head: string; prNumber: number }): JsonObject {
  return {
    provider: "gitlab",
    headRefOid: input.head,
    trustedMarkerAuthor: input.trustedMarkerAuthor,
    trustedLaneReviews: trustedLaneReviews(input),
  };
}

function trustedLaneReviews(input: { notes: GitLabNote[]; trustedMarkerAuthor: string | null; head: string; prNumber: number }) {
  return input.notes.flatMap(note => {
    const parsed = trustedMetadataNote(note, input.trustedMarkerAuthor);
    if (parsed?.kind !== "lane-review" || !parsed.lane || !parsed.runId || !parsed.recommendation || !parsed.status || !parsed.summary) return [];
    return [{
      head: parsed.head,
      lane: parsed.lane,
      expectedLanes: Array.isArray(parsed.expectedLanes) && parsed.expectedLanes.every(lane => typeof lane === "string" && lane.trim() !== "") ? [...parsed.expectedLanes] : null,
      round: typeof parsed.round === "string" && parsed.round.trim() !== "" ? parsed.round : null,
      profile: parsed.profile ?? "",
      runId: parsed.runId,
      issueNumber: parsed.issueNumber ?? 0,
      prNumber: parsed.prNumber ?? input.prNumber,
      host: parsed.host ?? "",
      recommendation: parsed.recommendation,
      status: parsed.status,
      summary: parsed.summary,
      inline: "gitlab-note",
      inlineCommentCount: parsed.inlineCommentCount ?? 0,
      bodyFindingCount: parsed.bodyFindingCount ?? 0,
      findingDigest: parsed.findingDigest ?? null,
      url: note.web_url ?? null,
      author: userName(note.author),
      stale: parsed.head !== input.head,
    }];
  });
}

function closingIssueNumbers(mr: GitLabMergeRequest): number[] {
  const body = mr.description ?? "";
  const numbers = new Set<number>();
  for (const match of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].filter(number => Number.isSafeInteger(number) && number > 0);
}

export type GitLabReviewProvider = GitLabReviewForgeProvider;

export function createGitLabReviewForgeProvider(options: GitLabReviewProviderOptions = {}): GitLabReviewForgeProvider {
  return new GitLabReviewForgeProvider(options);
}

export function createGitLabReviewProvider(options: GitLabReviewProviderOptions = {}): GitLabReviewForgeProvider {
  return createGitLabReviewForgeProvider(options);
}
