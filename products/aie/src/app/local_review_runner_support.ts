import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { renderAgentPrompt } from '../agent_descriptors.js';
import { redact } from '../redact.js';
import { carryForwardDeltaTouched, defaultCarryForwardContext, type CarryForwardContextMode } from '../review_focus.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, localReviewEvidenceSha256, trustedLocalHostProvenancePath, type LocalReviewContextReviewed, type LocalReviewLaneId, type LocalReviewProfile, type LocalReviewRecommendation, type LocalReviewRunnerProvenance, type LocalReviewSeverity, type LocalReviewStatus } from '../local_review_evidence.js';
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
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
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

export function routeFaultLedgerPath(repoRoot: string, issueNumber: number, prNumber: number): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), 'route-faults.json');
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

export function recordRouteFault(repoRoot: string, issueNumber: number, prNumber: number, lane: LocalReviewLaneId, reasonCode: string, routeKey: string): number {
  const ledger = readRouteFaults(repoRoot, issueNumber, prNumber);
  // A tally is only meaningful against one primary route identity; a config
  // change to the lane's primary route restarts the count so the changed
  // primary is actually tested before failover engages again.
  const existing = ledger.lanes[lane];
  const count = (existing && existing.routeKey === routeKey ? existing.count : 0) + 1;
  ledger.lanes[lane] = { count, routeKey, lastReasonCode: reasonCode, lastAt: new Date().toISOString() };
  const path = routeFaultLedgerPath(repoRoot, issueNumber, prNumber);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
  return count;
}

export function clearRouteFault(repoRoot: string, issueNumber: number, prNumber: number, lane: LocalReviewLaneId): void {
  const ledger = readRouteFaults(repoRoot, issueNumber, prNumber);
  if (!(lane in ledger.lanes)) return;
  delete ledger.lanes[lane];
  const path = routeFaultLedgerPath(repoRoot, issueNumber, prNumber);
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);
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
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
    return path;
  } catch {
    return null;
  }
}

export function reviewSessionLockPath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), '.review-lock.json');
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
    sha256: typeof item.sha256 === 'string' ? item.sha256 : '',
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
    contextReviewed: Array.isArray(value.contextReviewed) ? value.contextReviewed.filter(isRecord).map(item => ({
      kind: typeof item.kind === 'string' ? item.kind as LocalReviewContextReviewed['kind'] : 'diff',
      source: typeof item.source === 'string' ? redact(item.source) : 'local-command',
      trust: typeof item.trust === 'string' ? item.trust as LocalReviewContextReviewed['trust'] : 'local-evidence',
      freshness: typeof item.freshness === 'string' ? item.freshness as LocalReviewContextReviewed['freshness'] : 'current',
    })) : [],
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
  writeFileSync(path, `${JSON.stringify({
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
  }, null, 2)}\n`);
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
  writeFileSync(rawPath, rawBodyText);
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
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
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
  writeFileSync(path, `${JSON.stringify({
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
  }, null, 2)}\n`);
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
