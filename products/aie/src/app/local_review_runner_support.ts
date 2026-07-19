import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { renderAgentPrompt } from '../agent_descriptors.js';
import { redact } from '../redact.js';
import { carryForwardDeltaTouched, defaultCarryForwardContext, type CarryForwardContextMode } from '../review_focus.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, LANE_ARTIFACT_REQUIREMENT, localReviewEvidenceSha256, trustedLocalHostProvenancePath, type LocalReviewContextReviewed, type LocalReviewLaneId, type LocalReviewProfile, type LocalReviewRecommendation, type LocalReviewRunnerProvenance, type LocalReviewSeverity, type LocalReviewStatus } from '../local_review_evidence.js';
import type { ReviewModelHostId, ReviewModelTierId, ReviewModelsPolicy } from '../core/policy.js';
import type { ReviewFinding } from '@tjalve/qube-core';
import type { PrGateExec, PrGateExecResult } from './pr_gate.js';

const execFileAsync = promisify(execFile);

export interface LaneEvidence {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  severity: LocalReviewSeverity;
  recommendation: LocalReviewRecommendation;
  summary: string;
  blockers: string[];
  findings: ReviewFinding[];
  artifacts: Array<{ kind: string; path: string; sha256: string | null }>;
  commands: string[];
  surfaces: string[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: Array<{ id: string; source: string; sourceCategory?: string; path: string | null; sha256: string | null; trust: string }>;
  toolsUsed: string[];
  completeness: string;
  preconditions: string[];
  runnerProvenance: LocalReviewRunnerProvenance | null;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function laneEvidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha));
}

export function laneEvidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.json`);
}

export interface RouteFaultRecord {
  count: number;
  routeKey: string;
  lastReasonCode: string;
  lastAt: string;
}

export interface RouteFaultLedger {
  version: 1;
  lanes: Record<string, RouteFaultRecord>;
}

// The ledger influences which provider executes review, so it lives under
// .git beside the trusted host-provenance store where pull request content
// can never supply or forge it; working-tree copies are never consumed.
export function routeFaultLedgerPath(repoRoot: string, issueNumber: number, prNumber: number): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'route-faults', String(issueNumber), `${prNumber}.json`);
}

export function readRouteFaults(repoRoot: string, issueNumber: number, prNumber: number): RouteFaultLedger {
  const path = routeFaultLedgerPath(repoRoot, issueNumber, prNumber);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isRecord(parsed) && parsed.version === 1 && isRecord(parsed.lanes)) {
      const lanes: Record<string, RouteFaultRecord> = {};
      for (const [lane, record] of Object.entries(parsed.lanes)) {
        if (!isRecord(record) || !Number.isSafeInteger(record.count) || Number(record.count) < 1) continue;
        lanes[lane] = {
          count: Number(record.count),
          routeKey: typeof record.routeKey === 'string' ? record.routeKey : '',
          lastReasonCode: typeof record.lastReasonCode === 'string' ? record.lastReasonCode : 'unknown',
          lastAt: typeof record.lastAt === 'string' ? record.lastAt : '',
        };
      }
      return { version: 1, lanes };
    }
  } catch {
    // A missing or malformed ledger means no recorded faults.
  }
  return { version: 1, lanes: {} };
}

const ROUTE_FAULT_LOCK_STALE_MS = 30_000;
const ROUTE_FAULT_LOCK_RETRY_MS = 25;
const ROUTE_FAULT_LOCK_HARD_DEADLINE_MS = 90_000;

function lockHolderAlive(lockDir: string): boolean | null {
  try {
    const holder = JSON.parse(readFileSync(join(lockDir, 'holder.json'), 'utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(holder.pid)) return null;
    try {
      process.kill(Number(holder.pid), 0);
      return true;
    } catch (err: unknown) {
      return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'EPERM';
    }
  } catch {
    return null; // No readable holder record; liveness is unknown.
  }
}

// Serialize ledger read-modify-write across concurrent gate processes with a
// mkdir lock carrying the holder pid. Real holds last microseconds. A lock is
// reclaimed only when it is old beyond the staleness threshold AND its holder
// process is provably not alive (or unrecorded), so a slow live writer is never
// overlapped; pid reuse combined with the age threshold is the residual risk.
// A hard deadline turns an unremovable or hostile lock into an explicit error
// instead of an unbounded hang.
function withRouteFaultLock<T>(path: string, update: () => T): T {
  const lockDir = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const hardDeadline = Date.now() + ROUTE_FAULT_LOCK_HARD_DEADLINE_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'holder.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      break;
    } catch {
      if (Date.now() > hardDeadline) {
        throw new Error(`Route-fault ledger lock could not be acquired at ${lockDir}. Remove that lock path manually after confirming no PR gate process is running, then rerun the command.`);
      }
      let aged = false;
      try {
        aged = Date.now() - statSync(lockDir).mtimeMs > ROUTE_FAULT_LOCK_STALE_MS;
      } catch {
        continue; // The holder released between attempts; retry immediately.
      }
      if (aged && lockHolderAlive(lockDir) !== true) {
        // Reclaim via atomic rename, then verify the displaced lock is the same
        // stale one that was observed; a fresh lock that raced in is restored so
        // its live holder is never overlapped.
        const tombstone = `${lockDir}.reclaim-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
        try {
          const observedHolder = readFileSync(join(lockDir, 'holder.json'), 'utf8');
          renameSync(lockDir, tombstone);
          const displacedHolder = readFileSync(join(tombstone, 'holder.json'), 'utf8');
          if (displacedHolder !== observedHolder) {
            renameSync(tombstone, lockDir);
            continue;
          }
          rmSync(tombstone, { recursive: true, force: true });
        } catch {
          rmSync(tombstone, { recursive: true, force: true });
        }
        continue;
      }
      const waitUntil = Date.now() + ROUTE_FAULT_LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* bounded spin; ledger writes are rare and small */ }
    }
  }
  try {
    return update();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Reclaimed as stale by another writer.
    }
  }
}


// Evidence, raw-output, bundle, and provenance writes refuse symlinked
// destinations and symlinked ancestors that resolve outside the repository
// root, so a planted link can never redirect a gate write to an arbitrary
// same-user file. The lstat-to-write window is the residual risk on hosts
// without O_NOFOLLOW semantics.
function writeReviewFileGuarded(path: string, content: string, containRoot?: string): void {
  let symlink = false;
  try {
    symlink = lstatSync(path).isSymbolicLink();
  } catch {
    symlink = false; // Missing file: nothing to follow.
  }
  if (symlink) {
    throw new Error(`Refusing to write review evidence through a symlink: ${path}. Remove the symlink, then rerun.`);
  }
  if (containRoot) {
    try {
      const rootReal = realpathSync(containRoot);
      const parentReal = realpathSync(dirname(path));
      if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
        throw new Error(`Refusing to write review evidence outside the repository root: ${path} resolves to ${parentReal}.`);
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Refusing to write')) throw err;
      throw new Error(`Refusing to write review evidence because containment could not be verified for ${path}.`);
    }
  }
  // Write to an unguessable temp name with exclusive create and rename over the
  // destination: rename replaces a symlink entry instead of following it, and
  // the exclusive create fails rather than following anything pre-planted even
  // at the temp name.
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, content, { flag: 'wx' });
    try {
      renameSync(tempPath, path);
    } catch {
      // Windows can refuse to replace a locked destination; clear it and retry.
      rmSync(path, { force: true });
      try {
        renameSync(tempPath, path);
      } catch {
        // Final fallback: the destination entry was just removed, so recreate it
        // with exclusive create (no replacement symlink can be followed) and
        // only then discard the temp copy — content is never silently lost.
        writeFileSync(path, content, { flag: 'wx' });
        rmSync(tempPath, { force: true });
      }
    }
  } catch (err: unknown) {
    rmSync(tempPath, { force: true });
    throw err;
  }
}

export function recordRouteFault(repoRoot: string, issueNumber: number, prNumber: number, lane: LocalReviewLaneId, reasonCode: string, routeKey: string): number {
  const path = routeFaultLedgerPath(repoRoot, issueNumber, prNumber);
  return withRouteFaultLock(path, () => {
    const ledger = readRouteFaults(repoRoot, issueNumber, prNumber);
    // A tally is only meaningful against one primary route identity; a config
    // change to the lane's primary route restarts the count so the changed
    // primary is actually tested before failover engages again.
    const existing = ledger.lanes[lane];
    const count = (existing && existing.routeKey === routeKey ? existing.count : 0) + 1;
    ledger.lanes[lane] = { count, routeKey, lastReasonCode: reasonCode, lastAt: new Date().toISOString() };
    writeReviewFileGuarded(path, `${JSON.stringify(ledger, null, 2)}\n`);
    return count;
  });
}

export function clearRouteFault(repoRoot: string, issueNumber: number, prNumber: number, lane: LocalReviewLaneId): void {
  const path = routeFaultLedgerPath(repoRoot, issueNumber, prNumber);
  withRouteFaultLock(path, () => {
    const ledger = readRouteFaults(repoRoot, issueNumber, prNumber);
    if (!(lane in ledger.lanes)) return;
    delete ledger.lanes[lane];
    writeReviewFileGuarded(path, `${JSON.stringify(ledger, null, 2)}\n`);
  });
}

export interface CarryForwardSource {
  fromHeadSha: string;
  priorRunId: string | null;
  deltaSummary: string;
}

function builtinFragmentDigest(entries: ReadonlyArray<Record<string, unknown>>): string {
  const builtin = entries
    .filter(entry => entry.source === 'builtin' || entry.source === 'repo-configured')
    .map(entry => ({ id: typeof entry.id === 'string' ? entry.id : '', sha256: typeof entry.sha256 === 'string' ? entry.sha256 : '' }));
  return hash(JSON.stringify(builtin));
}

/** Stable identity of activated risk-card command fragments (ordered ids). */
export function riskCardCommandIdentity(fragments: readonly string[]): string {
  const ids = fragments.map(text => {
    const sha256 = createHash('sha256').update(text).digest('hex');
    return `command-supplied:${sha256.slice(0, 12)}`;
  });
  return hash(JSON.stringify(ids));
}

export function priorRiskCardCommandIdentity(promptStackEntries: unknown): string {
  if (!Array.isArray(promptStackEntries)) return hash(JSON.stringify([]));
  const ids = promptStackEntries
    .filter(isRecord)
    .map(entry => typeof entry.id === 'string' ? entry.id : '')
    .filter(id => id.startsWith('command-supplied:'));
  return hash(JSON.stringify(ids));
}

export function expectedLaneFragmentDigest(lane: LocalReviewLaneId): string {
  return builtinFragmentDigest(promptStack(lane).promptStack.map(fragment => ({ id: fragment.id, source: fragment.source, sha256: fragment.sha256 })));
}

async function gitDeltaPaths(repoRoot: string, fromHeadSha: string, toHeadSha: string): Promise<string[] | null> {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, 'diff', '--name-only', `${fromHeadSha}..${toHeadSha}`], { maxBuffer: 16 * 1024 * 1024 });
    return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '');
  } catch {
    return null;
  }
}

export async function findCarryForwardSource(input: {
  repoRoot: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  lane: LocalReviewLaneId;
  matchPatterns: readonly string[];
  contextPatterns: readonly string[];
  contextMode?: CarryForwardContextMode;
  expectedFragmentDigest: string;
  expectedCommandSuppliedIdentity?: string;
  expectedAdapter: 'local-host' | 'local-command';
  requiredCommand: string | null;
}): Promise<CarryForwardSource | null> {
  const expectedCommandIdentity = input.expectedCommandSuppliedIdentity ?? riskCardCommandIdentity([]);
  const prDirectory = join(input.repoRoot, '.qube', 'aie', 'reviews', String(input.issueNumber), String(input.prNumber));
  let headDirectories: string[];
  try {
    headDirectories = readdirSync(prDirectory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== safeSegment(input.headSha))
      .map(entry => entry.name);
  } catch {
    return null;
  }
  const candidates: Array<{ fromHeadSha: string; priorRunId: string | null; recordedAt: string }> = [];
  for (const directoryName of headDirectories) {
    const path = join(prDirectory, directoryName, `${input.lane}.json`);
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isRecord(parsed)) continue;
      if ((parsed.version ?? parsed.schemaVersion) !== 1) continue;
      if ((parsed.lane ?? parsed.id) !== input.lane) continue;
      if (parsed.status !== 'passed' || parsed.recommendation !== 'approve') continue;
      if (isRecord(parsed.carriedForward)) continue;
      if (parsed.adapter !== input.expectedAdapter) continue;
      if (input.requiredCommand !== null && !(Array.isArray(parsed.commands) && parsed.commands.includes(input.requiredCommand))) continue;
      const priorHeadSha = typeof parsed.headSha === 'string' ? parsed.headSha.trim() : '';
      if (priorHeadSha === '' || priorHeadSha === input.headSha) continue;
      if (!isRecord(parsed.runnerProvenance)) continue;
      if (!Array.isArray(parsed.promptStack) || builtinFragmentDigest(parsed.promptStack.filter(isRecord)) !== input.expectedFragmentDigest) continue;
      if (priorRiskCardCommandIdentity(parsed.promptStack) !== expectedCommandIdentity) continue;
      const provenance = parsed.runnerProvenance;
      const priorRunId = [provenance.taskId, provenance.sessionId, provenance.threadId].find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? null;
      candidates.push({ fromHeadSha: priorHeadSha, priorRunId, recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : '' });
    } catch {
      continue;
    }
  }
  candidates.sort((first, second) => second.recordedAt.localeCompare(first.recordedAt));
  for (const candidate of candidates.slice(0, 5)) {
    const deltaPaths = await gitDeltaPaths(input.repoRoot, candidate.fromHeadSha, input.headSha);
    if (deltaPaths === null) continue;
    if (carryForwardDeltaTouched(deltaPaths, input.matchPatterns, input.contextPatterns, input.contextMode ?? defaultCarryForwardContext(input.lane))) continue;
    const deltaSummary = deltaPaths.length === 0
      ? `no files changed between ${candidate.fromHeadSha} and ${input.headSha}`
      : `${deltaPaths.length} changed file(s) between ${candidate.fromHeadSha} and ${input.headSha} did not touch this lane's scope`;
    return { fromHeadSha: candidate.fromHeadSha, priorRunId: candidate.priorRunId, deltaSummary };
  }
  return null;
}

export function writeCarriedForwardLane(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, source: CarryForwardSource): string | null {
  const priorPath = laneEvidencePath(repoRoot, issueNumber, prNumber, source.fromHeadSha, lane);
  try {
    const prior: unknown = JSON.parse(readFileSync(priorPath, 'utf8'));
    if (!isRecord(prior)) return null;
    const carriedNote = `Carried forward: ${source.deltaSummary}.`;
    const body = {
      ...prior,
      headSha,
      summary: `Carried forward from approved ${lane} review at ${source.fromHeadSha}. ${typeof prior.summary === 'string' ? prior.summary : ''}`.trim(),
      completeness: `${typeof prior.completeness === 'string' ? prior.completeness : ''} ${carriedNote}`.trim(),
      preconditions: [...(Array.isArray(prior.preconditions) ? prior.preconditions.filter((item): item is string => typeof item === 'string') : []), carriedNote],
      carriedForward: { fromHeadSha: source.fromHeadSha, priorRunId: source.priorRunId, deltaSummary: source.deltaSummary },
      recordedAt: new Date().toISOString(),
    };
    const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane);
    mkdirSync(dirname(path), { recursive: true });
    writeReviewFileGuarded(path, `${JSON.stringify(body, null, 2)}\n`, repoRoot);
    return path;
  } catch {
    return null;
  }
}

export function reviewSessionLockPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), '.review-lock.json');
}

export const REVIEW_SESSION_LOCK_MAX_AGE_MINUTES = 60;

export interface ReviewSessionLockReport {
  path: string;
  issueNumber: number | null;
  prNumber: number | null;
  headSha: string | null;
  createdAt: string | null;
  ageMinutes: number | null;
  stale: boolean;
  reason: string;
  cleanupCommand: string;
}

function readLockRecord(lockPath: string, expected?: { issueNumber: number; prNumber: number; headSha: string }): { createdAt: string | null; pid: number | null; malformed: boolean } {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { createdAt: null, pid: null, malformed: true };
    const createdAt = typeof parsed.createdAt === 'string' && !Number.isNaN(Date.parse(parsed.createdAt)) ? parsed.createdAt : null;
    const pid = Number.isSafeInteger(parsed.pid) ? Number(parsed.pid) : null;
    // The record must identify itself as version 1 for the coordinates its path claims;
    // a partial or cross-target record is malformed, never an active lock.
    const identityValid = parsed.version === 1
      && (expected === undefined || (parsed.issueNumber === expected.issueNumber && parsed.prNumber === expected.prNumber && parsed.headSha === expected.headSha));
    return { createdAt, pid, malformed: createdAt === null || !identityValid };
  } catch {
    return { createdAt: null, pid: null, malformed: true };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return err instanceof Error && 'code' in err && (err as { code?: unknown }).code === 'EPERM';
  }
}

// Exclusive-create acquisition: two racing gates resolve to exactly one holder;
// the loser observes the winner's fresh lock and skips lane execution.
export function acquireReviewSessionLock(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): { held: boolean; activeLock: ReviewSessionLockReport | null } {
  const path = reviewSessionLockPath(repoRoot, issueNumber, prNumber, headSha);
  mkdirSync(dirname(path), { recursive: true });
  const record = `${JSON.stringify({ version: 1, issueNumber, prNumber, headSha, pid: process.pid, createdAt: new Date().toISOString() }, null, 2)}\n`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(path, record, { flag: 'wx' });
      return { held: true, activeLock: null };
    } catch {
      const locks = findReviewSessionLocks(repoRoot, { prNumber, currentHeadSha: headSha });
      const active = locks.find(lock => !lock.stale);
      if (active) return { held: false, activeLock: active };
      // Every observed lock is stale. Displace it via atomic rename and verify
      // the displaced content is the stale record that was observed; a fresh
      // lock that raced in is restored so its holder keeps exclusivity.
      try {
        const observed = readFileSync(path, 'utf8');
        const tombstone = `${path}.${randomUUID()}.reclaim`;
        renameSync(path, tombstone);
        const displaced = readFileSync(tombstone, 'utf8');
        if (displaced !== observed) {
          renameSync(tombstone, path);
        } else {
          rmSync(tombstone, { force: true });
        }
      } catch {
        // The lock disappeared between attempts; retry the exclusive create.
      }
    }
  }
  return { held: false, activeLock: null };
}

export function clearReviewSessionLock(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): void {
  const path = reviewSessionLockPath(repoRoot, issueNumber, prNumber, headSha);
  // Release only a lock this process owns; a reclaimed-and-replaced lock belongs to its new holder.
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && parsed.pid !== process.pid) return;
  } catch {
    // Missing or unreadable lock: removal is a no-op or clears debris.
  }
  rmSync(path, { force: true });
}

function unreadableLockReport(relativePath: string, message: string): ReviewSessionLockReport {
  // An unreadable evidence directory must fail closed: lock state is unknown, so it counts as stale.
  return {
    path: relativePath,
    issueNumber: null,
    prNumber: null,
    headSha: null,
    createdAt: null,
    ageMinutes: null,
    stale: true,
    reason: `The review evidence directory could not be read (${message}); review lock state is unknown and counts as blocked.`,
    cleanupCommand: `Fix filesystem access to ${relativePath}, then rerun the blocked command.`,
  };
}

export function findReviewSessionLocks(repoRoot: string, options: { prNumber?: number; currentHeadSha?: string; now?: number; maxAgeMinutes?: number } = {}): ReviewSessionLockReport[] {
  const evidenceRoot = join(repoRoot, '.qube', 'aie', 'reviews');
  if (!existsSync(evidenceRoot)) return [];
  const now = options.now ?? Date.now();
  const maxAgeMinutes = options.maxAgeMinutes ?? REVIEW_SESSION_LOCK_MAX_AGE_MINUTES;
  const reports: ReviewSessionLockReport[] = [];
  let issueDirs: string[];
  try {
    issueDirs = readdirSync(evidenceRoot).filter(name => /^\d+$/.test(name));
  } catch (err: unknown) {
    return [unreadableLockReport('.qube/aie/reviews', err instanceof Error ? err.message : String(err))];
  }
  for (const issueDir of issueDirs) {
    let prDirs: string[];
    try {
      prDirs = readdirSync(join(evidenceRoot, issueDir)).filter(name => /^\d+$/.test(name));
    } catch (err: unknown) {
      reports.push(unreadableLockReport(`.qube/aie/reviews/${issueDir}`, err instanceof Error ? err.message : String(err)));
      continue;
    }
    for (const prDir of prDirs) {
      if (options.prNumber !== undefined && Number(prDir) !== options.prNumber) continue;
      let headDirs: string[];
      try {
        headDirs = readdirSync(join(evidenceRoot, issueDir, prDir));
      } catch (err: unknown) {
        reports.push(unreadableLockReport(`.qube/aie/reviews/${issueDir}/${prDir}`, err instanceof Error ? err.message : String(err)));
        continue;
      }
      for (const headDir of headDirs) {
        const lockPath = join(evidenceRoot, issueDir, prDir, headDir, '.review-lock.json');
        if (!existsSync(lockPath)) continue;
        const relativePath = ['.qube', 'aie', 'reviews', issueDir, prDir, headDir, '.review-lock.json'].join('/');
        const record = readLockRecord(lockPath, { issueNumber: Number(issueDir), prNumber: Number(prDir), headSha: headDir });
        const ageMinutes = record.createdAt === null ? null : Math.max(0, Math.round((now - Date.parse(record.createdAt)) / 60_000));
        const headMismatch = options.currentHeadSha !== undefined && headDir !== options.currentHeadSha;
        const holderDead = record.pid !== null && !processAlive(record.pid);
        // A recorded live holder beats the age threshold: a long-running gate stays exclusive.
        const ageStale = record.pid === null && ageMinutes !== null && ageMinutes > maxAgeMinutes;
        const stale = record.malformed || headMismatch || holderDead || ageStale;
        const reason = record.malformed
          ? 'The lock record is malformed or missing createdAt; an unreadable lock counts as stale.'
          : headMismatch
            ? `The lock belongs to head ${headDir}, not the current PR head.`
            : holderDead
              ? `The lock holder process ${record.pid} is no longer running.`
              : ageStale
                ? `The lock is ${ageMinutes} minute(s) old, above the ${maxAgeMinutes}-minute staleness threshold, and records no holder process.`
                : `An active review session holds this lock (${ageMinutes} minute(s) old).`;
        reports.push({
          path: relativePath,
          issueNumber: Number(issueDir),
          prNumber: Number(prDir),
          headSha: headDir,
          createdAt: record.createdAt,
          ageMinutes,
          stale,
          reason,
          cleanupCommand: `Delete ${relativePath} after confirming no review subagents are still running, then rerun the blocked command.`,
        });
      }
    }
  }
  return reports;
}

export function reviewSessionLockLines(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, evidencePaths: readonly string[]): string[] {
  const lockPath = reviewSessionLockPath(repoRoot, issueNumber, prNumber, headSha);
  return [
    `Review session lock: ${lockPath}.`,
    'The main agent creates this lock before spawning review subagents and must delete it after publishing provider-visible feedback.',
    'While the lock exists, review subagents must not edit source, tests, docs, config, package metadata, PR body, or issue content.',
    'Do not run git restore, git checkout, git reset, or other commands that revert another agent\'s in-progress work in the shared checkout.',
    `Subagents may write only these lane evidence paths plus matching host-provenance JSON: ${evidencePaths.join(', ')}.`,
    'Provider-visible pull request reviews and comments are the human audit trail; local JSON under .qube/aie/reviews/ is optional audit evidence.',
  ];
}

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hostProvenancePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'host-provenance', String(issueNumber), String(prNumber), safeSegment(headSha), `${lane}.json`);
}

export function laneContextLines(lane: LocalReviewLaneId, issueNumbers: readonly number[], prNumber: number, headSha: string, evidencePaths: readonly string[], extraContext: readonly string[], repoRoot: string, publishCommand?: string): string[] {
  const primaryIssue = issueNumbers[0] ?? 0;
  const primaryEvidencePath = evidencePaths[0] ?? '';
  const lanePublishCommand = publishCommand?.trim() || 'qube aie pr review publish <pr> --lane <lane> --issue <issue>';
  return [
    `Run local review lane ${lane}.`,
    `Issue: #${primaryIssue}.`,
    `Linked issues for this PR-level lane: ${issueNumbers.map(issueNumber => `#${issueNumber}`).join(', ')}.`,
    `Pull request: #${prNumber}.`,
    `PR head SHA: ${headSha}.`,
    `Record the resulting local-host evidence JSON at this exact issue evidence path: ${primaryEvidencePath}.`,
    `The evidence JSON must include issueNumber ${primaryIssue}, prNumber ${prNumber}, headSha ${headSha}, lane ${lane}, profile, adapter local-host, status, severity, recommendation, summary, blockers, findings, artifacts, commands, surfaces, contextReviewed, promptStack, toolsUsed, completeness, preconditions, runnerProvenance, and recordedAt.`,
    LANE_ARTIFACT_REQUIREMENT,
    'When you identify code defects, include structured findings[] entries with severity blocking or advisory, message, and location.path plus location.line when the finding can be anchored to the PR diff.',
    'Report the complete finding set for this lane at this head in one pass: every blocking finding first, then advisory findings, ranked by severity and confidence. Do not stop after the first blocker; the implementer fixes everything you report before the next round.',
    'The completeness field must be a non-empty self-check stating what you inspected and what you did not have capacity to inspect for this lane at this head; publishing fails without it.',
    'Your verdict is scoped to this lane. Record observed gate-level facts (CI or check state, issue checklist completion, checkout/head freshness, uncommitted changes, other lanes) as preconditions entries; do not turn them into lane blockers or let them change the lane recommendation. The PR gate and the final-gate lane translate gate-level conditions into merge blockers.',
    'Include runnerProvenance with runnerKind local-host, host codex, freshContext true, promptOnly false, the current PR head SHA, promptStackHash, and the subagent task/session/thread id when the host exposes one.',
    `Bind local-host evidence to same-user host provenance at this exact path: ${hostProvenancePath(repoRoot, primaryIssue, prNumber, headSha, lane)}.`,
    ...reviewSessionLockLines(repoRoot, primaryIssue, prNumber, headSha, evidencePaths),
    'The host provenance JSON must include version 1, issueNumber, prNumber, headSha, lane, evidenceSha256, runnerKind local-host, host, freshContext, promptOnly, taskId, sessionId, threadId, promptStackHash, and recordedAt. evidenceSha256 is the canonical SHA-256 digest of the evidence JSON object using QUBE localReviewEvidenceSha256 semantics: object keys sorted recursively, arrays ordered as written, JSON string escaping, and no trailing newline.',
    'This is audit evidence for a separate host task/session/thread, not a cryptographic attestation against same-user repo code.',
    'Writing the requested evidence and host-provenance files is allowed; do not edit source, tests, docs, config, package metadata, PR body, or issue content from inside the reviewer lane.',
    `Return evidence for this lane only; publish provider-visible lane review with \`${lanePublishCommand}\` after writing lane evidence.`,
    'Return evidence for this lane only; the main agent waits for all lane reviews on the pull request before addressing feedback.',
    ...extraContext,
  ];
}

export function promptStack(
  lane: LocalReviewLaneId,
  contextLines: readonly string[] = [`Run local review lane ${lane}.`],
  riskCardFragments: readonly string[] = [],
) {
  return renderAgentPrompt({
    hostId: 'codex',
    descriptorId: 'qa-reviewer',
    categoryId: 'review',
    laneIds: [lane],
    contextLines,
    commandFragments: riskCardFragments,
    outputContract: 'Return JSON local review lane evidence for the requested lane, including runnerProvenance for the fresh independent reviewer context. Enumerate the complete finding set for the lane scope at the current PR head in one pass: all blocking findings first, then advisory findings, ranked by severity and confidence. Do not stop after the first blocker; the implementer fixes everything you report before the next round. Include a completeness self-check that states what you inspected and what you did not have capacity to inspect.',
  });
}

export interface LocalReviewSpawnContract {
  agentType: string;
  forkContext: false;
  modelTier: 'review' | 'economy';
  model: string | null;
  effort: string | null;
  tierSubstitution: string | null;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  promptStackHash: string;
  taskPrompt: string;
  publishCommand: string;
}

export interface ReviewModelTierResolution {
  model: string | null;
  effort: string | null;
  substitution: string | null;
}

export function resolveReviewModelTier(models: ReviewModelsPolicy, tier: ReviewModelTierId, host: ReviewModelHostId): ReviewModelTierResolution {
  const configured = models[tier][host];
  if (configured) return { model: configured.model, effort: configured.effort, substitution: null };
  if (tier !== 'review') {
    const reviewBinding = models.review[host];
    if (reviewBinding) return { model: reviewBinding.model, effort: reviewBinding.effort, substitution: `The ${tier} tier is not configured for ${host}; the review tier model was substituted.` };
  }
  return { model: null, effort: null, substitution: `The ${tier} tier is not configured for ${host}; the host default model applies.` };
}

export function buildLocalReviewPublishCommand(cliPrefix: string, prNumber: number, lane: LocalReviewLaneId, issueNumber: number): string {
  const prefix = cliPrefix.trim() || 'qube aie';
  return `${prefix} pr review publish ${prNumber} --lane ${lane} --issue ${issueNumber}`;
}

export function buildLocalReviewSpawnPrompt(input: {
  hostAgentType: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  promptStackHash: string;
  promptText: string;
  publishCommand: string;
}): string {
  const promptText = input.promptText.trim();
  return [
    `You are the QUBE ${input.hostAgentType} subagent for review lane "${input.lane}".`,
    `Issue #${input.issueNumber}, PR #${input.prNumber}, head ${input.headSha}.`,
    `Prompt stack hash for runnerProvenance.promptStackHash: ${input.promptStackHash}.`,
    'Read-only focused PR review: inspect only what this lane requires; do not edit source, tests, docs, config, package metadata, PR body, or issue content.',
    'The complete lane instructions are inline below. Do not read external prompt files and do not follow paths under .qube/aie/reviews/.../prompts/.',
    '',
    '--- LANE PROMPT START ---',
    promptText,
    '--- LANE PROMPT END ---',
    '',
    `When complete, publish provider-visible feedback with: ${input.publishCommand}`,
    'Report recommendation, blockers, evidence path, runner provenance path, and provider review URL if published.',
  ].join('\n');
}

export function buildLocalReviewSpawnContract(input: {
  hostAgentType: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  promptStackHash: string;
  promptText: string;
  publishCommand: string;
  modelTier?: 'review' | 'economy';
  tierResolution?: ReviewModelTierResolution;
}): LocalReviewSpawnContract {
  return {
    agentType: input.hostAgentType,
    forkContext: false,
    modelTier: input.modelTier ?? 'review',
    model: input.tierResolution?.model ?? null,
    effort: input.tierResolution?.effort ?? null,
    tierSubstitution: input.tierResolution?.substitution ?? null,
    lane: input.lane,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha,
    promptStackHash: input.promptStackHash,
    taskPrompt: buildLocalReviewSpawnPrompt(input),
    publishCommand: input.publishCommand,
  };
}

function promptStackEvidence(lane: LocalReviewLaneId): LaneEvidence['promptStack'] {
  return promptStack(lane).promptStack.map(fragment => ({
    id: fragment.id,
    source: fragment.source,
    sourceCategory: fragment.sourceCategory,
    path: fragment.path,
    sha256: fragment.sha256,
    trust: fragment.trust,
  }));
}

function defaultContext(issueNumber: number, prNumber: number): LocalReviewContextReviewed[] {
  return [
    { kind: 'issue-body', source: `issue:${issueNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'pr-body', source: `pr:${prNumber}`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'diff', source: `pr:${prNumber}:diff`, trust: 'untrusted-task-input', freshness: 'current' },
    { kind: 'ci', source: `pr:${prNumber}:checks`, trust: 'trusted-provider', freshness: 'current' },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => redact(item.trim()))
    : [];
}

function readFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const findings: ReviewFinding[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.message !== 'string' || item.message.trim() === '') continue;
    const location = isRecord(item.location) && typeof item.location.path === 'string' && item.location.path.trim() !== ''
      ? {
          path: redact(item.location.path.trim()),
          ...(typeof item.location.line === 'number' && Number.isSafeInteger(item.location.line) && item.location.line > 0 ? { line: item.location.line } : {}),
          ...(typeof item.location.endLine === 'number' && Number.isSafeInteger(item.location.endLine) && item.location.endLine > 0 ? { endLine: item.location.endLine } : {}),
          ...(item.location.side === 'source'
            ? { side: 'source' as const }
            : item.location.side === 'destination'
              ? { side: 'destination' as const }
              : {}),
        }
      : undefined;
    findings.push({
      id: typeof item.id === 'string' && item.id.trim() !== '' ? redact(item.id.trim()) : `finding-${findings.length + 1}`,
      severity: item.severity === 'blocking' ? 'blocking' : 'advisory',
      ...(location ? { location } : {}),
      message: redact(item.message.trim()),
      ...(typeof item.suggestion === 'string' && item.suggestion.trim() !== '' ? { suggestion: redact(item.suggestion.trim()) } : {}),
    });
  }
  return findings;
}

function readArtifacts(value: unknown): LaneEvidence['artifacts'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(item => ({
    kind: typeof item.kind === 'string' ? redact(item.kind) : 'json',
    path: typeof item.path === 'string' ? redact(item.path) : '',
    sha256: typeof item.sha256 === 'string' && item.sha256 !== '' ? item.sha256 : null,
  }));
}

function readLaneId(value: unknown): LocalReviewLaneId | null {
  return COMPREHENSIVE_LOCAL_REVIEW_LANES.includes(value as LocalReviewLaneId) ? value as LocalReviewLaneId : null;
}

function readStatus(value: unknown): LocalReviewStatus {
  return value === 'passed' || value === 'failed' || value === 'needs-work' || value === 'pending' || value === 'missing' || value === 'stale' || value === 'unavailable' || value === 'malformed' || value === 'inconclusive' ? value : 'malformed';
}

function readSeverity(value: unknown): LocalReviewSeverity {
  return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical' ? value : 'none';
}

function readRecommendation(value: unknown, status: LocalReviewStatus): LocalReviewRecommendation {
  if (value === 'approve' || value === 'request-changes' || value === 'pending' || value === 'inconclusive') return value;
  if (status === 'passed') return 'approve';
  if (status === 'failed' || status === 'needs-work') return 'request-changes';
  if (status === 'pending') return 'pending';
  return 'inconclusive';
}

export function normalizeExternalLane(value: unknown, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string): LaneEvidence | null {
  if (!isRecord(value)) return null;
  const id = readLaneId(value.lane ?? value.id);
  if (id !== lane) return null;
  if (value.issueNumber !== issueNumber || value.prNumber !== prNumber || value.headSha !== headSha) return null;
  if (!isRecord(value.runnerProvenance)) return null;
  const status = readStatus(value.status);
  return {
    id,
    status,
    severity: readSeverity(value.severity),
    recommendation: readRecommendation(value.recommendation, status),
    summary: typeof value.summary === 'string' && value.summary.trim() !== '' ? redact(value.summary.trim()) : `${id} local review completed.`,
    blockers: readStringArray(value.blockers),
    findings: readFindings(value.findings),
    artifacts: readArtifacts(value.artifacts),
    commands: readStringArray(value.commands),
    surfaces: readStringArray(value.surfaces),
    // Enum-validate context entries and drop incomplete ones: a missing field is
    // never defaulted into a success-shaped value like freshness 'current'.
    contextReviewed: Array.isArray(value.contextReviewed) ? value.contextReviewed.filter(isRecord).flatMap(item => {
      const kinds: readonly string[] = ['agents', 'issue-body', 'issue-comment', 'milestone', 'functional-requirement', 'linked-issue', 'pr-body', 'pr-comment', 'review-thread', 'doc', 'diff', 'ci', 'manual-qa'];
      const trusts: readonly string[] = ['policy', 'trusted-provider', 'repo-doc', 'untrusted-task-input', 'local-evidence'];
      const freshnessValues: readonly string[] = ['current', 'stale', 'unknown', 'missing', 'unavailable', 'not-configured'];
      if (typeof item.kind !== 'string' || !kinds.includes(item.kind)) return [];
      if (typeof item.source !== 'string' || item.source.trim() === '') return [];
      if (typeof item.trust !== 'string' || !trusts.includes(item.trust)) return [];
      if (typeof item.freshness !== 'string' || !freshnessValues.includes(item.freshness)) return [];
      return [{
        kind: item.kind as LocalReviewContextReviewed['kind'],
        source: redact(item.source),
        trust: item.trust as LocalReviewContextReviewed['trust'],
        freshness: item.freshness as LocalReviewContextReviewed['freshness'],
      }];
    }) : [],
    promptStack: Array.isArray(value.promptStack) ? value.promptStack.filter(isRecord).map(item => ({
      id: typeof item.id === 'string' ? item.id : 'unknown-prompt-fragment',
      source: typeof item.source === 'string' ? item.source : 'evidence',
      sourceCategory: typeof item.sourceCategory === 'string' ? item.sourceCategory : undefined,
      path: typeof item.path === 'string' ? item.path : null,
      sha256: typeof item.sha256 === 'string' ? item.sha256 : null,
      trust: typeof item.trust === 'string' ? item.trust : 'local-evidence',
    })) : [],
    toolsUsed: readStringArray(value.toolsUsed),
    completeness: typeof value.completeness === 'string' ? redact(value.completeness.trim()) : '',
    preconditions: readStringArray(value.preconditions),
    runnerProvenance: {
      runnerKind: value.runnerProvenance.runnerKind === 'local-command' || value.runnerProvenance.runnerKind === 'local-host' || value.runnerProvenance.runnerKind === 'manual-evidence' || value.runnerProvenance.runnerKind === 'prompt-only' ? value.runnerProvenance.runnerKind : 'manual-evidence',
      host: typeof value.runnerProvenance.host === 'string' ? value.runnerProvenance.host : 'unknown-host',
      freshContext: value.runnerProvenance.freshContext === true,
      promptOnly: value.runnerProvenance.promptOnly === true,
      taskId: typeof value.runnerProvenance.taskId === 'string' ? value.runnerProvenance.taskId : null,
      sessionId: typeof value.runnerProvenance.sessionId === 'string' ? value.runnerProvenance.sessionId : null,
      threadId: typeof value.runnerProvenance.threadId === 'string' ? value.runnerProvenance.threadId : null,
      promptStackHash: typeof value.runnerProvenance.promptStackHash === 'string' ? value.runnerProvenance.promptStackHash : null,
      headSha: typeof value.runnerProvenance.headSha === 'string' ? value.runnerProvenance.headSha : headSha,
      providerPublishStatus: typeof value.runnerProvenance.providerPublishStatus === 'string' ? value.runnerProvenance.providerPublishStatus : null,
      model: typeof value.runnerProvenance.model === 'string' ? value.runnerProvenance.model : null,
      effort: typeof value.runnerProvenance.effort === 'string' ? value.runnerProvenance.effort : null,
      isolation: value.runnerProvenance.isolation === 'read-only' ? 'read-only' : null,
      invocationId: typeof value.runnerProvenance.invocationId === 'string' ? value.runnerProvenance.invocationId : null,
      routeSource: value.runnerProvenance.routeSource === 'configured' || value.runnerProvenance.routeSource === 'fallback' ? value.runnerProvenance.routeSource : null,
    },
  };
}

function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  for (const match of command.matchAll(pattern)) parts.push(match[1] ?? match[2] ?? match[0]);
  return parts;
}

async function defaultExec(args: string[], cwd?: string): Promise<PrGateExecResult> {
  const [file, ...rest] = args;
  try {
    const result = await execFileAsync(file, rest, {
      cwd,
      encoding: 'utf8',
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { args, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { args, exitCode: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? 'local command failed' };
  }
}

async function gitQuiet(repoRoot: string, args: readonly string[]): Promise<boolean> {
  try {
    await execFileAsync('git', [...args], { cwd: repoRoot, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

export async function executableReviewCommandsTrusted(repoRoot: string, baseRef: string): Promise<boolean> {
  if (!await gitQuiet(repoRoot, ['rev-parse', '--is-inside-work-tree'])) return false;
  if (!existsSync(join(repoRoot, '.qube', 'aie', 'config.json'))) return false;
  if (!await gitQuiet(repoRoot, ['rev-parse', '--verify', baseRef])) return false;
  if (!await gitQuiet(repoRoot, ['diff', '--quiet', '--', '.qube/aie/config.json'])) return false;
  if (!await gitQuiet(repoRoot, ['diff', '--quiet', '--cached', '--', '.qube/aie/config.json'])) return false;
  return gitQuiet(repoRoot, ['diff', '--quiet', `${baseRef}...HEAD`, '--', '.qube/aie/config.json']);
}

function reviewBundlePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(repoRoot, '.git', 'qube', 'aie', 'review-inputs', String(issueNumber), String(prNumber), safeSegment(headSha), `${lane}.json`);
}

function rawOutputPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.raw-output.json`);
}

function writeReviewBundle(input: {
  repoRoot: string;
  issueNumber: number;
  prNumber: number;
  headSha: string;
  lane: LocalReviewLaneId;
  profile: LocalReviewProfile;
  runnerKind: 'local-command' | 'local-host';
  promptText: string;
  outputContract: string;
  promptFragmentIds: readonly string[];
  promptStackHash: string;
  evidencePath: string;
}): string {
  const path = reviewBundlePath(input.repoRoot, input.issueNumber, input.prNumber, input.headSha, input.lane);
  mkdirSync(dirname(path), { recursive: true });
  writeReviewFileGuarded(path, `${JSON.stringify({
    version: 1,
    issueNumber: input.issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha,
    lane: input.lane,
    profile: input.profile,
    runnerKind: input.runnerKind,
    promptStackHash: input.promptStackHash,
    promptFragmentIds: input.promptFragmentIds,
    evidencePath: input.evidencePath,
    promptText: input.promptText,
    outputContract: input.outputContract,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, input.repoRoot);
  return path;
}

export async function runExternalLane(command: string, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, runnerKind: 'local-command' | 'local-host', expectedPromptStackHash: string, repoRoot: string, evidencePath: string, contextLines: readonly string[], publishCommand: string, exec?: PrGateExec, riskCardFragments: readonly string[] = []): Promise<LaneEvidence | null> {
  const rendered = promptStack(lane, laneContextLines(lane, [issueNumber], prNumber, headSha, [evidencePath], contextLines, repoRoot, publishCommand), riskCardFragments);
  const bundlePath = writeReviewBundle({
    repoRoot,
    issueNumber,
    prNumber,
    headSha,
    lane,
    profile,
    runnerKind,
    promptText: rendered.text,
    outputContract: rendered.outputContract,
    promptFragmentIds: rendered.orderedFragmentIds,
    promptStackHash: expectedPromptStackHash,
    evidencePath,
  });
  const args = [...splitCommand(command), '--lane', lane, '--issue', String(issueNumber), '--pr', String(prNumber), '--head', headSha, '--profile', profile, '--runner-kind', runnerKind, '--prompt-stack-hash', expectedPromptStackHash, '--review-bundle', bundlePath];
  const result = await (exec ?? defaultExec)(args, repoRoot);
  const rawBody = {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    lane,
    runnerKind,
    args: args.map(redact),
    exitCode: result.exitCode,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    recordedAt: new Date().toISOString(),
  };
  const rawBodyText = `${JSON.stringify(rawBody, null, 2)}\n`;
  const rawPath = rawOutputPath(repoRoot, issueNumber, prNumber, headSha, lane);
  mkdirSync(dirname(rawPath), { recursive: true });
  writeReviewFileGuarded(rawPath, rawBodyText, repoRoot);
  if (result.exitCode !== 0) return null;
  try {
    const evidence = normalizeExternalLane(JSON.parse(result.stdout), lane, issueNumber, prNumber, headSha);
    if (!evidence) return null;
    const rawRelativePath = relative(repoRoot, rawPath).replace(/\\/g, '/');
    return {
      ...evidence,
      artifacts: [
        ...evidence.artifacts,
        { kind: 'json', path: rawRelativePath, sha256: hash(rawBodyText) },
      ],
    };
  } catch {
    return null;
  }
}

export function writeLane(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, lane: LaneEvidence, adapter: 'local-command' | 'local-host'): string {
  const directory = laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha);
  mkdirSync(directory, { recursive: true });
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane.id);
  const reviewerId = adapter === 'local-host' ? lane.runnerProvenance?.host ?? 'codex' : 'local-command';
  const reviewerName = reviewerId === 'codex' ? 'Codex' : reviewerId === 'grok' ? 'Grok' : reviewerId;
  const body = {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    profile,
    adapter,
    reviewer: { id: reviewerId, name: reviewerName, adapterKind: 'local' },
    lane: lane.id,
    ...lane,
    runnerProvenance: lane.runnerProvenance,
    recordedAt: new Date().toISOString(),
  };
  writeReviewFileGuarded(path, `${JSON.stringify(body, null, 2)}\n`, repoRoot);
  return path;
}

export function writeTrustedRoutedProvenance(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LaneEvidence): string | null {
  const provenance = lane.runnerProvenance;
  if (!provenance || provenance.runnerKind !== 'local-host' || provenance.freshContext !== true || provenance.promptOnly === true) return null;
  const evidencePath = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane.id);
  const evidence: unknown = JSON.parse(readFileSync(evidencePath, 'utf8'));
  if (!isRecord(evidence)) return null;
  const path = trustedLocalHostProvenancePath(repoRoot, issueNumber, prNumber, headSha, lane.id);
  mkdirSync(dirname(path), { recursive: true });
  writeReviewFileGuarded(path, `${JSON.stringify({
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    lane: lane.id,
    evidenceSha256: localReviewEvidenceSha256(evidence),
    runnerKind: 'local-host',
    host: provenance.host,
    freshContext: provenance.freshContext,
    promptOnly: provenance.promptOnly,
    taskId: provenance.taskId,
    sessionId: provenance.sessionId,
    threadId: provenance.threadId,
    promptStackHash: provenance.promptStackHash,
    model: provenance.model,
    effort: provenance.effort,
    isolation: provenance.isolation,
    invocationId: provenance.invocationId,
    routeSource: provenance.routeSource,
    recordedAt: new Date().toISOString(),
  }, null, 2)}\n`, repoRoot);
  return path;
}

export function blockedLane(lane: LocalReviewLaneId, status: LocalReviewStatus, summary: string, blocker: string, command: string | null, issueNumber: number, prNumber: number, _repoRoot: string, _headSha: string, runner: 'local-command' | 'local-host'): LaneEvidence {
  return {
    id: lane,
    status,
    severity: status === 'failed' || status === 'malformed' ? 'high' : 'none',
    recommendation: status === 'pending' || status === 'missing' || status === 'stale' ? 'pending' : 'request-changes',
    summary,
    blockers: [blocker],
    findings: [],
    artifacts: [],
    commands: command ? [command] : [],
    surfaces: ['PR'],
    contextReviewed: defaultContext(issueNumber, prNumber),
    promptStack: promptStackEvidence(lane),
    toolsUsed: runner === 'local-host' ? ['codex', 'local-host'] : ['local-command'],
    completeness: '',
    preconditions: [],
    runnerProvenance: null,
  };
}
