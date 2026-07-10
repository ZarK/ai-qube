import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { ReviewLanePolicy } from '../core/policy.js';
import { activeLocalReviewFocusesForConfig } from '../review_focus.js';
import { type LocalReviewLaneId, type LocalReviewProfile } from '../local_review_evidence.js';
import { renderAieCliPrefix } from '../init_content.js';
import type { PrGateExec } from './pr_gate.js';
import { formatRiskCardReviewerFragment, selectRiskCards } from '../risk_cards/index.js';
import { blockedLane, buildLocalReviewPublishCommand, buildLocalReviewSpawnContract, executableReviewCommandsTrusted, expectedLaneFragmentDigest, findCarryForwardSource, hash, laneContextLines, laneEvidencePath, promptStack, resolveReviewModelTier, runExternalLane, writeCarriedForwardLane, writeLane, type LaneEvidence, type LocalReviewSpawnContract, type ReviewModelTierResolution } from './local_review_runner_support.js';
import { defaultRereviewMode } from '../config/schema.js';
import { aiqReviewContextLines, loadAiqReviewFindings } from './aiq_review_findings.js';

import { probeHostReviewRunner, probeHostReviewRunnerSync, type HostReviewCapability } from '../providers/host_runner_adapters.js';

export type LocalReviewRunStatus = 'disabled' | 'planned' | 'completed' | 'pending' | 'unavailable' | 'failed';
export type LocalReviewLaneRunStatus = 'planned' | 'completed' | 'skipped' | 'pending' | 'unavailable' | 'failed';

export type CodexReviewCapability = HostReviewCapability & { host: 'codex' };
export type OpenCodeReviewCapability = HostReviewCapability & { host: 'opencode' };

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
  opencode: OpenCodeReviewCapability;
  modelTiers: { review: ReviewModelTierResolution; economy: ReviewModelTierResolution; synthesis: ReviewModelTierResolution };
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
  /** Issue/PR titles used only for risk-card activation (not the full review context blob). */
  riskCardIssueText?: string;
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

export async function probeOpenCodeReviewCapability(): Promise<OpenCodeReviewCapability> {
  const capability = await probeHostReviewRunner('opencode');
  return { ...capability, host: 'opencode' };
}

export function probeOpenCodeReviewCapabilitySync(): OpenCodeReviewCapability {
  const capability = probeHostReviewRunnerSync('opencode');
  return { ...capability, host: 'opencode' };
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

function laneRun(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, runner: ReviewLanePolicy['runner'], command: string | null, status: LocalReviewLaneRunStatus, evidencePath: string, summary: string, blocker: string | null, cliPrefix: string, contextLines: readonly string[], includePrompt: boolean, issueNumbers: readonly number[] = [issueNumber], evidencePaths: readonly string[] = [evidencePath], tierResolution?: ReviewModelTierResolution, riskCardFragments: readonly string[] = []): LocalReviewLaneRun {
  const publishCommand = buildLocalReviewPublishCommand(cliPrefix, prNumber, lane, issueNumber);
  // Risk-card reviewer faces are part of both rendered and stable stacks so promptStackHash tracks activation.
  const rendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, contextLines, repoRoot, publishCommand), riskCardFragments);
  const stableRendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, [], repoRoot, publishCommand), riskCardFragments);
  const promptStackHash = hash(stableRendered.text);
  const promptText = includePrompt ? rendered.text : '';
  const spawnContract = includePrompt && runner === 'local-host' && promptText.trim() !== ''
    ? buildLocalReviewSpawnContract({ hostAgentType: 'qube-review-focus', lane, issueNumber, prNumber, headSha, promptStackHash, promptText, publishCommand, tierResolution })
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

async function carryForwardLaneRun(config: Config, input: LocalReviewRunnerInput, lane: LocalReviewLaneId, issueNumber: number, runner: ReviewLanePolicy['runner'], command: string | null, path: string, cliPrefix: string, contextLines: readonly string[], linkedIssueNumbers: readonly number[], written: string[], riskCardFragments: readonly string[] = []): Promise<LocalReviewLaneRun | null> {
  if (runner !== 'local-host' && runner !== 'local-command') return null;
  // Risk cards activate from issue text, which can change without a git delta; skip carry-forward when cards are active.
  if (riskCardFragments.length > 0) return null;
  const lanePolicy = config.reviewLanes.find(entry => entry.id === lane);
  if ((lanePolicy?.rereview ?? defaultRereviewMode(lane)) !== 'delta') return null;
  const contextPatterns = [...config.reviewContextSources.instructions, ...config.reviewContextSources.requirements];
  const source = await findCarryForwardSource({ repoRoot: input.repoRoot, issueNumber, prNumber: input.prNumber, headSha: input.headSha, lane, matchPatterns: lanePolicy?.match ?? [], contextPatterns, expectedFragmentDigest: expectedLaneFragmentDigest(lane), expectedAdapter: runner, requiredCommand: command });
  if (!source) return null;
  if (input.dryRun) {
    return laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'skipped', path, `Carry-forward planned from approved review at ${source.fromHeadSha}; the PR gate records carried evidence without spawning a reviewer (${source.deltaSummary}).`, null, cliPrefix, contextLines, false, linkedIssueNumbers, [path], undefined, riskCardFragments);
  }
  const writtenPath = writeCarriedForwardLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, source);
  if (!writtenPath) return null;
  written.push(writtenPath);
  return laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, `Carried forward from approved review at ${source.fromHeadSha} (${source.deltaSummary}).`, null, cliPrefix, contextLines, false, linkedIssueNumbers, [path], undefined, riskCardFragments);
}

export async function runLocalReviewRunner(config: Config, input: LocalReviewRunnerInput): Promise<LocalReviewRunResult> {
  const codex = await probeCodexReviewCapability(codexCommand(config), config.localReviewAgents.includes('codex'));
  const opencode = await probeOpenCodeReviewCapability();
  const profile = effectiveProfile(config, input.required, input.shadow);
  const requiredLanes = [...activeLocalReviewFocusesForConfig(config, input.changedPaths)];
  const evidenceRoot = join(input.repoRoot, '.qube', 'aie', 'reviews');
  const aiqFindings = loadAiqReviewFindings(input.repoRoot, input.changedPaths ?? []);
  const contextLines = [...(input.contextLines ?? []), ...aiqReviewContextLines(aiqFindings)];
  // Activate from issue text + changed paths only so hashes stay deterministic and do not
  // flip on every generated review-context line that happens to mention common keywords.
  const riskCardFragments = selectRiskCards({
    issueText: input.riskCardIssueText ?? '',
    paths: input.changedPaths ?? [],
  }).map(card => formatRiskCardReviewerFragment(card));
  const includePrompt = input.includePrompts === true;
  const cliPrefix = localAieCliPrefix(config, input.repoRoot);
  const modelTiers = {
    review: resolveReviewModelTier(config.reviewModels, 'review', 'codex'),
    economy: resolveReviewModelTier(config.reviewModels, 'economy', 'codex'),
    synthesis: resolveReviewModelTier(config.reviewModels, 'synthesis', 'codex'),
  };
  if (!input.required && !input.shadow) {
    return { required: false, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'disabled', evidenceRoot, codex, opencode, modelTiers, lanes: [], written: [], unavailable: [], summary: 'Local review runner is disabled by the selected review adapter.' };
  }
  if (input.issueNumbers.length === 0 || requiredLanes.length === 0) {
    return { required: input.required, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'pending', evidenceRoot, codex, opencode, modelTiers, lanes: [], written: [], unavailable: ['No linked issue or required local review lanes were available.'], summary: 'Local review runner could not plan lanes without a linked issue and required lane set.' };
  }

  const lanes: LocalReviewLaneRun[] = [];
  const written: string[] = [];
  const unavailable: string[] = [];
  const reviewTierResolution = modelTiers.review;
  let failed = false;
  const commandTrust = await executableReviewCommandsTrusted(input.repoRoot, `${config.baseRemote}/${config.baseBranch}`);
  const commandlessHostLanes = new Set(requiredLanes.filter(lane => laneRunner(config, lane) === 'local-host' && !laneCommand(config, lane)));

  const opencodeConfigured = config.localReviewAgents.includes('opencode');
  const commandlessHostReady = codex.independentReviewer || !opencodeConfigured;
  for (const lane of commandlessHostLanes) {
    for (const issueNumber of input.issueNumbers) {
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const linkedIssueNumbers = [issueNumber, ...input.issueNumbers.filter(linkedIssueNumber => linkedIssueNumber !== issueNumber)];
      const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
      if (!commandlessHostReady) {
        const summary = opencodeConfigured
          ? `OpenCode local-host review runner is unsupported: ${opencode.nextAction}`
          : codex.nextAction;
        const blocker = opencodeConfigured
          ? opencode.missingCapabilities[0] ?? 'opencode-local-review-runner-unsupported'
          : codex.missingCapabilities[0] ?? 'codex-local-reviewer-not-configured';
        unavailable.push(`${lane}: ${summary}`);
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, 'local-host', null, 'unavailable', path, summary, blocker, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, [path], undefined, riskCardFragments));
        continue;
      }
      const carried = await carryForwardLaneRun(config, input, lane, issueNumber, 'local-host', null, path, cliPrefix, contextLines, linkedIssueNumbers, written, riskCardFragments);
      if (carried) {
        lanes.push(carried);
        continue;
      }
      const summary = codexSubagentSummary(lane, issueNumber, input.issueNumbers, input.prNumber, input.headSha, path, publishCommand);
      const status = input.dryRun ? 'planned' : 'pending';
      const blocker = input.dryRun ? null : 'codex-subagent-review-required';
      lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, 'local-host', null, status, path, summary, blocker, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, [path], reviewTierResolution, riskCardFragments));
    }
  }

  for (const issueNumber of input.issueNumbers) {
    const produced: LaneEvidence[] = [];
    for (const lane of requiredLanes) {
      if (commandlessHostLanes.has(lane)) continue;
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const runner = laneRunner(config, lane);
      const command = laneCommand(config, lane);
      const plannedRun = laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'planned', path, runner === 'local-host' ? 'Codex local-host lane would run and write current-head evidence.' : 'Local-command lane would run and write current-head evidence.', null, cliPrefix, contextLines, includePrompt, [issueNumber], [path], reviewTierResolution, riskCardFragments);
      if (command && !commandTrust) {
        const summary = 'Executable local review command is unavailable because review runner configuration changed outside the trusted base.';
        const blocker = 'review runner command is not trusted for current PR head';
        unavailable.push(`${lane}: ${summary}`);
        produced.push(blockedLane(lane, 'unavailable', summary, blocker, command, issueNumber, input.prNumber, input.repoRoot, input.headSha, runner === 'local-host' ? 'local-host' : 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'unavailable', path, summary, blocker, cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        continue;
      }
      const carried = await carryForwardLaneRun(config, input, lane, issueNumber, runner, command, path, cliPrefix, contextLines, [issueNumber], written, riskCardFragments);
      if (carried) {
        lanes.push(carried);
        continue;
      }
      if (runner === 'local-host') {
        if (!command) continue;
        if (input.dryRun) {
          lanes.push(plannedRun);
          continue;
        }
        const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
        const evidence = await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, 'local-host', plannedRun.promptStackHash, input.repoRoot, path, contextLines, publishCommand, input.exec, riskCardFragments);
        if (!evidence) {
          failed = true;
          produced.push(blockedLane(lane, 'malformed', 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-host'));
          lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output', cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
          continue;
        }
        const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-host');
        written.push(writtenPath);
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        produced.push(evidence);
        continue;
      }
      if (runner !== 'local-command' || !command) {
        unavailable.push(`${lane}: no local-command runner command is configured.`);
        produced.push(blockedLane(lane, 'unavailable', 'No runnable local-command is configured for this lane.', 'missing local-command', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'unavailable', path, 'No runnable local-command is configured for this lane.', 'missing local-command', cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        continue;
      }
      if (input.dryRun) {
        lanes.push(plannedRun);
        continue;
      }
      const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
      const evidence = await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, 'local-command', plannedRun.promptStackHash, input.repoRoot, path, contextLines, publishCommand, input.exec, riskCardFragments);
      if (!evidence) {
        failed = true;
        produced.push(blockedLane(lane, 'malformed', 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output', command, issueNumber, input.prNumber, input.repoRoot, input.headSha, 'local-command'));
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output', cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
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
    opencode,
    modelTiers,
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
