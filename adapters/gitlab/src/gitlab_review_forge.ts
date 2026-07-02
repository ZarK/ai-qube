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
  type ReviewItem,
  type ReviewItemKey,
  type ReviewLaneReviewPublishInput,
  type ReviewLaneReviewPublishResult,
  type ReviewMergeBlock,
} from "@tjalve/qube-core";
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
  if (status.includes("conflict") || status === "cannot_be_merged") return "conflicting";
  if (status.includes("blocked") || status.includes("checking") || status.includes("approval") || status.includes("pipeline")) return "blocked";
  return "unknown";
}

function normalizePr(mr: GitLabMergeRequest): GitLabReviewPullRequest {
  return {
    number: mr.iid,
    title: mr.title,
    state: mr.state.toUpperCase(),
    url: mr.web_url,
    headRefOid: headSha(mr),
    reviewDecision: (mr.reviewers ?? []).length > 0 ? "REVIEW_REQUIRED" : "UNKNOWN",
    mergeStateStatus: (mr.detailed_merge_status ?? mr.merge_status ?? "UNKNOWN").toUpperCase(),
    mergeable: mapMergeability(mr) === "mergeable" ? "MERGEABLE" : mapMergeability(mr) === "conflicting" ? "CONFLICTING" : "UNKNOWN",
    isDraft: mr.draft === true || mr.work_in_progress === true,
  };
}

function pipelineDiagnostic(mr: GitLabMergeRequest): GitLabCiDiagnostic[] {
  const pipeline = mr.head_pipeline;
  const sha = headSha(mr);
  if (!pipeline) return [];
  const status = pipeline.status.toLowerCase();
  const passed = status === "success";
  const failed = ["failed", "canceled", "manual"].includes(status);
  const skipped = status === "skipped";
  const pending = ["created", "waiting_for_resource", "preparing", "pending", "running"].includes(status);
  return [{
    checkName: "gitlab-pipeline",
    status: passed ? "mapped" : failed ? "failed-current-head-run" : skipped ? "skipped-current-head-run" : pending ? "pending-current-head-run" : "unknown",
    reasonCode: passed ? "current-head-workflow-run-found" : failed ? "current-head-check-run-failed" : skipped ? "current-head-check-run-skipped" : pending ? "current-head-check-run-pending" : "ci-mapping-unknown",
    currentHeadSha: sha,
    mappedToCurrentHeadCheckRun: false,
    mappedToCurrentHeadWorkflowRun: pipeline.sha === undefined || pipeline.sha === sha,
    currentHeadSuiteIds: [],
    currentHeadRunIds: [String(pipeline.id)],
    staleRunIds: [],
    workflowDispatchSupported: null,
    summary: `GitLab pipeline status=${pipeline.status}.`,
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
  if (mr.draft || mr.work_in_progress) blockers.push({ reason: "draft", summary: "GitLab merge request is a draft.", url: mr.web_url });
  if (mapMergeability(mr) === "conflicting") blockers.push({ reason: "conflict", summary: "GitLab reports merge conflicts for this merge request.", url: mr.web_url });
  if (mapMergeability(mr) === "blocked") blockers.push({ reason: "merge-state-blocked", summary: `GitLab merge status is ${mr.detailed_merge_status ?? mr.merge_status ?? "unknown"}.`, url: mr.web_url });
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
  return ["gitlab", input.prNumber, input.headSha, input.lane, input.profile, input.host, input.issueNumber, input.recommendation, input.status].join(":");
}

const TOKEN_PATTERNS: RegExp[] = [
  /\b(ghp_[A-Za-z0-9_]{10,})\b/g,
  /\b(github_pat_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghs_[A-Za-z0-9_]{10,})\b/g,
  /\b(gho_[A-Za-z0-9_]{10,})\b/g,
  /\b(ghu_[A-Za-z0-9_]{10,})\b/g,
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

function laneBody(input: ReviewLaneReviewPublishInput): { body: string; marker: string; runId: string; bodyFindingCount: number } {
  const findings = input.findings.map(finding => redact(typeof finding === "string" ? finding : normalizeReviewFinding(finding).message));
  const runId = laneRunId(input);
  const summary = redact(input.summary);
  const metadata: GitLabMetadata = {
    version: 1,
    kind: "lane-review",
    head: input.headSha,
    lane: input.lane,
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
  };
  const body = [
    metadataLine(metadata),
    `QUBE ${redact(input.lane)} review: ${input.recommendation}`,
    summary,
    ...findings.map(finding => `- ${finding}`),
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
    return { loadReview: true, loadReviewSnapshot: true, findCurrentBranchReview: true, planReviewRequests: true, applyReviewRequests: true, publishLaneReview: true, publishLaneReviewInline: false, resolveReviewThreads: false };
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
      reviewRequests: (mr.reviewers ?? []).map(userName),
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
      const note = await this.client.createMergeRequestNote({ projectId: this.projectId, iid: String(input.prNumber), body: planned.body });
      return { status: "published", runId: planned.runId, marker: planned.marker, body: planned.body, url: note.web_url ?? null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: null, nextAction: `Provider-visible GitLab note feedback for ${input.lane} was published; rerun MR view/gate to inspect provider state.` };
    } catch (error) {
      return { status: "failed", runId: planned.runId, marker: planned.marker, body: planned.body, url: null, publishKind: "issue-comment", inlineCommentCount: 0, bodyFindingCount: planned.bodyFindingCount, failure: error instanceof Error ? error.message : String(error), nextAction: `Fix GitLab note permissions or connectivity, then rerun \`aie pr review publish ${input.prNumber} --lane ${input.lane}\`.` };
    }
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
      reviewDecision: pr.reviewDecision === "REVIEW_REQUIRED" ? "review-required" : "none",
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
    const records = Array.isArray(item.trustedMetadata.trustedLaneReviews) ? item.trustedMetadata.trustedLaneReviews : [];
    return records.some(record => record !== null && typeof record === "object" && !Array.isArray(record)
      && record.head === input.headSha && record.lane === input.lane && record.runId === runId && record.stale !== true);
  }
}

function feedback(notes: readonly GitLabNote[], discussions: readonly GitLabDiscussion[], trustedMarkerAuthor: string | null): ReviewFeedback[] {
  const noteFeedback = notes
    .filter(note => !note.system && trustedMetadataNote(note, trustedMarkerAuthor) === null)
    .map(note => ({ source: "comment" as const, author: userName(note.author), summary: note.body.trim().slice(0, 500), url: note.web_url ?? null, state: null, trust: "untrusted" as const }));
  const discussionFeedback = discussions
    .filter(discussion => discussion.notes?.some(note => note.resolvable && !note.resolved))
    .flatMap(discussion => {
      const latest = discussion.notes?.at(-1);
      return latest ? [{ source: "thread" as const, author: userName(latest.author), summary: latest.body.trim().slice(0, 500), url: latest.web_url ?? null, state: "unresolved", trust: "untrusted" as const }] : [];
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
    if (!latest || !discussion.notes?.some(note => note.resolvable)) return [];
    return [{
      providerId: "gitlab",
      id: discussion.id,
      resolved: discussion.notes.every(note => !note.resolvable || note.resolved === true),
      outdated: false,
      viewerCanResolve: false,
      path: latest.position?.new_path ?? latest.position?.old_path ?? null,
      line: latest.position?.new_line ?? null,
      originalLine: latest.position?.old_line ?? null,
      author: userName(latest.author),
      summary: latest.body.trim().slice(0, 500) || "GitLab discussion comment",
      url: latest.web_url ?? null,
    }];
  });
}

function metadata(input: { mr: GitLabMergeRequest; notes: GitLabNote[]; trustedMarkerAuthor: string | null; unavailable: string[]; ciDiagnostics: GitLabCiDiagnostic[] }): JsonObject {
  const head = headSha(input.mr);
  const laneReviews = input.notes.flatMap(note => {
    const parsed = trustedMetadataNote(note, input.trustedMarkerAuthor);
    if (parsed?.kind !== "lane-review" || !parsed.lane || !parsed.runId || !parsed.recommendation || !parsed.status || !parsed.summary) return [];
    return [{
      head: parsed.head,
      lane: parsed.lane,
      profile: parsed.profile ?? "",
      runId: parsed.runId,
      issueNumber: parsed.issueNumber ?? 0,
      prNumber: parsed.prNumber ?? input.mr.iid,
      host: parsed.host ?? "",
      recommendation: parsed.recommendation,
      status: parsed.status,
      summary: parsed.summary,
      inline: "gitlab-note",
      inlineCommentCount: parsed.inlineCommentCount ?? 0,
      bodyFindingCount: parsed.bodyFindingCount ?? 0,
      url: note.web_url ?? null,
      author: userName(note.author),
      stale: parsed.head !== head,
    }];
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
    reviewRequests: (input.mr.reviewers ?? []).map(userName),
    trustedMarkerAuthor: input.trustedMarkerAuthor,
    comments: syntheticComments,
    trustedLaneReviews: laneReviews,
    reviewRequestMarkers: requestMarkers,
    unavailable: input.unavailable,
    ciDiagnostics: input.ciDiagnostics.map(diagnostic => jsonValue(diagnostic)),
  };
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
