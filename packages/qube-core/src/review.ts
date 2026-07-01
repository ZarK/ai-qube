import type { ActionPlan, ActionResult, JsonObject, JsonValue, ProviderSource, WorkItemKey } from "./index.js";
import { uniqueWorkItemKeys } from "./index.js";

export type GateStage = "all" | "pre-pr" | "pre-merge";
export type GateResult = "passed" | "failed" | "skipped" | "needs-work" | "unknown" | "stale" | "missing";
export type EvidenceSource = "configured-gate" | "manual-audit" | "review-agent" | "provider-check" | "quality-control";
export type EvidenceTrust = "unverified" | "agent-reported" | "local-evidence" | "trusted-provider";
export type GateEvidenceReasonCode =
  | "agent-reported-result"
  | "local-evidence-found"
  | "trusted-provider-result"
  | "missing-evidence"
  | "malformed-evidence"
  | "unverified-notes"
  | "stale-evidence"
  | "manual-audit-disabled"
  | "manual-audit-incomplete"
  | "review-not-recorded"
  | "review-needs-work"
  | "provider-check-pending"
  | "provider-check-skipped"
  | "provider-check-stale";

export interface GateDefinition {
  readonly key: string;
  readonly name: string;
  readonly stage: GateStage;
  readonly required: boolean;
  readonly command: string | null;
  readonly externalService: boolean;
  readonly supplyChainSensitive: boolean;
}

export interface GateEvidence {
  readonly key: string;
  readonly name: string;
  readonly stage: GateStage;
  readonly result: GateResult;
  readonly source: EvidenceSource;
  readonly trust: EvidenceTrust;
  readonly command: string | null;
  readonly providerRunId: string | null;
  readonly path: string | null;
  readonly summary: string;
  readonly recordedAt: string | null;
  readonly reasonCode: GateEvidenceReasonCode;
  readonly stale: boolean;
  readonly metadata: JsonObject;
}

export type ReviewState = "open" | "closed" | "merged" | "draft" | "unknown";
export type ReviewDecision = "approved" | "changes-requested" | "review-required" | "commented" | "none" | "unknown";
export type Mergeability = "mergeable" | "blocked" | "conflicting" | "unknown";
export type ReviewFeedbackSource = "review" | "comment" | "review-comment" | "thread" | "provider";
export type FeedbackTrust = "untrusted" | "trusted-provider";

export interface ReviewItemKey {
  readonly providerId: string;
  readonly id: string;
}

export interface ReviewFeedback {
  readonly source: ReviewFeedbackSource;
  readonly author: string;
  readonly summary: string;
  readonly url: string | null;
  readonly state: string | null;
  readonly trust: FeedbackTrust;
}

export interface ReviewItem {
  readonly key: ReviewItemKey;
  readonly displayId: string;
  readonly title: string;
  readonly url: string | null;
  readonly sourceRef: string;
  readonly targetRef: string;
  readonly linkedWorkItems: readonly WorkItemKey[];
  readonly state: ReviewState;
  readonly reviewDecision: ReviewDecision;
  readonly mergeability: Mergeability;
  readonly feedback: readonly ReviewFeedback[];
  readonly checks: readonly GateEvidence[];
  readonly trustedMetadata: JsonObject;
  readonly source: ProviderSource;
}

export type ReviewAdapterKind = "github" | "remote" | "local" | "mixed" | "shadow";

export interface ReviewForgePolicy {
  readonly reviews: {
    readonly adapter: ReviewAdapterKind;
    readonly reviewers: readonly string[];
    readonly requestText: string;
  };
}

export type ReviewForgeProviderId = "github" | "gitlab";

export interface ReviewForgePullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly url: string;
  readonly headRefOid: string;
  readonly reviewDecision: string;
  readonly mergeStateStatus: string;
  readonly mergeable: string;
  readonly isDraft: boolean;
}

export interface ReviewForgeSnapshot {
  readonly item: ReviewItem;
  readonly headRefOid: string;
  readonly closingIssueNumbers: readonly number[];
  readonly unavailable: readonly string[];
  readonly reviewRequests: readonly string[];
  readonly commentsCount: number;
  readonly reviewsCount: number;
  readonly reviewCommentsCount: number;
  readonly unresolvedThreadsCount: number;
  readonly pullRequest: ReviewForgePullRequestSummary;
}

export interface ReviewForgeCapabilities {
  readonly loadReview: boolean;
  readonly loadReviewSnapshot: boolean;
  readonly findCurrentBranchReview: boolean;
  readonly planReviewRequests: boolean;
  readonly applyReviewRequests: boolean;
  readonly publishLaneReview?: boolean;
  readonly publishLaneReviewInline?: boolean;
}

export type ReviewFindingSeverity = "blocking" | "advisory";
export type ReviewFindingSide = "source" | "destination";

export interface ReviewFindingLocation {
  readonly path: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly side?: ReviewFindingSide;
}

export interface ReviewFinding {
  readonly id: string;
  readonly severity: ReviewFindingSeverity;
  readonly location?: ReviewFindingLocation;
  readonly message: string;
  readonly suggestion?: string;
}

export interface ReviewDiffIndex {
  hasLine(path: string, line: number): boolean;
}

export interface PartitionedReviewFindings {
  readonly inline: readonly ReviewFinding[];
  readonly body: readonly ReviewFinding[];
}

function stableFindingId(input: Omit<ReviewFinding, "id"> & { id?: string }): string {
  const base = [
    input.severity,
    input.location?.path ?? "",
    input.location?.line ?? "",
    input.location?.endLine ?? "",
    input.location?.side ?? "",
    input.message,
  ].join("\0");
  let hash = 0;
  for (let index = 0; index < base.length; index += 1) {
    hash = Math.imul(31, hash) + base.charCodeAt(index) | 0;
  }
  return `finding-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function normalizeReviewFinding(input: Omit<ReviewFinding, "id"> & { readonly id?: string }): ReviewFinding {
  const message = nonEmpty(input.message, "message");
  const severity = input.severity === "blocking" ? "blocking" : "advisory";
  let location: ReviewFindingLocation | undefined;
  if (input.location) {
    const path = nonEmpty(input.location.path, "location.path");
    const line = positiveInteger(input.location.line) ? input.location.line : undefined;
    const endLine = positiveInteger(input.location.endLine) ? input.location.endLine : undefined;
    const side = input.location.side === "source" ? "source" : "destination";
    location = { path, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}), side };
  }
  const suggestion = typeof input.suggestion === "string" && input.suggestion.trim() !== "" ? input.suggestion.trim() : undefined;
  return {
    id: typeof input.id === "string" && input.id.trim() !== "" ? input.id.trim() : stableFindingId({ severity, location, message, suggestion }),
    severity,
    ...(location ? { location } : {}),
    message,
    ...(suggestion ? { suggestion } : {}),
  };
}

export function partitionReviewFindings(findings: readonly ReviewFinding[], diffIndex: ReviewDiffIndex): PartitionedReviewFindings {
  const inline: ReviewFinding[] = [];
  const body: ReviewFinding[] = [];
  for (const finding of findings.map(normalizeReviewFinding)) {
    const location = finding.location;
    const line = location?.line;
    if (location && typeof line === "number" && location.side !== "source" && diffIndex.hasLine(location.path, line)) {
      inline.push(finding);
    } else {
      body.push(finding);
    }
  }
  return { inline, body };
}

export interface ReviewForgeProviderPlanOptions {
  readonly activeLanes?: readonly string[];
}

export interface ReviewForgeProvider {
  readonly id: ReviewForgeProviderId;
  capabilities(): ReviewForgeCapabilities;
  getReviewItem(key: ReviewItemKey): Promise<ReviewItem>;
  loadReviewSnapshot(key: ReviewItemKey): Promise<ReviewForgeSnapshot>;
  findReviewForCurrentBranch(): Promise<ReviewItem | null>;
  planReviewRequest(item: ReviewItem, policy: ReviewForgePolicy, options?: ReviewForgeProviderPlanOptions): ActionPlan;
  apply(plan: ActionPlan): Promise<readonly ActionResult[]>;
  publishLaneReviewFeedback?(item: ReviewItem, input: ReviewLaneReviewPublishInput): Promise<ReviewLaneReviewPublishResult>;
}

export interface ReviewLaneReviewPublishInput {
  readonly dryRun: boolean;
  readonly prNumber: number;
  readonly headSha: string;
  readonly lane: string;
  readonly profile: string;
  readonly status: string;
  readonly recommendation: "approve" | "request-changes" | "pending" | "inconclusive";
  readonly host: string;
  readonly issueNumber: number;
  readonly summary: string;
  readonly findings: readonly (ReviewFinding | string)[];
  readonly evidencePath: string | null;
}

export interface ReviewLaneReviewPublishResult {
  readonly status: "disabled" | "pending" | "planned" | "published" | "skipped" | "failed";
  readonly runId: string | null;
  readonly marker: string | null;
  readonly body: string | null;
  readonly url: string | null;
  readonly publishKind?: "issue-comment" | "pull-request-review";
  readonly inlineCommentCount?: number;
  readonly bodyFindingCount?: number;
  readonly reviewUrl?: string | null;
  readonly inlineCommentUrls?: readonly string[];
  readonly failure: string | null;
  readonly nextAction: string;
}

export interface ReviewAgentAdapter {
  readonly id: string;
  readonly handle: string;
  readonly kind: "remote-service" | "host-request";
  readonly requestTransport: "provider-comment" | "provider-reviewer";
  planRequestBody?(handle: string, policy: ReviewForgePolicy, headSha: string): string | Promise<string>;
  isNonActionableFeedback?(text: string, author: string): boolean;
  isOverviewFeedback?(text: string, author: string): boolean;
}

export type HostReviewRunnerId = "codex" | "opencode" | "local-command";

export interface HostReviewRunnerCapabilities {
  readonly independentReviewer: boolean;
  readonly freshContext: boolean;
  readonly promptOnly: boolean;
  readonly hooks: boolean;
  readonly evidenceWriting: boolean;
  readonly missingCapabilities: readonly string[];
  readonly nextAction: string;
}

export interface CodexReviewCapability extends HostReviewRunnerCapabilities {
  readonly host: "codex";
}

export interface HostReviewRunnerAdapter {
  readonly id: HostReviewRunnerId;
  probeCapability(configHints?: JsonObject): Promise<HostReviewRunnerCapabilities | CodexReviewCapability>;
}

export type AgentHostId = "opencode" | "codex" | "claude-code";

export interface InstructionTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
}

export type CommandRenderer = "make-it-so" | "codex-review-focus-agent";

export interface CommandTarget {
  readonly id: string;
  readonly path: string;
  readonly description: string;
  readonly optional: boolean;
  readonly enabledBy: "always" | "opencodeCommandAlias" | "codexLocalReview";
  readonly renderer: CommandRenderer;
}

export interface TodoCapability {
  readonly tools: readonly string[];
  readonly fallback: string;
  readonly instruction: string;
}

export interface DialogueCapability {
  readonly expectation: string;
}

export interface HookCapability {
  readonly supported: boolean;
  readonly description: string;
}

export interface SubagentCapability {
  readonly supported: boolean;
  readonly instruction: string;
}

export interface AgentHostProfile {
  readonly id: AgentHostId;
  readonly displayName: string;
  readonly instructionTargets: readonly InstructionTarget[];
  readonly commandTargets: readonly CommandTarget[];
  readonly todo: TodoCapability;
  readonly dialogue: DialogueCapability;
  readonly subagents: SubagentCapability;
  readonly hooks: HookCapability;
  readonly supportsProjectCommands: boolean;
}

export const QUBE_REVIEW_SERVICE_NAME = "QUBEReview";

export type ReviewParticipantKind = "remote-service" | "host-request" | "host-lane";

export type ReviewParticipantTransport = "provider-comment" | "provider-reviewer" | "host-lane";

export type ReviewParticipantRecommendation = "approve" | "request-changes" | "pending" | "inconclusive";

export interface ReviewParticipant {
  readonly id: string;
  readonly handle: string;
  readonly kind: ReviewParticipantKind;
  readonly transport: ReviewParticipantTransport;
  readonly externalService: boolean;
  readonly laneId: string | null;
}

export interface ReviewParticipantObservation {
  readonly participant: ReviewParticipant;
  readonly requestedForHead: boolean;
  readonly pending: boolean;
  readonly stale: boolean;
  readonly received: boolean;
  readonly recommendation: ReviewParticipantRecommendation | null;
  readonly summary: string | null;
  readonly url: string | null;
}

export interface ReviewParticipantRollup {
  readonly participants: readonly ReviewParticipantObservation[];
  readonly expectedCount: number;
  readonly receivedCount: number;
  readonly hostLaneExpected: number;
  readonly hostLaneReceived: number;
  readonly remoteSatisfied: boolean;
  readonly hostRequestSatisfied: boolean;
  readonly allHostLanesReceived: boolean;
  readonly anyHostLaneChangesRequested: boolean;
  readonly pendingSummary: string | null;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new Error(`${field} must be a non-empty string.`);
  return normalized;
}

function defaultReasonCode(input: Pick<GateEvidence, "result" | "source" | "trust">): GateEvidenceReasonCode {
  if (input.result === "missing") return "missing-evidence";
  if (input.result === "stale") return input.source === "provider-check" ? "provider-check-stale" : "stale-evidence";
  if (input.source === "provider-check") {
    if (input.result === "skipped") return "provider-check-skipped";
    if (input.result === "unknown") return "provider-check-pending";
    return input.trust === "trusted-provider" ? "trusted-provider-result" : "agent-reported-result";
  }
  if (input.source === "manual-audit") return input.trust === "local-evidence" ? "local-evidence-found" : "missing-evidence";
  if (input.source === "review-agent") return input.result === "needs-work" ? "review-needs-work" : "agent-reported-result";
  return input.trust === "trusted-provider" ? "trusted-provider-result" : "agent-reported-result";
}

export function normalizeGateEvidence(input: Omit<GateEvidence, "metadata" | "reasonCode" | "stale"> & { metadata?: JsonObject; reasonCode?: GateEvidenceReasonCode; stale?: boolean }): GateEvidence {
  const stale = input.stale ?? input.result === "stale";
  const result = stale ? "stale" : input.result;
  return {
    ...input,
    result,
    key: nonEmpty(input.key, "key"),
    name: nonEmpty(input.name, "name"),
    summary: nonEmpty(input.summary, "summary"),
    reasonCode: input.reasonCode ?? defaultReasonCode({ ...input, result }),
    stale,
    metadata: input.metadata ?? {},
  };
}

export function isVerifiedGateEvidence(evidence: GateEvidence): boolean {
  return !evidence.stale && evidence.result === "passed" && (evidence.trust === "trusted-provider" || evidence.trust === "local-evidence");
}

export function normalizeReviewItemKey(providerId: string, id: string): ReviewItemKey {
  return { providerId: nonEmpty(providerId, "providerId"), id: nonEmpty(id, "id") };
}

export function normalizeReviewFeedback(input: Omit<ReviewFeedback, "trust"> & { trust?: FeedbackTrust }): ReviewFeedback {
  return {
    ...input,
    author: nonEmpty(input.author, "author"),
    summary: nonEmpty(input.summary, "summary"),
    trust: input.trust ?? "untrusted",
  };
}

export function normalizeReviewItem(input: Omit<ReviewItem, "linkedWorkItems" | "feedback" | "checks" | "trustedMetadata"> & {
  linkedWorkItems?: readonly WorkItemKey[];
  feedback?: ReadonlyArray<Omit<ReviewFeedback, "trust"> & { trust?: FeedbackTrust }>;
  checks?: readonly GateEvidence[];
  trustedMetadata?: JsonObject;
}): ReviewItem {
  return {
    ...input,
    key: normalizeReviewItemKey(input.key.providerId, input.key.id),
    displayId: nonEmpty(input.displayId, "displayId"),
    title: nonEmpty(input.title, "title"),
    sourceRef: nonEmpty(input.sourceRef, "sourceRef"),
    targetRef: nonEmpty(input.targetRef, "targetRef"),
    linkedWorkItems: uniqueWorkItemKeys(input.linkedWorkItems ?? []),
    feedback: (input.feedback ?? []).map(normalizeReviewFeedback),
    checks: (input.checks ?? []).map(normalizeGateEvidence),
    trustedMetadata: input.trustedMetadata ?? {},
  };
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeHandle(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "@reviewer";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function participantReviewerId(name: string): string {
  return name.trim().toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "reviewer";
}

function hostReviewAdapter(adapter: ReviewAdapterKind): boolean {
  return adapter === "local" || adapter === "mixed" || adapter === "shadow";
}

function remoteReviewAdapter(adapter: ReviewAdapterKind): boolean {
  return adapter === "github" || adapter === "remote" || adapter === "mixed";
}

function remoteTriggerIsReviewer(name: string): boolean {
  return participantReviewerId(name) === "copilot";
}

export function resolveReviewParticipants(input: {
  adapter: ReviewAdapterKind;
  remoteReviewers: readonly string[];
  activeLanes: readonly string[];
}): ReviewParticipant[] {
  const participants: ReviewParticipant[] = [];
  const seen = new Set<string>();

  if (remoteReviewAdapter(input.adapter)) {
    for (const rawName of input.remoteReviewers) {
      const name = rawName.trim();
      if (name === "") continue;
      const id = participantReviewerId(name);
      if (seen.has(id)) continue;
      seen.add(id);
      participants.push({
        id,
        handle: normalizeHandle(name),
        kind: "remote-service",
        transport: remoteTriggerIsReviewer(name) ? "provider-reviewer" : "provider-comment",
        externalService: true,
        laneId: null,
      });
    }
  }

  if (hostReviewAdapter(input.adapter) && input.activeLanes.length > 0) {
    const requestId = participantReviewerId(QUBE_REVIEW_SERVICE_NAME);
    if (!seen.has(requestId)) {
      seen.add(requestId);
      participants.push({
        id: requestId,
        handle: normalizeHandle(QUBE_REVIEW_SERVICE_NAME),
        kind: "host-request",
        transport: "provider-comment",
        externalService: false,
        laneId: null,
      });
    }
    for (const laneId of input.activeLanes) {
      const id = `lane:${laneId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      participants.push({
        id,
        handle: `${normalizeHandle(QUBE_REVIEW_SERVICE_NAME)} (${laneId})`,
        kind: "host-lane",
        transport: "host-lane",
        externalService: false,
        laneId,
      });
    }
  }

  return participants;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRecommendation(value: unknown): ReviewParticipantRecommendation | null {
  if (value === "approve" || value === "request-changes" || value === "pending" || value === "inconclusive") return value;
  return null;
}

function laneReceivedFromAggregate(metadata: { [key: string]: JsonValue }, laneId: string, headSha: string): boolean {
  if (metadata.head !== headSha || metadata.stale === true) return false;
  const lanes = stringArray(metadata.lanes);
  return lanes.includes(laneId);
}

function laneRecommendationFromAggregate(metadata: { [key: string]: JsonValue }, laneId: string, headSha: string): ReviewParticipantRecommendation | null {
  if (!laneReceivedFromAggregate(metadata, laneId, headSha)) return null;
  return readRecommendation(metadata.recommendation);
}

function trustedLaneReviews(item: ReviewItem): Array<{ [key: string]: JsonValue }> {
  const value = item.trustedMetadata.trustedLaneReviews;
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject);
}

function trustedLocalReviews(item: ReviewItem): Array<{ [key: string]: JsonValue }> {
  const value = item.trustedMetadata.trustedLocalReviews;
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject);
}

function trustedReviewRequests(item: ReviewItem): string[] {
  return stringArray(item.trustedMetadata.reviewRequests);
}

function trustedComments(item: ReviewItem): Array<{ author: string | null; body: string | null }> {
  const value = item.trustedMetadata.comments;
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map(comment => ({
    author: typeof comment.author === "string" ? comment.author : null,
    body: typeof comment.body === "string" ? comment.body : null,
  }));
}

function trustedLatestReviews(item: ReviewItem): Array<{ author: string | null; commitOid: string | null }> {
  const value = item.trustedMetadata.latestReviews;
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonObject).map(review => ({
    author: typeof review.author === "string" ? review.author : null,
    commitOid: typeof review.commitOid === "string" ? review.commitOid : null,
  }));
}

function trustedMarkerAuthor(item: ReviewItem): string | null {
  const value = item.trustedMetadata.trustedMarkerAuthor;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function markerPrefix(reviewerId: string): string {
  return `<!-- aie:pr-gate:${reviewerId}:`;
}

function hasTrustedMarker(comments: ReturnType<typeof trustedComments>, reviewerId: string, headSha: string, trustedAuthor: string | null): boolean {
  if (trustedAuthor === null) return false;
  const marker = `${markerPrefix(reviewerId)}${headSha} -->`;
  return comments.some(comment => comment.author === trustedAuthor && (comment.body ?? "").includes(marker));
}

function hasStaleTrustedMarker(comments: ReturnType<typeof trustedComments>, reviewerId: string, headSha: string, trustedAuthor: string | null): boolean {
  if (hasTrustedMarker(comments, reviewerId, headSha, trustedAuthor)) return false;
  if (trustedAuthor === null) return false;
  const prefix = markerPrefix(reviewerId);
  return comments.some(comment => comment.author === trustedAuthor && (comment.body ?? "").includes(prefix));
}

function authorMatches(author: string | null, reviewer: string): boolean {
  if (author === null) return false;
  return author.toLowerCase().replace(/^@/, "") === reviewer.toLowerCase().replace(/^@/, "");
}

function isPendingRemoteRequest(requests: string[], handle: string): boolean {
  return requests.some(request => authorMatches(request, handle));
}

function isCurrentRemoteReview(reviews: ReturnType<typeof trustedLatestReviews>, handle: string, headSha: string): boolean {
  return reviews.some(review => authorMatches(review.author, handle) && review.commitOid === headSha);
}

function hasStaleRemoteReview(reviews: ReturnType<typeof trustedLatestReviews>, handle: string, headSha: string): boolean {
  return reviews.some(review => authorMatches(review.author, handle) && review.commitOid !== null && review.commitOid !== headSha);
}

function laneReviewRecord(item: ReviewItem, laneId: string, headSha: string): { [key: string]: JsonValue } | null {
  const laneReviews = trustedLaneReviews(item).filter(record => record.lane === laneId && record.head === headSha && record.stale !== true);
  const laneReview = laneReviews.at(-1);
  if (laneReview) return laneReview;
  const aggregate = trustedLocalReviews(item).find(record => laneReceivedFromAggregate(record, laneId, headSha));
  return aggregate ?? null;
}

export function observeReviewParticipants(item: ReviewItem, participants: readonly ReviewParticipant[], headSha: string): ReviewParticipantObservation[] {
  const comments = trustedComments(item);
  const requests = trustedReviewRequests(item);
  const reviews = trustedLatestReviews(item);
  const trustedAuthor = trustedMarkerAuthor(item);

  return participants.map(participant => {
    if (participant.kind === "remote-service") {
      const requestedForHead = participant.transport === "provider-reviewer"
        ? hasTrustedMarker(comments, participant.id, headSha, trustedAuthor) || isCurrentRemoteReview(reviews, participant.handle, headSha)
        : hasTrustedMarker(comments, participant.id, headSha, trustedAuthor);
      const pending = isPendingRemoteRequest(requests, participant.handle);
      const stale = participant.transport === "provider-reviewer"
        ? !requestedForHead && !pending && (hasStaleTrustedMarker(comments, participant.id, headSha, trustedAuthor) || hasStaleRemoteReview(reviews, participant.handle, headSha))
        : !requestedForHead && hasStaleTrustedMarker(comments, participant.id, headSha, trustedAuthor);
      return {
        participant,
        requestedForHead,
        pending,
        stale,
        received: requestedForHead && !pending && !stale,
        recommendation: null,
        summary: null,
        url: typeof participant.laneId === "string" ? null : null,
      };
    }

    if (participant.kind === "host-request") {
      const requestedForHead = hasTrustedMarker(comments, participant.id, headSha, trustedAuthor);
      const stale = !requestedForHead && hasStaleTrustedMarker(comments, participant.id, headSha, trustedAuthor);
      return {
        participant,
        requestedForHead,
        pending: false,
        stale,
        received: requestedForHead,
        recommendation: null,
        summary: null,
        url: null,
      };
    }

    const laneId = participant.laneId ?? "";
    const laneRecord = laneReviewRecord(item, laneId, headSha);
    const received = laneRecord !== null;
    const recommendation = received
      ? readRecommendation(laneRecord.recommendation) ?? laneRecommendationFromAggregate(laneRecord, laneId, headSha)
      : null;
    return {
      participant,
      requestedForHead: received,
      pending: false,
      stale: laneRecord?.stale === true,
      received,
      recommendation,
      summary: received && typeof laneRecord.summary === "string" ? laneRecord.summary : null,
      url: received && typeof laneRecord.url === "string" ? laneRecord.url : null,
    };
  });
}

export function rollupReviewParticipants(observations: readonly ReviewParticipantObservation[]): ReviewParticipantRollup {
  const hostLanes = observations.filter(item => item.participant.kind === "host-lane");
  const hostRequest = observations.find(item => item.participant.kind === "host-request");
  const remotes = observations.filter(item => item.participant.kind === "remote-service");
  const hostLaneReceived = hostLanes.filter(item => item.received).length;
  const receivedCount = observations.filter(item => item.received).length;
  const anyHostLaneChangesRequested = hostLanes.some(item => item.received && item.recommendation === "request-changes");

  let pendingSummary: string | null = null;
  if (hostRequest && !hostRequest.requestedForHead) {
    pendingSummary = `Post the configured ${QUBE_REVIEW_SERVICE_NAME} review request on the pull request, then rerun the PR gate.`;
  } else if (hostLanes.length > 0 && hostLaneReceived < hostLanes.length) {
    pendingSummary = `Provider review feedback: ${hostLaneReceived} of ${hostLanes.length} lane reviews received on the pull request. Wait for all review subagents to publish before addressing feedback or editing the implementation.`;
  } else if (remotes.some(item => item.stale)) {
    pendingSummary = "A configured remote review request is stale for the current PR head. Rerun the PR gate for the current head.";
  } else if (remotes.some(item => !item.requestedForHead || item.pending)) {
    pendingSummary = "Wait for configured remote PR review agents to finish on the pull request, then rerun the PR gate.";
  }

  return {
    participants: [...observations],
    expectedCount: observations.length,
    receivedCount,
    hostLaneExpected: hostLanes.length,
    hostLaneReceived,
    remoteSatisfied: remotes.every(item => item.requestedForHead && !item.pending && !item.stale),
    hostRequestSatisfied: hostRequest ? hostRequest.requestedForHead && !hostRequest.stale : true,
    allHostLanesReceived: hostLanes.length === 0 || hostLaneReceived === hostLanes.length,
    anyHostLaneChangesRequested,
    pendingSummary,
  };
}

export function participantsBlockGateCompletion(rollup: ReviewParticipantRollup): boolean {
  if (!rollup.hostRequestSatisfied) return true;
  if (!rollup.allHostLanesReceived) return true;
  if (!rollup.remoteSatisfied) return true;
  return false;
}

export function participantsNeedRerun(rollup: ReviewParticipantRollup): boolean {
  return rollup.participants.some(observation =>
    (observation.participant.kind === "remote-service" || observation.participant.kind === "host-request") && observation.stale);
}

export function participantsOnlyAwaitingHostWork(rollup: ReviewParticipantRollup): boolean {
  if (participantsNeedRerun(rollup)) return false;
  if (rollup.remoteSatisfied && rollup.hostRequestSatisfied && rollup.allHostLanesReceived) return false;
  return !rollup.hostRequestSatisfied || !rollup.allHostLanesReceived;
}
