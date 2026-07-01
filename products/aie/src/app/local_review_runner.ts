import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { ReviewLanePolicy } from '../core/policy.js';
import { activeLocalReviewFocusesForConfig } from '../review_focus.js';
import { type LocalReviewLaneId, type LocalReviewProfile } from '../local_review_evidence.js';
import { renderAieCliPrefix } from '../init_content.js';
import type { PrGateExec } from './pr_gate.js';
import { blockedLane, buildLocalReviewPublishCommand, buildLocalReviewSpawnContract, executableReviewCommandsTrusted, hash, laneContextLines, laneEvidencePath, promptStack, runExternalLane, writeLane, type LaneEvidence, type LocalReviewSpawnContract } from './local_review_runner_support.js';

import { probeHostReviewRunner, probeHostReviewRunnerSync, type HostReviewCapability } from '../providers/host_runner_adapters.js';

export type LocalReviewRunStatus = 'disabled' | 'planned' | 'completed' | 'pending' | 'unavailable' | 'failed';
export type LocalReviewLaneRunStatus = 'planned' | 'completed' | 'skipped' | 'pending' | 'unavailable' | 'failed';

export type CodexReviewCapability = HostReviewCapability & { host: 'codex' };

export interface LocalReviewLaneRun {
  issueNumber: number;
  issueNumbers: number[];
  lane: LocalReviewLaneId;
  runner: ReviewLanePolicy['runner'];
  command: string | null;
  status: LocalReviewLaneRunStatus;
  evidencePath: string;
  evidencePaths: string[];
  promptFragmentIds: string[];
  promptStackHash: string;
  promptText: string;
  promptOutputContract: string;
  spawnPrompt: string;
  spawnContract: LocalReviewSpawnContract | null;
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
  includePrompts?: boolean;
  exec?: PrGateExec;
  contextLines?: readonly string[];
  changedPaths?: readonly string[];
}

function effectiveProfile(config: Config, required: boolean, shadow: boolean): LocalReviewProfile {
  if (shadow) return 'local-shadow';
  if (required && config.reviewProfile === 'remote-compatible') return 'local-standard';
  return config.reviewProfile;
}

export async function probeCodexReviewCapability(independentReviewerCommand?: string | null, hostProvided = false): Promise<CodexReviewCapability> {
  const capability = await probeHostReviewRunner('codex', { independentReviewerCommand, hostProvided });
  return { ...capability, host: 'codex' };
}

export function probeCodexReviewCapabilitySync(independentReviewerCommand?: string | null, hostProvided = false): CodexReviewCapability {
  const capability = probeHostReviewRunnerSync('codex', { independentReviewerCommand, hostProvided });
  return { ...capability, host: 'codex' };
}

function codexCommand(config: Config): string | null {
  const command = config.reviewLanes.find(lane => lane.runner === 'local-host' && lane.command?.trim())?.command?.trim();
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

function localAieCliPrefix(config: Config, repoRoot: string): string {
  const workspaceRunner = existsSync(join(repoRoot, 'products', 'aie', 'bin', 'run')) ? 'node products/aie/bin/run' : null;
  return renderAieCliPrefix(config, workspaceRunner);
}

function laneRun(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, runner: ReviewLanePolicy['runner'], command: string | null, status: LocalReviewLaneRunStatus, evidencePath: string, summary: string, blocker: string | null, cliPrefix: string, contextLines: readonly string[], includePrompt: boolean, issueNumbers: readonly number[] = [issueNumber], evidencePaths: readonly string[] = [evidencePath]): LocalReviewLaneRun {
  const publishCommand = buildLocalReviewPublishCommand(cliPrefix, prNumber, lane, issueNumber);
  const rendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, contextLines, repoRoot, publishCommand));
  const stableRendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, [], repoRoot, publishCommand));
  const promptStackHash = hash(stableRendered.text);
  const promptText = includePrompt ? rendered.text : '';
  const spawnContract = includePrompt && runner === 'local-host' && promptText.trim() !== ''
    ? buildLocalReviewSpawnContract({ hostAgentType: 'qube-review-focus', lane, issueNumber, prNumber, headSha, promptStackHash, promptText, publishCommand })
    : null;
  return {
    issueNumber,
    issueNumbers: [...issueNumbers],
    lane,
    runner,
    command,
    status,
    evidencePath,
    evidencePaths: [...evidencePaths],
    promptFragmentIds: rendered.orderedFragmentIds,
    promptStackHash,
    promptText,
    promptOutputContract: rendered.outputContract,
    spawnPrompt: spawnContract?.taskPrompt ?? '',
    spawnContract,
    summary,
    blocker,
  };
}

function codexSubagentSummary(lane: LocalReviewLaneId, issueNumber: number, linkedIssueNumbers: readonly number[], prNumber: number, headSha: string, evidencePath: string, publishCommand: string): string {
  return `Create the review session lock, spawn one independent Codex subagent with agent_type qube-review-focus and fork_context false. Paste each lane spawnPrompt from pr gate --dry-run --json --local-review-prompts verbatim as the subagent task prompt; never reference .qube/aie/reviews/.../prompts/ files. Review focus ${lane} for issue #${issueNumber} and PR #${prNumber} at head ${headSha}. Linked issues for PR context: ${linkedIssueNumbers.map(linkedIssueNumber => `#${linkedIssueNumber}`).join(', ')}. Run pending review focuses in parallel when the host supports it. Each subagent must publish its lane review to the pull request with \`${publishCommand}\`. Wait for all subagents, delete the review session lock, rerun pr gate, and treat provider PR reviews/comments as the merge gate; local audit JSON at ${evidencePath} is optional.`;
}

export async function runLocalReviewRunner(config: Config, input: LocalReviewRunnerInput): Promise<LocalReviewRunResult> {
  const codex = await probeCodexReviewCapability(codexCommand(config), config.localReviewAgents.includes('codex'));
  const profile = effectiveProfile(config, input.required, input.shadow);
  const requiredLanes = [...activeLocalReviewFocusesForConfig(config, input.changedPaths)];
  const evidenceRoot = join(input.repoRoot, '.qube', 'aie', 'reviews');
  const contextLines = input.contextLines ?? [];
  const includePrompt = input.includePrompts === true;
  const cliPrefix = localAieCliPrefix(config, input.repoRoot);
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
  const commandTrust = await executableReviewCommandsTrusted(input.repoRoot, `${config.baseRemote}/${config.baseBranch}`);
  const commandlessHostLanes = new Set(requiredLanes.filter(lane => laneRunner(config, lane) === 'local-host' && !laneCommand(config, lane)));

  for (const lane of commandlessHostLanes) {
    for (const issueNumber of input.issueNumbers) {
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const linkedIssueNumbers = [issueNumber, ...input.issueNumbers.filter(linkedIssueNumber => linkedIssueNumber !== issueNumber)];
      const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
      const summary = codexSubagentSummary(lane, issueNumber, input.issueNumbers, input.prNumber, input.headSha, path, publishCommand);
      const status = input.dryRun ? 'planned' : 'pending';
      const blocker = input.dryRun ? null : 'codex-subagent-review-required';
      lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, 'local-host', null, status, path, summary, blocker, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, [path]));
    }
  }

  for (const issueNumber of input.issueNumbers) {
    const produced: LaneEvidence[] = [];
    for (const lane of requiredLanes) {
      if (commandlessHostLanes.has(lane)) continue;
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const runner = laneRunner(config, lane);
      const command = laneCommand(config, lane);
      const plannedRun = laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'planned', path, runner === 'local-host' ? 'Codex local-host lane would run and write current-head evidence.' : 'Local-command lane would run and write current-head evidence.', null, cliPrefix, contextLines, includePrompt);
      if (command && !commandTrust) {
        const summary = 'Executable local review command is unavailable because review runner configuration changed outside the trusted base.';
        const blocker = 'review runner command is not trusted for current PR head';
        unavailable.push(`${lane}: ${summary}`);
        produced.push(blockedLane(lane, 'unavailable', summary, blocker, command, issueNumber, input.prNumber, input.repoRoot, input.headSha, runner === 'local-host' ? 'local-host' : 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'unavailable', path, summary, blocker, cliPrefix, contextLines, includePrompt));
        continue;
      }
      if (runner === 'local-host') {
        if (!command) continue;
        if (input.dryRun) {
          lanes.push(plannedRun);
          continue;
        }
        const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
        const evidence = await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, 'local-host', plannedRun.promptStackHash, input.repoRoot, path, contextLines, publishCommand, input.exec);
        if (!evidence) {
          failed = true;
          produced.push(blockedLane(lane, 'malformed', 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-host'));
          lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output', cliPrefix, contextLines, includePrompt));
          continue;
        }
        const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-host');
        written.push(writtenPath);
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt));
        produced.push(evidence);
        continue;
      }
      if (runner !== 'local-command' || !command) {
        unavailable.push(`${lane}: no local-command runner command is configured.`);
        produced.push(blockedLane(lane, 'unavailable', 'No runnable local-command is configured for this lane.', 'missing local-command', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'unavailable', path, 'No runnable local-command is configured for this lane.', 'missing local-command', cliPrefix, contextLines, includePrompt));
        continue;
      }
      if (input.dryRun) {
        lanes.push(plannedRun);
        continue;
      }
      const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
      const evidence = await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, 'local-command', plannedRun.promptStackHash, input.repoRoot, path, contextLines, publishCommand, input.exec);
      if (!evidence) {
        failed = true;
        produced.push(blockedLane(lane, 'malformed', 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output', cliPrefix, contextLines, includePrompt));
        continue;
      }
      const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-command');
      written.push(writtenPath);
      lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt));
      produced.push(evidence);
    }
  }

  const status: LocalReviewRunStatus = failed
    ? 'failed'
    : lanes.some(lane => lane.status === 'pending')
      ? 'pending'
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
      : status === 'pending'
        ? `Local review runner is waiting for ${lanes.filter(lane => lane.status === 'pending').length} independent Codex subagent review lane(s). Run them in parallel when the host supports it.`
      : status === 'planned'
        ? `Local review runner planned ${lanes.length} lane execution(s).`
        : `Local review runner could not complete all required lanes: ${unavailable.join('; ')}`,
  };
}
