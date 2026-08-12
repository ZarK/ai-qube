import {
  QUBE_REVIEW_SERVICE_NAME,
  observeReviewParticipants,
  participantReviewerId,
  participantsBlockGateCompletion,
  participantsNeedRerun,
  rollupReviewParticipants,
  type ReviewParticipant,
} from './core/review_participant.js';
import type { ReviewItem } from '@tjalve/qube-core';
import type { Config, ReviewSourceConfig, ReviewSourceIdentity, ReviewSourceMarkers } from './config/index.js';
import { requiredLocalReviewLanes } from './local_review_evidence.js';

export interface ReviewSourceReadiness {
  id: string;
  identity: ReviewSourceIdentity;
  markers: ReviewSourceMarkers;
  blocking: boolean;
  expected: string[];
  received: string[];
  missing: string[];
  satisfied: boolean;
  pendingSummary: string | null;
}

export interface ReviewSourceContract {
  sources: ReviewSourceReadiness[];
  allSatisfied: boolean;
}

function normalizeHandle(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '@reviewer';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

// Construction only: the source declares an identity (lane ids or reviewer
// identities) and a marker style (trusted structured marker or plain
// provider review); every downstream satisfaction check below stays generic
// over the resulting participant list and never branches on source kind.
function participantsForSource(source: ReviewSourceConfig): ReviewParticipant[] {
  const seen = new Set<string>();
  const participants: ReviewParticipant[] = [];
  if (source.identity === 'lane') {
    for (const laneId of source.expected) {
      if (seen.has(laneId)) continue;
      seen.add(laneId);
      participants.push({
        id: `source:${source.id}:${laneId}`,
        handle: `${normalizeHandle(QUBE_REVIEW_SERVICE_NAME)} (${laneId})`,
        kind: 'host-lane',
        transport: 'host-lane',
        externalService: false,
        laneId,
      });
    }
    return participants;
  }
  for (const name of source.expected) {
    const id = participantReviewerId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    participants.push({
      id,
      handle: normalizeHandle(name),
      kind: 'remote-service',
      transport: source.markers === 'trusted' ? 'provider-comment' : 'provider-reviewer',
      externalService: true,
      laneId: null,
    });
  }
  return participants;
}

/** Evaluate one configured review source against the provider record at a head; reused unchanged for every source, lane or reviewer. */
export function evaluateReviewSource(source: ReviewSourceConfig, item: ReviewItem, headSha: string, carriedForwardLanes: readonly string[] = []): ReviewSourceReadiness {
  const participants = participantsForSource(source);
  const observations = observeReviewParticipants(item, participants, headSha, source.identity === 'lane' ? carriedForwardLanes : []);
  const rollup = rollupReviewParticipants(observations);
  const satisfied = !participantsBlockGateCompletion(rollup) && !participantsNeedRerun(rollup) && !rollup.anyChangesRequested;
  const receivedIds = new Set(
    observations
      .filter(observation => observation.received)
      .map(observation => source.identity === 'lane' ? (observation.participant.laneId ?? '') : participantReviewerId(observation.participant.handle)),
  );
  const expectedIds = source.identity === 'lane'
    ? [...new Set(source.expected)]
    : [...new Set(source.expected.map(name => participantReviewerId(name)))];
  return {
    id: source.id,
    identity: source.identity,
    markers: source.markers,
    blocking: source.blocking,
    expected: [...source.expected],
    received: expectedIds.filter(id => receivedIds.has(id)),
    missing: expectedIds.filter(id => !receivedIds.has(id)),
    satisfied,
    pendingSummary: rollup.pendingSummary,
  };
}

/** Shared contract: every configured, enabled source is evaluated the same way, and readiness means every blocking source is satisfied. */
export function evaluateReviewSourceContract(sources: readonly ReviewSourceConfig[], item: ReviewItem, headSha: string, carriedForwardLanes: readonly string[] = []): ReviewSourceContract {
  const evaluated = sources.filter(source => source.enabled).map(source => evaluateReviewSource(source, item, headSha, carriedForwardLanes));
  return { sources: evaluated, allSatisfied: evaluated.every(source => !source.blocking || source.satisfied) };
}

// Dogfood compatibility: when repository config declares no explicit
// sources, derive the same expectations the adapter already implies today
// (routed local lanes when local review is required, configured provider
// reviewers when the adapter requests them). `activeLaneIds`, when given, is
// the caller's own dynamic active-lane resolution so the derived default
// never diverges from what the caller already treats as required.
function defaultReviewSources(config: Config, activeLaneIds: readonly string[] | undefined): ReviewSourceConfig[] {
  const sources: ReviewSourceConfig[] = [];
  const localRequired = (config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed') && config.reviewProfile !== 'local-shadow';
  if (localRequired) {
    const profile = config.reviewProfile === 'remote-compatible' ? 'local-standard' : config.reviewProfile;
    const expected = activeLaneIds && activeLaneIds.length > 0 ? [...activeLaneIds] : [...requiredLocalReviewLanes(profile)];
    if (expected.length > 0) {
      sources.push({ id: 'local-lanes', identity: 'lane', expected, blocking: true, markers: 'trusted', enabled: true });
    }
  }
  const remoteEnabled = config.reviewAdapter === 'github' || config.reviewAdapter === 'remote' || config.reviewAdapter === 'mixed';
  const reviewers = config.reviewAgents.map(name => name.trim()).filter(name => name !== '');
  if (remoteEnabled && reviewers.length > 0) {
    sources.push({ id: 'provider-reviewers', identity: 'reviewer', expected: reviewers, blocking: true, markers: 'provider', enabled: true });
  }
  return sources;
}

/** The configured or, when omitted, adapter-derived set of enabled review sources for this repository. */
export function resolveReviewSources(config: Config, options: { activeLaneIds?: readonly string[] } = {}): ReviewSourceConfig[] {
  const declared = config.reviewSources.length > 0 ? config.reviewSources : defaultReviewSources(config, options.activeLaneIds);
  return declared.filter(source => source.enabled);
}
