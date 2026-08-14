import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

export type ReviewScopeKind = 'full' | 'delta';
export type ReviewScopeReason = 'first-run' | 'delta-since-approved-head' | 'forced-full' | 'cadence-full';

export interface PriorLaneFinding {
  readonly summary: string;
  readonly severity?: string;
}

export interface ReviewScopeSelection {
  readonly scope: ReviewScopeKind;
  readonly reason: ReviewScopeReason;
  readonly baseHeadSha: string | null;
  readonly deltaPaths: readonly string[];
  readonly priorFindings: readonly PriorLaneFinding[];
}

export function selectReviewScope(input: {
  readonly forceFull?: boolean;
  readonly deltaFullEvery?: number;
  readonly priorDeltaRoundCount?: number;
  readonly priorApprovedHeadSha?: string | null;
  readonly priorFindings?: readonly PriorLaneFinding[];
  readonly deltaPaths?: readonly string[] | null;
}): ReviewScopeSelection {
  const cadence = input.deltaFullEvery ?? 3;
  if (input.forceFull === true) {
    return { scope: 'full', reason: 'forced-full', baseHeadSha: null, deltaPaths: [], priorFindings: [] };
  }
  if ((input.priorDeltaRoundCount ?? 0) >= cadence && cadence > 0) {
    return { scope: 'full', reason: 'cadence-full', baseHeadSha: null, deltaPaths: [], priorFindings: [] };
  }
  const priorHead = input.priorApprovedHeadSha?.trim() ?? '';
  if (priorHead === '' || input.deltaPaths === null) {
    return { scope: 'full', reason: 'first-run', baseHeadSha: null, deltaPaths: [], priorFindings: [] };
  }
  return {
    scope: 'delta',
    reason: 'delta-since-approved-head',
    baseHeadSha: priorHead,
    deltaPaths: [...(input.deltaPaths ?? [])],
    priorFindings: [...(input.priorFindings ?? [])],
  };
}

export function buildDeltaPromptSection(selection: ReviewScopeSelection): string {
  if (selection.scope !== 'delta' || selection.baseHeadSha === null) {
    return 'Inspect the full current-head diff for this lane.';
  }
  const findings = selection.priorFindings.length === 0
    ? '- None recorded at the prior approved head.'
    : selection.priorFindings.map(finding => `- ${finding.summary}`).join('\n');
  const paths = selection.deltaPaths.length === 0
    ? '- None; confirm prior findings only.'
    : selection.deltaPaths.map(path => `- ${path}`).join('\n');
  return [
    `Delta re-review since approved head ${selection.baseHeadSha}.`,
    'Inspect only this delta and the resolution of prior findings. Do not re-review unchanged files as a full-diff pass.',
    'Prior findings:',
    findings,
    'Changed paths since that head:',
    paths,
  ].join('\n');
}

export function validateDeltaLaneEvidence(input: {
  readonly repoRoot: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly laneId: string;
  readonly reviewScope: unknown;
  readonly baseHeadSha: unknown;
}): { ok: true } | { ok: false; reason: 'unreviewed-base-head' | 'missing-base-head' } {
  if (input.reviewScope !== 'delta') return { ok: true };
  if (typeof input.baseHeadSha !== 'string' || input.baseHeadSha.trim() === '') {
    return { ok: false, reason: 'missing-base-head' };
  }
  const priorPath = join(
    input.repoRoot,
    '.qube',
    'aie',
    'reviews',
    String(input.issueNumber),
    String(input.prNumber),
    safeSegment(input.baseHeadSha),
    `${input.laneId}.json`,
  );
  if (!existsSync(priorPath)) return { ok: false, reason: 'unreviewed-base-head' };
  try {
    const parsed: unknown = JSON.parse(readFileSync(priorPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'unreviewed-base-head' };
    const record = parsed as Record<string, unknown>;
    if (record.status !== 'passed' || record.recommendation !== 'approve') return { ok: false, reason: 'unreviewed-base-head' };
    if (typeof record.headSha === 'string' && record.headSha.trim() !== '' && record.headSha !== input.baseHeadSha) {
      return { ok: false, reason: 'unreviewed-base-head' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'unreviewed-base-head' };
  }
}

export function countPriorDeltaRounds(input: {
  readonly repoRoot: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly laneId: string;
  readonly currentHeadSha: string;
}): number {
  const records = listPriorApprovedLaneRecords(input);
  let count = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].reviewScope !== 'delta') break;
    count += 1;
  }
  return count;
}

export function readPriorApprovedLane(input: {
  readonly repoRoot: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly laneId: string;
  readonly currentHeadSha: string;
}): { headSha: string; findings: PriorLaneFinding[] } | null {
  const records = listPriorApprovedLaneRecords(input);
  const latest = records[records.length - 1];
  return latest ? { headSha: latest.headSha, findings: latest.findings } : null;
}

function listPriorApprovedLaneRecords(input: {
  readonly repoRoot: string;
  readonly issueNumber: number;
  readonly prNumber: number;
  readonly laneId: string;
  readonly currentHeadSha: string;
}): Array<{ headSha: string; findings: PriorLaneFinding[]; recordedAt: string; reviewScope: ReviewScopeKind }> {
  const prDirectory = join(input.repoRoot, '.qube', 'aie', 'reviews', String(input.issueNumber), String(input.prNumber));
  if (!existsSync(prDirectory)) return [];
  const records: Array<{ headSha: string; findings: PriorLaneFinding[]; recordedAt: string; reviewScope: ReviewScopeKind }> = [];
  for (const entry of readdirSync(prDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === safeSegment(input.currentHeadSha)) continue;
    const path = join(prDirectory, entry.name, `${input.laneId}.json`);
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (record.status !== 'passed' || record.recommendation !== 'approve') continue;
      if (record.carriedForward && typeof record.carriedForward === 'object') continue;
      const headSha = typeof record.headSha === 'string' ? record.headSha.trim() : '';
      if (headSha === '' || headSha === input.currentHeadSha) continue;
      const findings = Array.isArray(record.findings)
        ? record.findings.flatMap(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
          const summary = typeof (item as { summary?: unknown }).summary === 'string' ? (item as { summary: string }).summary.trim() : '';
          return summary === '' ? [] : [{ summary }];
        })
        : [];
      records.push({
        headSha,
        findings,
        recordedAt: typeof record.recordedAt === 'string' ? record.recordedAt : '',
        reviewScope: record.reviewScope === 'delta' ? 'delta' : 'full',
      });
    } catch {
      continue;
    }
  }
  records.sort((left, right) => left.recordedAt < right.recordedAt ? -1 : left.recordedAt > right.recordedAt ? 1 : 0);
  return records;
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}
