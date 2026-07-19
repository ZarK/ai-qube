import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config/index.js';
import type { ReviewLanePolicy, RoutedReviewHostId } from '../core/policy.js';
import { activeLocalReviewFocusesForConfig, defaultCarryForwardContext } from '../review_focus.js';
import { readCurrentHeadLaneEvidence, type LocalReviewLaneId, type LocalReviewProfile } from '../local_review_evidence.js';
import { acceptedProviderLane, type ProviderLaneReuse } from '../provider_lane_evidence.js';
import { renderAieCliPrefix } from '../init_content.js';
import type { PrGateExec } from './pr_gate.js';
import { formatRiskCardReviewerFragment, selectRiskCards } from '../risk_cards/index.js';
import { buildLocalReviewPublishCommand, buildLocalReviewSpawnContract, clearRouteFault, executableReviewCommandsTrusted, expectedLaneFragmentDigest, findCarryForwardSource, hash, laneContextLines, laneEvidencePath, promptStack, readRouteFaults, recordRouteFault, resolveReviewModelTier, riskCardCommandIdentity, runExternalLane, writeCarriedForwardLane, writeLane, writeTrustedRoutedProvenance, type LocalReviewSpawnContract, type ReviewModelTierResolution } from './local_review_runner_support.js';
import { ECONOMY_REVIEW_CATALOG } from '../review_catalog.js';
import { runModelReview, type ModelHostExecutable, type ModelReviewRoutePlan, type ModelRouteProcess } from './model_review_runner.js';
import { probeModelRoute, type RouteProbeCheck, type RoutedProbeHost } from './model_route_probe.js';
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
  route: ModelReviewRoutePlan | null;
  summary: string;
  blocker: string | null;
  evidenceSource: 'fresh-run' | 'local' | 'trusted-provider' | null;
}

export interface EconomyCatalogTierResolution {
  name: string;
  modelTier: 'economy';
  model: string | null;
  effort: string | null;
  substitution: string | null;
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
  economyCatalog: EconomyCatalogTierResolution[];
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
  modelRouteProcess?: ModelRouteProcess;
  resolveModelHost?: (host: RoutedReviewHostId) => Promise<ModelHostExecutable>;
  resolveModelHead?: (repoRoot: string) => Promise<string>;
  routeProbe?: (host: RoutedProbeHost, model: string | null) => RouteProbeCheck;
  providerLaneReuse?: ProviderLaneReuse;
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
  return lanePolicy(config, lane)?.runner ?? (config.reviewRoute ? 'local-host' : 'manual-evidence');
}

function laneCommand(config: Config, lane: LocalReviewLaneId): string | null {
  const command = lanePolicy(config, lane)?.command?.trim();
  return command && command !== '' ? command : null;
}

export function resolveModelReviewPlan(config: Config, lane: LocalReviewLaneId): ModelReviewRoutePlan | null {
  const policy = lanePolicy(config, lane);
  if (laneRunner(config, lane) !== 'local-host') return null;
  const route = policy?.route ?? config.reviewRoute;
  if (!route) return null;
  const binding = resolveReviewModelTier(config.reviewModels, route.tier, route.host);
  return {
    host: route.host,
    tier: route.tier,
    model: binding.model,
    effort: binding.effort as ModelReviewRoutePlan['effort'],
    isolation: 'read-only',
    timeoutSeconds: route.timeoutSeconds,
    maxTurns: route.maxTurns,
    substitution: binding.substitution,
  };
}

export function resolveFailoverReviewPlan(config: Config): ModelReviewRoutePlan | null {
  const failover = config.reviewFailover;
  if (!failover) return null;
  const binding = resolveReviewModelTier(config.reviewModels, failover.route.tier, failover.route.host);
  return {
    host: failover.route.host,
    tier: failover.route.tier,
    model: binding.model,
    effort: binding.effort as ModelReviewRoutePlan['effort'],
    isolation: 'read-only',
    timeoutSeconds: failover.route.timeoutSeconds,
    maxTurns: failover.route.maxTurns,
    substitution: binding.substitution,
  };
}

export function plannedReviewRouteTargets(config: Config): Array<{ host: RoutedProbeHost; model: string | null }> {
  const targets = new Map<string, { host: RoutedProbeHost; model: string | null }>();
  const addRoute = (plan: ModelReviewRoutePlan | null): void => {
    if (!plan) return;
    const key = `${plan.host}::${plan.model ?? ''}`;
    if (!targets.has(key)) targets.set(key, { host: plan.host, model: plan.model });
  };
  for (const lane of config.reviewLanes) addRoute(resolveModelReviewPlan(config, lane.id as LocalReviewLaneId));
  if (config.reviewRoute) {
    const binding = resolveReviewModelTier(config.reviewModels, config.reviewRoute.tier, config.reviewRoute.host);
    addRoute({ host: config.reviewRoute.host, tier: config.reviewRoute.tier, model: binding.model, effort: binding.effort as ModelReviewRoutePlan['effort'], isolation: 'read-only', timeoutSeconds: config.reviewRoute.timeoutSeconds, maxTurns: config.reviewRoute.maxTurns, substitution: binding.substitution });
  }
  addRoute(resolveFailoverReviewPlan(config));
  return [...targets.values()];
}

// Local checkout drift is not a host fault; every other route failure class
// (transport, timeout, auth, refusal, envelope, contract) counts toward failover.
const ROUTE_FAULT_EXEMPT_REASONS = new Set(['model-route-checkout-mismatch']);

interface RoutedLaneJob {
  laneSlot: number;
  host: string;
  lane: LocalReviewLaneId;
  issueNumber: number;
  route: ModelReviewRoutePlan;
  routeSource: 'configured' | 'fallback';
  primaryRoute: ModelReviewRoutePlan | null;
  /** Probe-time resolution reused at spawn so the executed CLI is the probed one. */
  probedExecutable: ModelHostExecutable | null;
  path: string;
  runner: ReviewLanePolicy['runner'];
  run: () => Promise<RoutedOutcome>;
}

// The identity covers every configured route parameter that changes execution
// meaning. A host-default model (model null) has no observable config identity;
// its runtime changes are caught by the catalog probe and verdict clearing.
export function reviewRouteKey(plan: ModelReviewRoutePlan | null): string {
  if (!plan) return '';
  return hash([plan.host, plan.model ?? '', plan.tier, plan.effort ?? '', String(plan.timeoutSeconds), String(plan.maxTurns)].join('|')).slice(0, 16);
}

function localAieCliPrefix(config: Config, repoRoot: string): string {
  const workspaceRunner = existsSync(join(repoRoot, 'products', 'aie', 'bin', 'run')) ? 'node products/aie/bin/run' : null;
  return renderAieCliPrefix(config, workspaceRunner);
}

function laneRun(repoRoot: string, issueNumber: number, prNumber: number, headSha: string, lane: LocalReviewLaneId, runner: ReviewLanePolicy['runner'], command: string | null, status: LocalReviewLaneRunStatus, evidencePath: string, summary: string, blocker: string | null, cliPrefix: string, contextLines: readonly string[], includePrompt: boolean, issueNumbers: readonly number[] = [issueNumber], evidencePaths: readonly string[] = [evidencePath], tierResolution?: ReviewModelTierResolution, riskCardFragments: readonly string[] = [], route: ModelReviewRoutePlan | null = null, renderPrompts = true): LocalReviewLaneRun {
  if (!renderPrompts) {
    // Trusted-provider reuse spawns nothing and validates no local evidence, so prompt
    // rendering and hashing would be dead work for the reused lane.
    return {
      issueNumber,
      issueNumbers: [...issueNumbers],
      lane,
      runner,
      command,
      status,
      evidencePath,
      evidencePaths: [...evidencePaths],
      promptFragmentIds: [],
      promptStackHash: '',
      promptText: '',
      promptOutputContract: '',
      spawnPrompt: '',
      spawnContract: null,
      route,
      summary,
      blocker,
      evidenceSource: status === 'unavailable' || status === 'failed' ? null : 'fresh-run',
    };
  }
  const publishCommand = buildLocalReviewPublishCommand(cliPrefix, prNumber, lane, issueNumber);
  // Risk-card reviewer faces are part of both rendered and stable stacks so promptStackHash tracks activation.
  const rendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, contextLines, repoRoot, publishCommand), riskCardFragments);
  const stableRendered = promptStack(lane, laneContextLines(lane, issueNumbers, prNumber, headSha, evidencePaths, [], repoRoot, publishCommand), riskCardFragments);
  const promptStackHash = hash(stableRendered.text);
  const promptText = includePrompt ? rendered.text : '';
  const spawnContract = includePrompt && runner === 'local-host' && route === null && promptText.trim() !== ''
    ? buildLocalReviewSpawnContract({ hostAgentType: 'qube-review-focus', lane, issueNumber, prNumber, headSha, promptStackHash, promptText, publishCommand, modelTier: 'review', tierResolution })
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
    route,
    summary,
    blocker,
    evidenceSource: status === 'unavailable' || status === 'failed' ? null : 'fresh-run',
  };
}

function codexSubagentSummary(lane: LocalReviewLaneId, issueNumber: number, linkedIssueNumbers: readonly number[], prNumber: number, headSha: string, evidencePath: string, publishCommand: string): string {
  return `Create the review session lock, spawn one independent Codex subagent with agent_type qube-review-focus and fork_context false. Paste each lane spawnPrompt from pr gate --dry-run --json --local-review-prompts verbatim as the subagent task prompt; never reference .qube/aie/reviews/.../prompts/ files. Review focus ${lane} for issue #${issueNumber} and PR #${prNumber} at head ${headSha}. Linked issues for PR context: ${linkedIssueNumbers.map(linkedIssueNumber => `#${linkedIssueNumber}`).join(', ')}. Run pending review focuses in parallel when the host supports it. Each subagent must publish its lane review to the pull request with \`${publishCommand}\`. Wait for all subagents, delete the review session lock, rerun pr gate, and treat provider PR reviews/comments as the merge gate; local audit JSON at ${evidencePath} is optional.`;
}

// Exact-head reuse mirrors the evidence gate's precedence exactly: a present
// local evidence file always owns the lane (terminal states reuse, non-terminal
// states re-execute), and trusted provider markers apply only when no local file
// exists. Any divergence here would let the runner skip a lane the gate then
// reads differently.
function reuseLaneRun(config: Config, input: LocalReviewRunnerInput, lane: LocalReviewLaneId, issueNumber: number, runner: ReviewLanePolicy['runner'], command: string | null, path: string, cliPrefix: string, contextLines: readonly string[], includePrompt: boolean, linkedIssueNumbers: readonly number[], riskCardFragments: readonly string[], route: ModelReviewRoutePlan | null): LocalReviewLaneRun | null {
  if (existsSync(path)) {
    const localLane = readCurrentHeadLaneEvidence(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
    if (localLane && (localLane.status === 'passed' || localLane.status === 'failed' || localLane.status === 'needs-work')) {
      const summary = `Existing current-head lane evidence (${localLane.status}) reused; no reviewer execution required.`;
      return { ...laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, input.dryRun ? 'skipped' : 'completed', path, summary, null, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, [path], undefined, riskCardFragments, route), evidenceSource: 'local' };
    }
    return null;
  }
  const providerLane = acceptedProviderLane(input.providerLaneReuse, lane, issueNumber);
  if (providerLane) {
    const summary = `Trusted provider current-head review reused (${providerLane.recommendation}/${providerLane.status}); no reviewer execution required and no local evidence was fabricated.`;
    return { ...laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'skipped', path, summary, null, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, [path], undefined, riskCardFragments, route, false), evidenceSource: 'trusted-provider' };
  }
  return null;
}

async function carryForwardLaneRun(config: Config, input: LocalReviewRunnerInput, lane: LocalReviewLaneId, issueNumber: number, runner: ReviewLanePolicy['runner'], command: string | null, path: string, cliPrefix: string, contextLines: readonly string[], linkedIssueNumbers: readonly number[], written: string[], riskCardFragments: readonly string[] = []): Promise<LocalReviewLaneRun | null> {
  if (runner !== 'local-host' && runner !== 'local-command') return null;
  const lanePolicy = config.reviewLanes.find(entry => entry.id === lane);
  if ((lanePolicy?.rereview ?? defaultRereviewMode(lane)) !== 'delta') return null;
  const contextPatterns = [...config.reviewContextSources.instructions, ...config.reviewContextSources.requirements];
  // Risk cards can activate from issue text without a git delta. Carry forward only when the prior
  // evidence recorded the same command-supplied risk-card fragment identity as the current head.
  const source = await findCarryForwardSource({
    repoRoot: input.repoRoot,
    issueNumber,
    prNumber: input.prNumber,
    headSha: input.headSha,
    lane,
    matchPatterns: lanePolicy?.match ?? [],
    contextPatterns,
    contextMode: lanePolicy?.carryForwardContext ?? defaultCarryForwardContext(lane),
    expectedFragmentDigest: expectedLaneFragmentDigest(lane),
    expectedCommandSuppliedIdentity: riskCardCommandIdentity(riskCardFragments),
    expectedAdapter: runner,
    requiredCommand: command,
  });
  if (!source) return null;
  if (input.dryRun) {
    return { ...laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'skipped', path, `Carry-forward planned from approved review at ${source.fromHeadSha}; the PR gate records carried evidence without spawning a reviewer (${source.deltaSummary}).`, null, cliPrefix, contextLines, false, linkedIssueNumbers, [path], undefined, riskCardFragments), evidenceSource: 'local' };
  }
  const writtenPath = writeCarriedForwardLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, source);
  if (!writtenPath) return null;
  written.push(writtenPath);
  return { ...laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, `Carried forward from approved review at ${source.fromHeadSha} (${source.deltaSummary}).`, null, cliPrefix, contextLines, false, linkedIssueNumbers, [path], undefined, riskCardFragments), evidenceSource: 'local' };
}

// Two concurrent sessions per host keep host-level caches and rate limits safe
// while still overlapping slow model calls; the global bound is the tuning surface.
const PER_HOST_ROUTE_LIMIT = 2;

type RoutedOutcome = Awaited<ReturnType<typeof runModelReview>>;

async function executeRoutedJobs(jobs: ReadonlyArray<{ host: string; run: () => Promise<RoutedOutcome> }>, globalLimit: number): Promise<Array<RoutedOutcome | null>> {
  const results: Array<RoutedOutcome | null> = new Array(jobs.length).fill(null);
  const queue = jobs.map((job, index) => ({ job, index }));
  const hostActive = new Map<string, number>();
  let active = 0;
  await new Promise<void>(resolveAll => {
    const maybeStart = (): void => {
      for (let position = 0; position < queue.length;) {
        const { job, index } = queue[position];
        const hostCount = hostActive.get(job.host) ?? 0;
        if (active >= Math.max(1, globalLimit) || hostCount >= PER_HOST_ROUTE_LIMIT) {
          position += 1;
          continue;
        }
        queue.splice(position, 1);
        active += 1;
        hostActive.set(job.host, hostCount + 1);
        void job.run()
          .then(outcome => { results[index] = outcome; })
          .catch((error: unknown) => { results[index] = { evidence: null, reasonCode: 'model-route-unavailable', error: error instanceof Error ? error.message : String(error) } as RoutedOutcome; })
          .finally(() => {
            active -= 1;
            hostActive.set(job.host, (hostActive.get(job.host) ?? 1) - 1);
            maybeStart();
          });
      }
      if (queue.length === 0 && active === 0) resolveAll();
    };
    maybeStart();
  });
  return results;
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
  const activatedRiskCards = selectRiskCards({
    issueText: input.riskCardIssueText ?? '',
    paths: input.changedPaths ?? [],
  });
  const riskCardFragments = activatedRiskCards.map(card => formatRiskCardReviewerFragment(card));
  const riskCardCoverageAreas = activatedRiskCards.map(card => card.id);
  const includePrompt = input.includePrompts === true;
  const cliPrefix = localAieCliPrefix(config, input.repoRoot);
  const modelTiers = {
    review: resolveReviewModelTier(config.reviewModels, 'review', 'codex'),
    economy: resolveReviewModelTier(config.reviewModels, 'economy', 'codex'),
    synthesis: resolveReviewModelTier(config.reviewModels, 'synthesis', 'codex'),
  };
  const economyCatalog: EconomyCatalogTierResolution[] = ECONOMY_REVIEW_CATALOG.map(agent => ({
    name: agent.name,
    modelTier: 'economy',
    model: modelTiers.economy.model,
    effort: modelTiers.economy.effort,
    substitution: modelTiers.economy.substitution,
  }));
  if (!input.required && !input.shadow) {
    return { required: false, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'disabled', evidenceRoot, codex, opencode, modelTiers, economyCatalog, lanes: [], written: [], unavailable: [], summary: 'Local review runner is disabled by the selected review adapter.' };
  }
  if (input.issueNumbers.length === 0 || requiredLanes.length === 0) {
    return { required: input.required, dryRun: input.dryRun, profile, prNumber: input.prNumber, headSha: input.headSha, status: 'pending', evidenceRoot, codex, opencode, modelTiers, economyCatalog, lanes: [], written: [], unavailable: ['No linked issue or required local review lanes were available.'], summary: 'Local review runner could not plan lanes without a linked issue and required lane set.' };
  }

  const lanes: LocalReviewLaneRun[] = [];
  const written: string[] = [];
  const unavailable: string[] = [];
  const routedJobs: RoutedLaneJob[] = [];
  const reviewTierResolution = modelTiers.review;
  let failed = false;
  const commandTrust = await executableReviewCommandsTrusted(input.repoRoot, `${config.baseRemote}/${config.baseBranch}`);
  const commandlessHostLanes = new Set(requiredLanes.filter(lane => laneRunner(config, lane) === 'local-host' && !laneCommand(config, lane) && !resolveModelReviewPlan(config, lane)));

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
      const reused = reuseLaneRun(config, input, lane, issueNumber, 'local-host', null, path, cliPrefix, contextLines, includePrompt, linkedIssueNumbers, riskCardFragments, null);
      if (reused) {
        lanes.push(reused);
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
    for (const lane of requiredLanes) {
      if (commandlessHostLanes.has(lane)) continue;
      const path = laneEvidencePath(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane);
      const runner = laneRunner(config, lane);
      const command = laneCommand(config, lane);
      const configuredRoute = resolveModelReviewPlan(config, lane);
      let route = configuredRoute;
      let routeSource: 'configured' | 'fallback' = 'configured';
      if (configuredRoute && config.reviewFailover) {
        // A tally only applies while the lane's primary route identity is
        // unchanged; a route config change restarts the count and retests the
        // current primary before failover engages again.
        const faultRecord = readRouteFaults(input.repoRoot, issueNumber, input.prNumber).lanes[lane];
        const laneFaults = faultRecord && faultRecord.routeKey === reviewRouteKey(configuredRoute) ? faultRecord.count : 0;
        const fallbackPlan = laneFaults >= config.reviewFailover.faults ? resolveFailoverReviewPlan(config) : null;
        if (fallbackPlan) {
          route = fallbackPlan;
          routeSource = 'fallback';
        }
      }
      const plannedSummary = route
        ? `${route.host} model route would run ${route.model ?? 'the host default model'} in read-only isolation and write current-head evidence.${routeSource === 'fallback' ? ' This lane reached the configured host-fault threshold and executes through the fallback route.' : ''}`
        : runner === 'local-host' ? 'Codex local-host lane would run and write current-head evidence.' : 'Local-command lane would run and write current-head evidence.';
      const plannedRun = laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'planned', path, plannedSummary, null, cliPrefix, contextLines, includePrompt, [issueNumber], [path], route ? { model: route.model, effort: route.effort, substitution: route.substitution } : reviewTierResolution, riskCardFragments, route);
      if (!input.dryRun && command && !commandTrust) {
        const summary = 'Executable local review command is unavailable because review runner configuration changed outside the trusted base.';
        const blocker = 'review runner command is not trusted for current PR head';
        unavailable.push(`${lane}: ${summary}`);
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'unavailable', path, summary, blocker, cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        continue;
      }
      const reused = reuseLaneRun(config, input, lane, issueNumber, runner, command, path, cliPrefix, contextLines, includePrompt, [issueNumber], riskCardFragments, route);
      if (reused) {
        lanes.push(reused);
        continue;
      }
      const carried = await carryForwardLaneRun(config, input, lane, issueNumber, runner, command, path, cliPrefix, contextLines, [issueNumber], written, riskCardFragments);
      if (carried) {
        lanes.push(carried);
        continue;
      }
      if (runner === 'local-host') {
        if (route) {
          if (input.dryRun) {
            lanes.push(plannedRun);
            continue;
          }
          const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
          const rendered = promptStack(lane, laneContextLines(lane, [issueNumber], input.prNumber, input.headSha, [path], contextLines, input.repoRoot, publishCommand), riskCardFragments);
          // Defer execution to the bounded pool; the placeholder keeps the lane's
          // deterministic position and is replaced in the serial completion phase.
          // The job reads route and routeSource at execution time so the probe
          // phase can retry the configured primary when the fallback is blocked.
          const jobLane = lane;
          const jobIssueNumber = issueNumber;
          const jobPromptStackHash = plannedRun.promptStackHash;
          const job: RoutedLaneJob = {
            laneSlot: lanes.length,
            host: route.host,
            lane: jobLane,
            issueNumber: jobIssueNumber,
            route,
            routeSource,
            primaryRoute: configuredRoute,
            probedExecutable: null,
            path,
            runner,
            run: () => runModelReview({
              plan: job.route,
              repoRoot: input.repoRoot,
              lane: jobLane,
              issueNumber: jobIssueNumber,
              prNumber: input.prNumber,
              headSha: input.headSha,
              profile,
              promptStackHash: jobPromptStackHash,
              promptText: rendered.text,
              promptStack: rendered.promptStack.map(fragment => ({ id: fragment.id, source: fragment.source, sourceCategory: fragment.sourceCategory, path: fragment.path, sha256: fragment.sha256, trust: fragment.trust })),
              coverageAreas: riskCardCoverageAreas,
              routeSource: job.routeSource,
              // The probed resolution is reused at spawn time so the executed
              // CLI is exactly the one the probe verified; an injected resolver
              // never overrides a probe-bound executable.
              resolveExecutable: job.probedExecutable !== null ? async () => job.probedExecutable! : input.resolveModelHost,
              resolveHead: input.resolveModelHead,
              runProcess: input.modelRouteProcess,
            }),
          };
          routedJobs.push(job);
          lanes.push(plannedRun);
          continue;
        }
        if (!command) continue;
        if (input.dryRun) {
          lanes.push(plannedRun);
          continue;
        }
        const publishCommand = buildLocalReviewPublishCommand(cliPrefix, input.prNumber, lane, issueNumber);
        const evidence = await runExternalLane(command, lane, issueNumber, input.prNumber, input.headSha, profile, 'local-host', plannedRun.promptStackHash, input.repoRoot, path, contextLines, publishCommand, input.exec, riskCardFragments);
        if (!evidence) {
          failed = true;
          lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Codex local-host output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-host output', cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
          continue;
        }
        const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-host');
        written.push(writtenPath);
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        continue;
      }
      if (runner !== 'local-command' || !command) {
        unavailable.push(`${lane}: no local-command runner command is configured.`);
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
        lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'failed', path, 'Local-command output was unavailable, non-zero, malformed, stale, or for the wrong lane.', 'invalid local-command output', cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
        continue;
      }
      const writtenPath = writeLane(input.repoRoot, issueNumber, input.prNumber, input.headSha, profile, evidence, 'local-command');
      written.push(writtenPath);
      lanes.push(laneRun(input.repoRoot, issueNumber, input.prNumber, input.headSha, lane, runner, command, 'completed', path, evidence.summary, evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt, [issueNumber], [path], undefined, riskCardFragments));
    }
  }

  let runnableJobs = routedJobs;
  if (routedJobs.length > 0 && !input.dryRun) {
    // Every distinct route passes a cheap read-only host probe before any model
    // execution; a failed probe blocks its lanes with the probe diagnostic. A
    // missing probe result fails closed instead of admitting the job.
    const probe = input.routeProbe ?? probeModelRoute;
    const probeChecks = new Map<string, RouteProbeCheck>();
    const probeFor = (plan: ModelReviewRoutePlan): RouteProbeCheck | undefined => {
      const key = `${plan.host}::${plan.model ?? ''}`;
      if (!probeChecks.has(key)) {
        try {
          probeChecks.set(key, probe(plan.host, plan.model));
        } catch {
          // A probe crash is indistinguishable from an unusable host; the
          // fail-closed path below blocks the route.
        }
      }
      return probeChecks.get(key);
    };
    runnableJobs = [];
    for (const job of routedJobs) {
      const check = probeFor(job.route);
      if (check?.status === 'ready') {
        job.probedExecutable = check.resolved ?? null;
        runnableJobs.push(job);
        continue;
      }
      // A blocked fallback route must not strand the lane: retry the configured
      // primary route when its own probe is ready instead of going unavailable.
      if (job.routeSource === 'fallback' && job.primaryRoute) {
        const primaryCheck = probeFor(job.primaryRoute);
        if (primaryCheck?.status === 'ready') {
          job.route = job.primaryRoute;
          job.routeSource = 'configured';
          job.host = job.primaryRoute.host;
          job.probedExecutable = primaryCheck.resolved ?? null;
          runnableJobs.push(job);
          continue;
        }
      }
      // A blocked primary probe is itself a host fault: persistent breakage
      // (dead auth, broken CLI, missing catalog) must accumulate toward the
      // failover threshold and engage the fallback in the same run once met.
      if (job.routeSource === 'configured') {
        const faultCount = recordRouteFault(input.repoRoot, job.issueNumber, input.prNumber, job.lane, 'model-route-probe-blocked', reviewRouteKey(job.primaryRoute ?? job.route));
        if (config.reviewFailover && faultCount >= config.reviewFailover.faults) {
          const fallbackPlan = resolveFailoverReviewPlan(config);
          if (fallbackPlan) {
            const fallbackCheck = probeFor(fallbackPlan);
            if (fallbackCheck?.status === 'ready') {
              job.route = fallbackPlan;
              job.routeSource = 'fallback';
              job.host = fallbackPlan.host;
              job.probedExecutable = fallbackCheck.resolved ?? null;
              runnableJobs.push(job);
              continue;
            }
          }
        }
      }
      const summary = check?.diagnostic ?? `${job.route.host} route probe returned no result; the route is blocked before model execution.`;
      unavailable.push(`${job.lane}: ${summary}`);
      lanes[job.laneSlot] = laneRun(input.repoRoot, job.issueNumber, input.prNumber, input.headSha, job.lane, job.runner, null, 'unavailable', job.path, summary, 'model-route-probe-blocked', cliPrefix, contextLines, includePrompt, [job.issueNumber], [job.path], undefined, riskCardFragments, job.route);
    }
  }
  if (runnableJobs.length > 0) {
    const outcomes = await executeRoutedJobs(runnableJobs.map(job => ({ host: job.host, run: job.run })), config.reviewConcurrency ?? 3);
    // Serial completion phase: evidence and provenance writes happen one at a
    // time in planning order, regardless of concurrent completion order.
    runnableJobs.forEach((job, jobIndex) => {
      const routed = outcomes[jobIndex];
      if (!routed || !routed.evidence) {
        failed = true;
        const reasonCode = routed?.reasonCode ?? 'invalid model route output';
        const summary = (routed?.error ?? '').trim() || `Routed model review failed (${reasonCode}).`;
        if (!ROUTE_FAULT_EXEMPT_REASONS.has(reasonCode)) {
          // Faults tally against the lane's configured primary route identity,
          // so fallback-run faults keep the failover engaged until a verdict.
          recordRouteFault(input.repoRoot, job.issueNumber, input.prNumber, job.lane, reasonCode, reviewRouteKey(job.primaryRoute ?? job.route));
        }
        lanes[job.laneSlot] = laneRun(input.repoRoot, job.issueNumber, input.prNumber, input.headSha, job.lane, job.runner, null, 'failed', job.path, summary, reasonCode, cliPrefix, contextLines, includePrompt, [job.issueNumber], [job.path], undefined, riskCardFragments, job.route);
        return;
      }
      // Any valid completed verdict clears the lane's host-fault tally; review
      // verdicts are evidence, never faults, and never advance failover.
      clearRouteFault(input.repoRoot, job.issueNumber, input.prNumber, job.lane);
      const writtenPath = writeLane(input.repoRoot, job.issueNumber, input.prNumber, input.headSha, profile, routed.evidence, 'local-host');
      const provenancePath = writeTrustedRoutedProvenance(input.repoRoot, job.issueNumber, input.prNumber, input.headSha, routed.evidence);
      written.push(writtenPath);
      if (provenancePath) written.push(provenancePath);
      lanes[job.laneSlot] = laneRun(input.repoRoot, job.issueNumber, input.prNumber, input.headSha, job.lane, job.runner, null, 'completed', job.path, routed.evidence.summary, routed.evidence.blockers[0] ?? null, cliPrefix, contextLines, includePrompt, [job.issueNumber], [job.path], undefined, riskCardFragments, job.route);
    });
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
    economyCatalog,
    lanes,
    written,
    unavailable,
    summary: status === 'completed'
      ? `Local review runner wrote ${written.length} lane evidence file(s).${lanes.some(lane => lane.evidenceSource === 'local' && lane.status === 'completed') ? ` Reused existing current-head local evidence for: ${lanes.filter(lane => lane.evidenceSource === 'local' && lane.status === 'completed').map(lane => lane.lane).join(', ')}.` : ''}${lanes.some(lane => lane.evidenceSource === 'trusted-provider') ? ` Reused trusted provider current-head reviews for: ${lanes.filter(lane => lane.evidenceSource === 'trusted-provider').map(lane => lane.lane).join(', ')}.` : ''}`
      : status === 'pending'
        ? `Local review runner is waiting for ${lanes.filter(lane => lane.status === 'pending').length} independent Codex subagent review lane(s). Run them in parallel when the host supports it.`
      : status === 'planned'
        ? `Local review runner planned ${lanes.filter(lane => lane.status === 'planned' || lane.status === 'pending').length} lane execution(s); ${lanes.filter(lane => lane.status === 'skipped').length} lane(s) reuse existing current-head evidence.`
      : status === 'failed'
        ? `Local review runner failed ${lanes.filter(lane => lane.status === 'failed').length} lane(s): ${lanes.filter(lane => lane.status === 'failed').map(lane => `${lane.lane}: ${lane.summary}`).join('; ')}`
        : `Local review runner could not complete all required lanes: ${unavailable.join('; ')}`,
  };
}
