import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './gh.js';

export type LocalReviewStatus = 'passed' | 'failed' | 'needs-work' | 'pending' | 'missing' | 'stale' | 'unavailable' | 'malformed';

export type LocalReviewLaneId = 'code-quality' | 'security-maintainability' | 'qa' | 'final-gate';

export interface LocalReviewLane {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  summary: string;
  blockers: string[];
  artifacts: string[];
  commands: string[];
  surfaces: string[];
}

export interface LocalReviewEvidence {
  issueNumber: number | null;
  prNumber: number;
  headSha: string;
  status: LocalReviewStatus;
  path: string | null;
  reviewer: {
    id: string;
    name: string;
    adapterKind: 'local';
  };
  summary: string;
  blockers: string[];
  lanes: LocalReviewLane[];
  recordedAt: string | null;
  stale: boolean;
}

export interface LocalReviewGate {
  required: boolean;
  reviewers: string[];
  requiredLanes: LocalReviewLaneId[];
  evidence: LocalReviewEvidence[];
  status: LocalReviewStatus;
  summary: string;
  nextAction: string;
}

export const REQUIRED_LOCAL_REVIEW_LANES: readonly LocalReviewLaneId[] = [
  'code-quality',
  'security-maintainability',
  'qa',
  'final-gate',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? redact(value.trim()) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(redact) : [];
}

function readStatus(value: unknown): LocalReviewStatus {
  if (value === 'passed' || value === 'failed' || value === 'needs-work' || value === 'pending' || value === 'missing' || value === 'stale' || value === 'unavailable') return value;
  return 'malformed';
}

function readLaneId(value: unknown): LocalReviewLaneId | null {
  if (value === 'code-quality' || value === 'security-maintainability' || value === 'qa' || value === 'final-gate') return value;
  return null;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function evidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`, `pr-${prNumber}`, `${safeSegment(headSha)}.json`);
}

function evidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number): string {
  return join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`, `pr-${prNumber}`);
}

function fallbackReviewer(reviewers: readonly string[]): LocalReviewEvidence['reviewer'] {
  const first = reviewers.map(name => name.trim()).find(name => name !== '') ?? 'local-reviewer';
  return { id: safeSegment(first), name: redact(first), adapterKind: 'local' };
}

function malformedEvidence(issueNumber: number | null, prNumber: number, headSha: string, path: string | null, summary: string, reviewers: readonly string[]): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    status: 'malformed',
    path: path ? redact(path) : null,
    reviewer: fallbackReviewer(reviewers),
    summary,
    blockers: [summary],
    lanes: [],
    recordedAt: null,
    stale: false,
  };
}

function missingEvidence(issueNumber: number | null, prNumber: number, headSha: string, path: string | null, reviewers: readonly string[]): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    status: 'missing',
    path: path ? redact(path) : null,
    reviewer: fallbackReviewer(reviewers),
    summary: issueNumber === null
      ? 'Local review evidence requires a linked issue number before it can satisfy the PR gate.'
      : 'No local review evidence is recorded for this issue, pull request, and PR head.',
    blockers: [],
    lanes: [],
    recordedAt: null,
    stale: false,
  };
}

function staleEvidence(issueNumber: number, prNumber: number, headSha: string, path: string, reviewers: readonly string[]): LocalReviewEvidence {
  return {
    issueNumber,
    prNumber,
    headSha: redact(headSha),
    status: 'stale',
    path: redact(path),
    reviewer: fallbackReviewer(reviewers),
    summary: 'Local review evidence exists for an older PR head. Rerun local review lanes for the current head.',
    blockers: [],
    lanes: [],
    recordedAt: null,
    stale: true,
  };
}

function readLanes(value: unknown): LocalReviewLane[] | null {
  if (!Array.isArray(value)) return null;
  const lanes: LocalReviewLane[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const id = readLaneId(entry.id);
    if (!id) return null;
    lanes.push({
      id,
      status: readStatus(entry.status),
      summary: stringValue(entry.summary, `${id} local review lane did not provide a summary.`),
      blockers: stringArray(entry.blockers),
      artifacts: stringArray(entry.artifacts),
      commands: stringArray(entry.commands),
      surfaces: stringArray(entry.surfaces),
    });
  }
  return lanes;
}

function laneStatus(lanes: readonly LocalReviewLane[]): LocalReviewStatus {
  for (const lane of lanes) if (lane.status === 'malformed') return 'malformed';
  for (const lane of lanes) if (lane.status === 'unavailable') return 'unavailable';
  for (const lane of lanes) if (lane.status === 'failed') return 'failed';
  for (const lane of lanes) if (lane.status === 'needs-work') return 'needs-work';
  for (const lane of lanes) if (lane.status === 'stale') return 'stale';
  for (const lane of lanes) if (lane.status === 'pending') return 'pending';
  const byId = new Map(lanes.map(lane => [lane.id, lane]));
  for (const laneId of REQUIRED_LOCAL_REVIEW_LANES) {
    if (!byId.has(laneId)) return 'missing';
    if (byId.get(laneId)?.status !== 'passed') return 'pending';
  }
  return 'passed';
}

function reviewerFrom(value: unknown, reviewers: readonly string[]): LocalReviewEvidence['reviewer'] {
  if (!isRecord(value)) return fallbackReviewer(reviewers);
  const id = stringValue(value.id, '');
  const name = stringValue(value.name, id || 'local-reviewer');
  return { id: safeSegment(id || name), name, adapterKind: 'local' };
}

function parseEvidence(path: string, issueNumber: number, prNumber: number, headSha: string, reviewers: readonly string[]): LocalReviewEvidence {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence JSON must be an object.', reviewers);
    if (parsed.schemaVersion !== 1) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence schemaVersion must be 1.', reviewers);
    if (parsed.issueNumber !== issueNumber || parsed.prNumber !== prNumber) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence issue or PR metadata does not match this gate.', reviewers);
    if (typeof parsed.headSha !== 'string' || parsed.headSha.trim() === '') return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence headSha metadata must be a non-empty string for this gate.', reviewers);
    if (parsed.headSha !== headSha) return staleEvidence(issueNumber, prNumber, headSha, path, reviewers);
    const lanes = readLanes(parsed.lanes);
    if (!lanes) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence must include a lanes array with known lane ids.', reviewers);
    const status = laneStatus(lanes);
    const blockers = [...stringArray(parsed.blockers), ...lanes.flatMap(lane => lane.blockers)].filter((value, index, values) => values.indexOf(value) === index);
    return {
      issueNumber,
      prNumber,
      headSha: redact(headSha),
      status,
      path: redact(path),
      reviewer: reviewerFrom(parsed.reviewer, reviewers),
      summary: stringValue(parsed.summary, status === 'passed' ? 'All required local review lanes passed.' : 'Local review evidence requires attention.'),
      blockers,
      lanes,
      recordedAt: typeof parsed.recordedAt === 'string' ? redact(parsed.recordedAt) : null,
      stale: status === 'stale',
    };
  } catch {
    return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence JSON could not be parsed.', reviewers);
  }
}

function parseIssueEvidence(path: string, issueNumber: number, reviewers: readonly string[]): LocalReviewEvidence {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isRecord(parsed)) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence JSON must be an object.', reviewers);
    if (parsed.schemaVersion !== 1) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence schemaVersion must be 1.', reviewers);
    if (parsed.issueNumber !== issueNumber) return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence issue metadata does not match this gate.', reviewers);
    const prNumber = typeof parsed.prNumber === 'number' && Number.isSafeInteger(parsed.prNumber) && parsed.prNumber > 0 ? parsed.prNumber : 0;
    const headSha = typeof parsed.headSha === 'string' && parsed.headSha.trim() !== '' ? parsed.headSha : 'unknown';
    const lanes = readLanes(parsed.lanes);
    if (!lanes) return malformedEvidence(issueNumber, prNumber, headSha, path, 'Local review evidence must include a lanes array with known lane ids.', reviewers);
    const status = laneStatus(lanes);
    const blockers = [...stringArray(parsed.blockers), ...lanes.flatMap(lane => lane.blockers)].filter((value, index, values) => values.indexOf(value) === index);
    return {
      issueNumber,
      prNumber,
      headSha: redact(headSha),
      status,
      path: redact(path),
      reviewer: reviewerFrom(parsed.reviewer, reviewers),
      summary: stringValue(parsed.summary, status === 'passed' ? 'All required local review lanes passed.' : 'Local review evidence requires attention.'),
      blockers,
      lanes,
      recordedAt: typeof parsed.recordedAt === 'string' ? redact(parsed.recordedAt) : null,
      stale: status === 'stale',
    };
  } catch {
    return malformedEvidence(issueNumber, 0, 'unknown', path, 'Local review evidence JSON could not be parsed.', reviewers);
  }
}

function findStaleEvidence(repoRoot: string, issueNumber: number, prNumber: number): string | null {
  const directory = evidenceDirectory(repoRoot, issueNumber, prNumber);
  if (!existsSync(directory)) return null;
  try {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      .sort();
    return files.length === 0 ? null : join(directory, files[files.length - 1]);
  } catch {
    return null;
  }
}

function findIssueEvidence(repoRoot: string, issueNumber: number): string[] {
  const directory = join(repoRoot, '.qube', 'aie', 'pr-reviews', `issue-${issueNumber}`);
  if (!existsSync(directory)) return [];
  try {
    const prDirectories = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('pr-'))
      .map(entry => join(directory, entry.name));
    return prDirectories.flatMap(prDirectory => {
      try {
        return readdirSync(prDirectory, { withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
          .map(entry => join(prDirectory, entry.name));
      } catch {
        return [];
      }
    }).sort();
  } catch {
    return [];
  }
}

function statusPriority(status: LocalReviewStatus): number {
  return {
    malformed: 7,
    unavailable: 6,
    failed: 5,
    'needs-work': 4,
    stale: 3,
    pending: 2,
    missing: 1,
    passed: 0,
  }[status];
}

function gateStatus(evidence: readonly LocalReviewEvidence[]): LocalReviewStatus {
  return evidence.reduce<LocalReviewStatus>((current, item) => statusPriority(item.status) > statusPriority(current) ? item.status : current, 'passed');
}

function gateNextAction(status: LocalReviewStatus, prNumber: number): string {
  const rerunCommand = prNumber > 0 ? `\`aie pr gate ${prNumber}\`` : '`aie pr gate <pr>`';
  if (status === 'passed') return prNumber > 0
    ? `Local review evidence is current for PR #${prNumber}; inspect PR state, checks, issue checklist, and any feedback before merge.`
    : 'Local review evidence is recorded; inspect PR state, checks, issue checklist, and any feedback before merge.';
  if (status === 'stale') return `Rerun local review lanes for the current PR head, refresh local evidence, then rerun ${rerunCommand}.`;
  if (status === 'failed' || status === 'needs-work') return 'Address local review blockers, rerun affected checks, refresh local evidence, and rerun the PR gate.';
  if (status === 'unavailable' || status === 'malformed') return 'Fix local review evidence format or runner availability, then rerun the PR gate.';
  return `Record local review evidence for all required lanes, then rerun ${rerunCommand}.`;
}

export function readLocalReviewGate(input: {
  repoRoot: string;
  issueNumbers: readonly number[];
  prNumber: number;
  headSha: string;
  reviewers: readonly string[];
  required: boolean;
}): LocalReviewGate {
  const reviewers = input.reviewers.map(redact);
  if (!input.required) {
    return { required: false, reviewers, requiredLanes: [...REQUIRED_LOCAL_REVIEW_LANES], evidence: [], status: 'passed', summary: 'Local review evidence is not required by the selected review adapter.', nextAction: 'No local review evidence action is required.' };
  }
  if (input.issueNumbers.length === 0) {
    const evidence = [missingEvidence(null, input.prNumber, input.headSha, null, input.reviewers)];
    return { required: true, reviewers, requiredLanes: [...REQUIRED_LOCAL_REVIEW_LANES], evidence, status: 'missing', summary: evidence[0].summary, nextAction: gateNextAction('missing', input.prNumber) };
  }
  const evidence = input.issueNumbers.map(issueNumber => {
    const currentPath = evidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha);
    if (existsSync(currentPath)) return parseEvidence(currentPath, issueNumber, input.prNumber, input.headSha, input.reviewers);
    const stalePath = findStaleEvidence(input.repoRoot, issueNumber, input.prNumber);
    if (stalePath) return staleEvidence(issueNumber, input.prNumber, input.headSha, stalePath, input.reviewers);
    return missingEvidence(issueNumber, input.prNumber, input.headSha, currentPath, input.reviewers);
  });
  const status = gateStatus(evidence);
  return {
    required: true,
    reviewers,
    requiredLanes: [...REQUIRED_LOCAL_REVIEW_LANES],
    evidence,
    status,
    summary: evidence.map(item => `#${item.issueNumber ?? 'unknown'}: ${item.status} - ${item.summary}`).join(' '),
    nextAction: gateNextAction(status, input.prNumber),
  };
}

export function readLocalIssueReviewGate(input: {
  repoRoot: string;
  issueNumber: number;
  reviewers: readonly string[];
  required: boolean;
}): LocalReviewGate {
  const reviewers = input.reviewers.map(redact);
  if (!input.required) {
    return { required: false, reviewers, requiredLanes: [...REQUIRED_LOCAL_REVIEW_LANES], evidence: [], status: 'passed', summary: 'Local review evidence is not required by the selected review adapter.', nextAction: 'No local review evidence action is required.' };
  }
  const evidencePaths = findIssueEvidence(input.repoRoot, input.issueNumber);
  const evidence = evidencePaths.length === 0
    ? [missingEvidence(input.issueNumber, 0, 'unknown', null, input.reviewers)]
    : evidencePaths.map(path => parseIssueEvidence(path, input.issueNumber, input.reviewers));
  const status = gateStatus(evidence);
  return {
    required: true,
    reviewers,
    requiredLanes: [...REQUIRED_LOCAL_REVIEW_LANES],
    evidence,
    status,
    summary: evidence.map(item => `#${item.issueNumber ?? 'unknown'} PR #${item.prNumber || 'unknown'}: ${item.status} - ${item.summary}`).join(' '),
    nextAction: gateNextAction(status, evidence.find(item => item.prNumber > 0)?.prNumber ?? 0),
  };
}
