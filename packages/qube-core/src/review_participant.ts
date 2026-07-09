import type { JsonValue } from "./json_value.js";
import type { ReviewForgeAdapterKind } from "./review_forge.js";
import type { ReviewItem } from "./review_item.js";

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

export interface ReviewParticipantAgentAdapter {
  readonly id: string;
  readonly aliases: readonly string[];
  readonly trigger: "github-reviewer" | "comment" | "local-host" | "local-command";
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

function hostReviewAdapter(adapter: ReviewForgeAdapterKind): boolean {
  return adapter === "local" || adapter === "mixed" || adapter === "shadow";
}

function remoteReviewAdapter(adapter: ReviewForgeAdapterKind): boolean {
  return adapter === "github" || adapter === "remote" || adapter === "mixed";
}

function remoteTriggerIsReviewer(name: string, adapters: readonly ReviewParticipantAgentAdapter[] = []): boolean {
  const id = participantReviewerId(name);
  const adapter = adapters.find(candidate => candidate.id === id || candidate.aliases.includes(id));
  if (adapter) return adapter.trigger === "github-reviewer";
  return id === "copilot";
}

export function resolveReviewParticipants(input: {
  adapter: ReviewForgeAdapterKind;
  remoteReviewers: readonly string[];
  activeLanes: readonly string[];
  remoteReviewAgentAdapters?: readonly ReviewParticipantAgentAdapter[];
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
        transport: remoteTriggerIsReviewer(name, input.remoteReviewAgentAdapters) ? "provider-reviewer" : "provider-comment",
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
  const laneReviews = trustedLaneReviews(item).filter(record => record.lane === laneId && record.head === headSha && record.stale !== true && (record.inline === "review-api" || record.inline === "issue-comment" || record.inline === "gitlab-note"));
  const laneReview = laneReviews.at(-1);
  if (laneReview) return laneReview;
  const aggregate = trustedLocalReviews(item).find(record => laneReceivedFromAggregate(record, laneId, headSha));
  return aggregate ?? null;
}

export function observeReviewParticipants(item: ReviewItem, participants: readonly ReviewParticipant[], headSha: string, carriedForwardLanes: readonly string[] = []): ReviewParticipantObservation[] {
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
    if (laneRecord === null && carriedForwardLanes.includes(laneId)) {
      return {
        participant,
        requestedForHead: true,
        pending: false,
        stale: false,
        received: true,
        recommendation: "approve",
        summary: "Carried forward from a prior approved review; provider publishing is suppressed by policy.",
        url: null,
      };
    }
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
