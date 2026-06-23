import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { Config } from '../config/index.js';
import type { ReviewLanePolicy } from '../core/policy.js';
import { renderAgentPrompt } from '../agent_descriptors.js';
import { COMPREHENSIVE_LOCAL_REVIEW_LANES, requiredLocalReviewLanes, type LocalReviewContextReviewed, type LocalReviewLaneId, type LocalReviewProfile, type LocalReviewRecommendation, type LocalReviewSeverity, type LocalReviewStatus } from '../local_review_evidence.js';
import type { PrGateExec, PrGateExecResult } from './pr_gate.js';

const execFileAsync = promisify(execFile);

export type LocalReviewRunStatus = 'disabled' | 'planned' | 'completed' | 'pending' | 'unavailable' | 'failed';
export type LocalReviewLaneRunStatus = 'planned' | 'completed' | 'skipped' | 'unavailable' | 'failed';

export interface CodexReviewCapability {
  host: 'codex';
  independentReviewer: boolean;
  promptOnly: boolean;
  hooks: boolean;
  evidenceWriting: boolean;
  missingCapabilities: string[];
  nextAction: string;
}

export interface LocalReviewLaneRun {
  issueNumber: number;
  lane: LocalReviewLaneId;
  runner: ReviewLanePolicy['runner'];
  command: string | null;
  status: LocalReviewLaneRunStatus;
  evidencePath: string;
  promptFragmentIds: string[];
  promptOutputContract: string;
  summary: string;
  blocker: string | null;
}

export interface LocalReviewRunResult {
  required: boolean;
  dryRun: boolean;
  profile: LocalReviewProfile;
  prNumber: number;
  headSha: string;
  status: LocalReviewRunStatus;
  evidenceRoot: string;
  codex: CodexReviewCapability;
  lanes: LocalReviewLaneRun[];
  written: string[];
  unavailable: string[];
  summary: string;
}

interface LocalReviewRunnerInput {
  repoRoot: string;
  issueNumbers: readonly number[];
  prNumber: number;
  headSha: string;
  required: boolean;
  shadow: boolean;
  dryRun: boolean;
  exec?: PrGateExec;
}

interface LaneEvidence {
  id: LocalReviewLaneId;
  status: LocalReviewStatus;
  severity: LocalReviewSeverity;
  recommendation: LocalReviewRecommendation;
  summary: string;
  blockers: string[];
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
  commands: string[];
  surfaces: string[];
  contextReviewed: LocalReviewContextReviewed[];
  promptStack: Array<{ id: string; source: string; sourceCategory?: string; path: string | null; sha256: string | null; trust: string }>;
  toolsUsed: string[];
}

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function laneEvidenceDirectory(repoRoot: string, issueNumber: number, prNumber: number, headSha: string): string {
  return join(repoRoot, '.qube', 'aie', 'reviews', String(issueNumber), String(prNumber), safeSegment(headSha));
}

function laneEvidencePath(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId): string {
  return join(laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha), `${lane}.json`);
}

function relativePath(repoRoot: string, path: string): string {
  return relative(repoRoot, path).replace(/\\/g, '/');
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function effectiveProfile(config: Config, required: boolean, shadow: boolean): LocalReviewProfile {
  if (shadow) return 'local-shadow';
  if (required && config.reviewProfile === 'remote-compatible') return 'local-standard';
  return config.reviewProfile;
}

export function probeCodexReviewCapability(independentReviewerCommand?: string | null): CodexReviewCapability {
  const independentReviewer = typeof independentReviewerCommand === 'string' && independentReviewerCommand.trim() !== '';
  return {
    host: 'codex',
    independentReviewer,
    promptOnly: true,
    hooks: true,
    evidenceWriting: true,
    missingCapabilities: independentReviewer ? [] : ['independent-reviewer-execution'],
    nextAction: independentReviewer
      ? 'Codex local-host review execution is configured; run local-host lanes and record current-head local-host evidence.'
      : 'Codex prompt compilation is available, but this host does not expose an independent reviewer runner to AIE; record prompt-only or unavailable evidence without claiming local-host review success.',
  };
}

function codexCommand(config: Config): string | null {
  const command = config.reviewLanes.find(lane => lane.runner === 'local-host')?.command?.trim();
  return command && command !== '' ? command : null;
}

function lanePolicy(config: Config, lane: LocalReviewLaneId): ReviewLanePolicy | undefined {
  return config.reviewLanes.find(item => item.id === lane);
}

function laneRunner(config: Config, lane: LocalReviewLaneId): ReviewLanePolicy['runner'] {
  return lanePolicy(config, lane)?.runner ?? 'manual-evidence';
}

function laneCommand(config: Config, lane: LocalReviewLaneId): string | null {
  const command = lanePolicy(config, lane)?.command?.trim();
  return command && command !== '' ? command : null;
}

function promptStack(lane: LocalReviewLaneId) {
  return renderAgentPrompt({
    hostId: 'fallback-single-agent',
    descriptorId: 'qa-reviewer',
    categoryId: 'review',
    laneIds: [lane],
    contextLines: [`Run local review lane ${lane}.`],
    outputContract: 'Return JSON local review lane evidence for the requested lane.',
  });
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

function fixtureLane(lane: LocalReviewLaneId, command: string, issueNumber: number, prNumber: number, repoRoot: string, headSha: string, runner: 'local-command' | 'local-host'): LaneEvidence {
  const failing = command.includes('fail-code-quality') && lane === 'code-quality';
  const status: LocalReviewStatus = failing ? 'failed' : 'passed';
  const evidencePath = relativePath(repoRoot, laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane));
  return {
    id: lane,
    status,
    severity: failing ? 'high' : 'none',
    recommendation: failing ? 'request-changes' : 'approve',
    summary: failing ? 'Fixture local review found code-quality blockers.' : `Fixture local review passed ${lane}.`,
    blockers: failing ? ['Fix fixture code-quality finding.'] : [],
    artifacts: [{ kind: 'json', path: evidencePath, sha256: hash(`${lane}:${headSha}`) }],
    commands: [command],
    surfaces: ['PR'],
    contextReviewed: defaultContext(issueNumber, prNumber),
    promptStack: promptStackEvidence(lane),
    toolsUsed: runner === 'local-host' ? ['codex', 'local-host'] : ['local-command'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readArtifacts(value: unknown): LaneEvidence['artifacts'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(item => ({
    kind: typeof item.kind === 'string' ? item.kind : 'json',
    path: typeof item.path === 'string' ? item.path : '',
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

function normalizeExternalLane(value: unknown, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string): LaneEvidence | null {
  if (!isRecord(value)) return null;
  const id = readLaneId(value.lane ?? value.id);
  if (id !== lane) return null;
  if (value.issueNumber !== issueNumber || value.prNumber !== prNumber || value.headSha !== headSha) return null;
  const status = readStatus(value.status);
  return {
    id,
    status,
    severity: readSeverity(value.severity),
    recommendation: readRecommendation(value.recommendation, status),
    summary: typeof value.summary === 'string' && value.summary.trim() !== '' ? value.summary.trim() : `${id} local review completed.`,
    blockers: readStringArray(value.blockers),
    artifacts: readArtifacts(value.artifacts),
    commands: readStringArray(value.commands),
    surfaces: readStringArray(value.surfaces),
    contextReviewed: Array.isArray(value.contextReviewed) ? value.contextReviewed.filter(isRecord).map(item => ({
      kind: typeof item.kind === 'string' ? item.kind as LocalReviewContextReviewed['kind'] : 'diff',
      source: typeof item.source === 'string' ? item.source : 'local-command',
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
    const result = await execFileAsync(file, rest, { cwd, encoding: 'utf8' });
    return { args, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const err = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { args, exitCode: typeof err.code === 'number' ? err.code : 1, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? 'local command failed' };
  }
}

async function runExternalLane(command: string, lane: LocalReviewLaneId, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, repoRoot: string, exec?: PrGateExec): Promise<LaneEvidence | null> {
  const args = [...splitCommand(command), '--lane', lane, '--issue', String(issueNumber), '--pr', String(prNumber), '--head', headSha, '--profile', profile];
  const result = await (exec ?? defaultExec)(args, repoRoot);
  if (result.exitCode !== 0) return null;
  try {
    return normalizeExternalLane(JSON.parse(result.stdout), lane, issueNumber, prNumber, headSha);
  } catch {
    return null;
  }
}

function writeLane(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, profile: LocalReviewProfile, lane: LaneEvidence, adapter: 'local-command' | 'local-host'): string {
  const directory = laneEvidenceDirectory(repoRoot, issueNumber, prNumber, headSha);
  mkdirSync(directory, { recursive: true });
  const path = laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, lane.id);
  const body = {
    version: 1,
    issueNumber,
    prNumber,
    headSha,
    profile,
    adapter,
    reviewer: adapter === 'local-host'
      ? { id: 'codex', name: 'Codex', adapterKind: 'local' }
      : { id: 'local-command', name: 'local-command', adapterKind: 'local' },
    lane: lane.id,
    ...lane,
    recordedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

function synthesizeFinalGate(previous: readonly LaneEvidence[], issueNumber: number, prNumber: number, repoRoot: string, headSha: string, adapter: 'local-command' | 'local-host'): LaneEvidence {
  const blockers = previous.flatMap(lane => lane.blockers);
  const failed = previous.find(lane => lane.status === 'failed' || lane.status === 'needs-work' || lane.recommendation === 'request-changes' || lane.blockers.length > 0);
  const pending = previous.find(lane => lane.status !== 'passed');
  const status: LocalReviewStatus = failed ? 'failed' : pending ? 'inconclusive' : 'passed';
  const evidencePath = relativePath(repoRoot, laneEvidencePath(repoRoot, issueNumber, prNumber, headSha, 'final-gate'));
  return {
    id: 'final-gate',
    status,
    severity: failed ? failed.severity : 'none',
    recommendation: status === 'passed' ? 'approve' : status === 'failed' ? 'request-changes' : 'inconclusive',
    summary: status === 'passed' ? 'Final gate approved all completed local review lanes.' : 'Final gate blocked on local review lane findings or missing results.',
    blockers,
    artifacts: [{ kind: 'json', path: evidencePath, sha256: hash(`final-gate:${headSha}:${status}`) }],
    commands: ['aie pr gate --local-review-synthesis'],
    surfaces: ['PR'],
    contextReviewed: previous.flatMap(lane => lane.contextReviewed),
    promptStack: promptStackEvidence('final-gate'),
    toolsUsed: adapter === 'local-host' ? ['codex', 'local-host'] : ['local-command'],
  };
}

function laneRun(issueNumber: number, lane: LocalReviewLaneId, runner: ReviewLanePolicy['runner'], command: string | null, status: LocalReviewLaneRunStatus, evidencePath: string, summary: string, blocker: string | null): LocalReviewLaneRun {
  const rendered = promptStack(lane);
  return { issueNumber, lane, runner, command, status, evidencePath, promptFragmentIds: rendered.orderedFragmentIds, promptOutputContract: rendered.outputContract, summary, blocker };
}

export async function runLocalReviewRunner(config: Config, input: LocalReviewRunnerInput): Promise<LocalReviewRunResult> {
  const codex = probeCodexReviewCapability(codexCommand(config));
  const profile = effectiveProfile(config, input.required, input.shadow);
  const requiredLanes = [...requiredLocalReviewLanes(profile)];
  const evidenceRoot = join(input.repoRoot, '.qube', 'aie', 'reviews');
  if (!input.required && !input.shadow) {
    return { required: false, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'disabled', evidenceRoot, codex, lanes: [], written: [], unavailable: [], summary: 'Local review runner is disabled by the selected review adapter.' };
  }
  if (input.issueNumbers.length === 0 || requiredLanes.length === 0) {
    return { required: input.required, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'pending', evidenceRoot, codex, lanes: [], written: [], unavailable: ['No linked issue or required local review lanes were available.'], summary: 'Local review runner could not plan lanes without a linked issue and required lane set.' };
  }

  const lanes: LocalReviewLaneRun[] = [];
  const written: string[] = [];
  const unavailable: string[] = [];
  let failed = false;

  for (const issueNumber of input.issueNumbers) {
    const produced: LaneEvidence[] = [];
    for (const lane of requiredLanes) {
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const runner = laneRunner(config, lane);
      const command = laneCommand(config, lane);
      if (lane === 'final-gate' && produced.length > 0 && !input.dryRun) {
        const finalAdapter = produced.some(item => item.toolsUsed.includes('local-host')) ? 'local-host' : 'local-command';
        const finalGate = synthesizeFinalGate(produced, issueNumber, input.prNumber, input.repoRoot, input.headSha, finalAdapter);
        const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, finalGate, finalAdapter);
        written.push(writtenPath);
        lanes.push(laneRun(issueNumber, lane, finalAdapter, null, 'completed', path, finalGate.summary, null));
        produced.push(finalGate);
        continue;
      }
      if (runner === 'local-host') {
        if (!codex.independentReviewer || !command) {
          unavailable.push(`${lane}: Codex local-host runner is prompt-only; independent reviewer execution is unavailable.`);
          lanes.push(laneRun(issueNumber, lane, runner, command, 'unavailable', path, codex.nextAction, 'independent-reviewer-execution unavailable'));
          continue;
        }
        if (input.dryRun) {
          lanes.push(laneRun(issueNumber, lane, runner, command, 'planned', path, 'Codex local-host lane would run and write current-head evidence.', null));
          continue;
        }
        const evidence = command.startsWith('aie:fixture-local-review')
          ? fixtureLane(lane, command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-host')
          : await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, input.repoRoot, input.exec);
        if (!evidence) {
          failed = true;
          lanes.push(laneRun(issueNumber, lane, runner, command, 'failed', path, 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output'));
          continue;
        }
        const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-host');
        written.push(writtenPath);
        lanes.push(laneRun(issueNumber, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null));
        produced.push(evidence);
        continue;
      }
      if (runner !== 'local-command' || !command) {
        unavailable.push(`${lane}: no local-command runner command is configured.`);
        lanes.push(laneRun(issueNumber, lane, runner, command, 'unavailable', path, 'No runnable local-command is configured for this lane.', 'missing local-command'));
        continue;
      }
      if (input.dryRun) {
        lanes.push(laneRun(issueNumber, lane, runner, command, 'planned', path, 'Local-command lane would run and write current-head evidence.', null));
        continue;
      }
      const evidence = command.startsWith('aie:fixture-local-review')
        ? fixtureLane(lane, command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-command')
        : await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, input.repoRoot, input.exec);
      if (!evidence) {
        failed = true;
        lanes.push(laneRun(issueNumber, lane, runner, command, 'failed', path, 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output'));
        continue;
      }
      const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-command');
      written.push(writtenPath);
      lanes.push(laneRun(issueNumber, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null));
      produced.push(evidence);
    }
  }

  const status: LocalReviewRunStatus = failed
    ? 'failed'
    : unavailable.length > 0
      ? 'unavailable'
      : input.dryRun
        ? 'planned'
        : 'completed';
  return {
    required: input.required,
    dryRun: input.dryRun,
    profile,
    prNumber: input.prNumber,
    headSha: input.headSha,
    status,
    evidenceRoot,
    codex,
    lanes,
    written,
    unavailable,
    summary: status === 'completed'
      ? `Local review runner wrote ${written.length} lane evidence file(s).`
      : status === 'planned'
        ? `Local review runner planned ${lanes.length} lane execution(s).`
        : `Local review runner could not complete all required lanes: ${unavailable.join('; ')}`,
  };
}
