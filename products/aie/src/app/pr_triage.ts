import { createHash } from 'node:crypto';
import type { Config } from '../config/index.js';
import { readCurrentHeadLaneEvidence, type LocalReviewLane, type LocalReviewLaneId } from '../local_review_evidence.js';
import { LANE_HEURISTIC_DIGESTS } from '../review_focus.js';
import { ghFailureMessage, runGh, type GhExec } from '../providers/github_adapter_exports.js';
import { redact } from '../redact.js';

const ADVISORY_MARKER_PREFIX = 'qube-advisory';

export interface PrTriageAdvisory {
  lane: string;
  findingId: string | null;
  message: string;
  location: { path: string; line: number | null } | null;
  suggestion: string | null;
  dedupeKey: string;
  disposition: 'planned' | 'created' | 'existing';
  issueNumber: number | null;
  issueUrl: string | null;
}

export interface PrTriageResult {
  ok: true;
  command: 'pr triage';
  pr: number;
  headSha: string;
  dryRun: boolean;
  advisories: PrTriageAdvisory[];
  lanesInspected: string[];
  limitation: string | null;
  linkComment: 'planned' | 'posted' | 'skipped';
  summary: string;
  nextAction: string;
}

export interface PrTriageOptions {
  prNumber: number;
  repoRoot?: string;
  dryRun?: boolean;
  exec?: GhExec;
}

interface TriagePrContext {
  number: number;
  title: string;
  url: string;
  headSha: string;
  issueNumbers: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function triagePrContext(prNumber: number, cwd: string | undefined, exec: GhExec | undefined): Promise<TriagePrContext> {
  const result = await runGh(['pr', 'view', String(prNumber), '--json', 'number,title,url,headRefOid,closingIssuesReferences'], { cwd, exec });
  if (result.exitCode !== 0) throw new Error(ghFailureMessage(`gh pr view ${prNumber}`, result.exitCode, result.stderr || result.stdout));
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isRecord(parsed) || typeof parsed.number !== 'number' || typeof parsed.headRefOid !== 'string' || parsed.headRefOid.trim() === '') {
    throw new Error('gh pr view returned missing or malformed number or headRefOid fields.');
  }
  const issueNumbers = Array.isArray(parsed.closingIssuesReferences)
    ? parsed.closingIssuesReferences.flatMap(entry => isRecord(entry) && typeof entry.number === 'number' && Number.isSafeInteger(entry.number) && entry.number > 0 ? [entry.number] : [])
    : [];
  return {
    number: parsed.number,
    title: typeof parsed.title === 'string' ? parsed.title : `PR #${parsed.number}`,
    url: typeof parsed.url === 'string' ? parsed.url : '',
    headSha: parsed.headRefOid,
    issueNumbers,
  };
}

function advisoryDedupeKey(lane: string, finding: { message: string; location: { path: string; line: number | null } | null; suggestion: string | null }): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({ lane, message: finding.message, path: finding.location?.path ?? null, line: finding.location?.line ?? null, suggestion: finding.suggestion }))
    .digest('hex')
    .slice(0, 16);
  return `${ADVISORY_MARKER_PREFIX}:${hash}`;
}

function advisoryIssueTitle(message: string): string {
  const compact = message.replace(/\s+/g, ' ').trim();
  return `Review advisory: ${compact.length > 70 ? `${compact.slice(0, 67)}...` : compact}`;
}

function advisoryIssueBody(pr: TriagePrContext, advisory: PrTriageAdvisory): string {
  const location = advisory.location ? `${advisory.location.path}${advisory.location.line !== null ? `:${advisory.location.line}` : ''}` : 'not recorded';
  return [
    '## Context',
    '',
    `A review lane raised this advisory finding at an approved head of ${pr.url || `PR #${pr.number}`}. Per ship-ready triage, advisory-only work moves to follow-up issues instead of new commits on an approved head.`,
    '',
    `- Lane: ${advisory.lane}`,
    `- Finding id: ${advisory.findingId ?? 'not recorded'}`,
    `- Location: ${location}`,
    `- Source head: ${pr.headSha}`,
    '',
    '## Finding',
    '',
    advisory.message,
    ...(advisory.suggestion ? ['', '## Suggested direction', '', advisory.suggestion] : []),
    '',
    '## Metadata',
    '',
    `- Dedupe key: \`${advisory.dedupeKey}\``,
  ].join('\n');
}

async function findExistingAdvisoryIssue(dedupeKey: string, cwd: string | undefined, exec: GhExec | undefined): Promise<{ number: number; url: string } | null> {
  const result = await runGh(['issue', 'list', '--state', 'open', '--search', `"${dedupeKey}" in:body`, '--json', 'number,url'], { cwd, exec });
  if (result.exitCode !== 0) throw new Error(ghFailureMessage('gh issue list --search', result.exitCode, result.stderr || result.stdout));
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) return null;
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry.number === 'number' && entry.number > 0) {
      return { number: entry.number, url: typeof entry.url === 'string' ? entry.url : '' };
    }
  }
  return null;
}

function terminalLane(lane: LocalReviewLane | null): lane is LocalReviewLane {
  return lane !== null && (lane.status === 'passed' || lane.status === 'failed' || lane.status === 'needs-work');
}

export async function runPrTriageService(config: Config, options: PrTriageOptions): Promise<PrTriageResult> {
  const dryRun = options.dryRun ?? false;
  const repoRoot = options.repoRoot ?? process.cwd();
  const pr = await triagePrContext(options.prNumber, repoRoot, options.exec);
  // Enumerate every known lane id: triage reads whatever terminal current-head
  // evidence exists, and configured lane subsets simply have no files to read.
  const laneIds = Object.keys(LANE_HEURISTIC_DIGESTS) as LocalReviewLaneId[];
  const advisories: PrTriageAdvisory[] = [];
  const seenKeys = new Set<string>();
  const lanesInspected: string[] = [];
  let anyEvidence = false;
  for (const issueNumber of pr.issueNumbers) {
    for (const laneId of laneIds) {
      const lane = readCurrentHeadLaneEvidence(repoRoot, issueNumber, pr.number, pr.headSha, laneId);
      if (!terminalLane(lane)) continue;
      anyEvidence = true;
      if (!lanesInspected.includes(laneId)) lanesInspected.push(laneId);
      for (const finding of lane.findings.filter(entry => entry.severity === 'advisory')) {
        const location = finding.location && typeof finding.location.path === 'string'
          ? { path: finding.location.path, line: typeof finding.location.line === 'number' ? finding.location.line : null }
          : null;
        const normalized = { message: redact(finding.message), location, suggestion: finding.suggestion ? redact(finding.suggestion) : null };
        const dedupeKey = advisoryDedupeKey(laneId, normalized);
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        advisories.push({
          lane: laneId,
          findingId: finding.id ?? null,
          message: normalized.message,
          location,
          suggestion: normalized.suggestion,
          dedupeKey,
          disposition: 'planned',
          issueNumber: null,
          issueUrl: null,
        });
      }
    }
  }

  const limitation = anyEvidence
    ? null
    : 'No terminal current-head local lane evidence was found. Full findings, severities, and locations are local-only fields; trusted provider markers carry verdict-level state only, so advisories cannot be enumerated from provider metadata. Run the PR gate on this machine first.';

  for (const advisory of advisories) {
    const existing = await findExistingAdvisoryIssue(advisory.dedupeKey, repoRoot, options.exec);
    if (existing) {
      advisory.disposition = 'existing';
      advisory.issueNumber = existing.number;
      advisory.issueUrl = existing.url;
      continue;
    }
    if (dryRun) continue;
    const created = await runGh(['issue', 'create', '--title', advisoryIssueTitle(advisory.message), '--body', advisoryIssueBody(pr, advisory)], { cwd: repoRoot, exec: options.exec });
    if (created.exitCode !== 0) throw new Error(ghFailureMessage('gh issue create', created.exitCode, created.stderr || created.stdout));
    const url = created.stdout.trim().split('\n').pop() ?? '';
    const numberMatch = url.match(/\/issues\/(\d+)/);
    advisory.disposition = 'created';
    advisory.issueUrl = url;
    advisory.issueNumber = numberMatch ? Number(numberMatch[1]) : null;
  }

  let linkComment: PrTriageResult['linkComment'] = 'skipped';
  const linkable = advisories.filter(advisory => advisory.issueUrl || advisory.issueNumber !== null || advisory.disposition === 'planned');
  if (linkable.length > 0) {
    if (dryRun) {
      linkComment = 'planned';
    } else {
      const lines = [
        `Advisory triage for head ${pr.headSha}: ${advisories.length} residual advisory finding(s) moved to follow-up issues instead of new commits on the approved head.`,
        ...advisories.map(advisory => `- ${advisory.lane}: ${advisory.disposition === 'created' ? 'filed' : 'already tracked as'} ${advisory.issueUrl || `#${advisory.issueNumber ?? '?'}`} — ${advisory.message.slice(0, 120)}`),
      ];
      const comment = await runGh(['pr', 'comment', String(pr.number), '--body', lines.join('\n')], { cwd: repoRoot, exec: options.exec });
      if (comment.exitCode !== 0) throw new Error(ghFailureMessage('gh pr comment', comment.exitCode, comment.stderr || comment.stdout));
      linkComment = 'posted';
    }
  }

  const created = advisories.filter(advisory => advisory.disposition === 'created').length;
  const existing = advisories.filter(advisory => advisory.disposition === 'existing').length;
  const planned = advisories.filter(advisory => advisory.disposition === 'planned').length;
  const summaryParts = [
    `${advisories.length} advisory finding(s) at head ${pr.headSha.slice(0, 12)} across ${lanesInspected.length} lane(s).`,
    ...(created > 0 ? [`Filed ${created} follow-up issue(s).`] : []),
    ...(existing > 0 ? [`${existing} already tracked.`] : []),
    ...(dryRun && planned > 0 ? [`${planned} would be filed.`] : []),
    ...(limitation ? [limitation] : []),
  ];
  return {
    ok: true,
    command: 'pr triage',
    pr: pr.number,
    headSha: redact(pr.headSha),
    dryRun,
    advisories,
    lanesInspected,
    limitation,
    linkComment,
    summary: summaryParts.join(' '),
    nextAction: limitation
      ? 'Run `aie pr gate <pr>` on this machine to record local lane evidence, then rerun `aie pr triage <pr>`.'
      : advisories.length === 0
        ? 'No residual advisories; merge when the PR gate reports ship-ready.'
        : dryRun
          ? 'Rerun without --dry-run to file the planned follow-up issues and link them on the pull request.'
          : 'Follow-up issues are linked on the pull request; merge when the PR gate reports ship-ready.',
  };
}

export function formatPrTriage(result: PrTriageResult): string {
  const lines = [`PR advisory triage for #${result.pr}${result.dryRun ? ' (dry-run)' : ''}: ${result.summary}`];
  for (const advisory of result.advisories) {
    const location = advisory.location ? ` (${advisory.location.path}${advisory.location.line !== null ? `:${advisory.location.line}` : ''})` : '';
    lines.push(`- [${advisory.disposition}] ${advisory.lane}${location}: ${advisory.message.slice(0, 140)}${advisory.issueUrl ? ` -> ${advisory.issueUrl}` : ''}`);
  }
  lines.push(`Link comment: ${result.linkComment}.`);
  lines.push(`Next action: ${result.nextAction}`);
  return lines.join('\n');
}
