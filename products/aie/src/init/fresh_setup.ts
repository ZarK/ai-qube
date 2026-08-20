import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveModelReviewPlan } from '../app/local_review_runner.js';
import type { Config, GateConfig } from '../config/index.js';
import {
  defaultFreshSetupLanes,
  FRESH_SETUP_ROUTE_MAX_TURNS,
  FRESH_SETUP_ROUTE_TIMEOUT_SECONDS,
} from '../config/fresh_setup_lanes.js';
import { REVIEW_MODEL_HOST_IDS, type ReviewFailoverPolicy, type ReviewMode, type ReviewModelHostId, type ReviewModelsPolicy, type ReviewRoutePolicy } from '../core/policy.js';
import { activeLocalReviewFocusesForConfig } from '../review_focus.js';
import { reviewModeOf } from '../review_mode.js';
import { isolatedReviewHostsOnMachine, recommendedManualUiAudit, recommendedQualityControl, recommendedReviewMode, type GuideMachine } from './questions.js';
import type { InitPolicyOptions } from './types.js';

export {
  defaultFreshSetupLanes,
  FRESH_SETUP_PERFORMANCE_MATCH,
  FRESH_SETUP_SECURITY_MATCH,
  FRESH_SETUP_UI_MATCH,
} from '../config/fresh_setup_lanes.js';

export type DetectedPackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface FreshSetupFirstPullRequestReadiness {
  ready: boolean;
  reasons: string[];
  activatedLanes: string[];
  reviewMode: ReviewMode;
  configIdentity: string;
}

export function detectPackageManager(repoRoot: string): DetectedPackageManager {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoRoot, 'bun.lockb')) || existsSync(join(repoRoot, 'bun.lock'))) return 'bun';
  return 'npm';
}

export function detectRepositoryQualityGate(repoRoot: string): GateConfig | null {
  const packagePath = join(repoRoot, 'package.json');
  if (!existsSync(packagePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(packagePath, 'utf8')) as { scripts?: Record<string, string> };
    const scripts = raw.scripts ?? {};
    const scriptName = ['test', 'verify', 'check'].find(name => typeof scripts[name] === 'string' && scripts[name].trim() !== '');
    if (!scriptName) return null;
    const packageManager = detectPackageManager(repoRoot);
    return {
      name: scriptName,
      kind: scriptName === 'test' ? 'unit' : 'custom',
      command: `${packageManager} run ${scriptName}`,
      stage: 'pre-pr',
      required: true,
      timeoutSeconds: 600,
      workingDirectory: '.',
      env: {},
      externalService: false,
    };
  } catch {
    return null;
  }
}

function firstInstalledHost(machine: GuideMachine): ReviewModelHostId | null {
  return isolatedReviewHostsOnMachine(machine)[0] ?? null;
}

function catalogOf(machine: GuideMachine, host: string): readonly string[] {
  return machine.liveModels?.[host as keyof NonNullable<GuideMachine['liveModels']>] ?? [];
}

function modelsFromMachine(machine: GuideMachine): ReviewModelsPolicy | undefined {
  const review: ReviewModelsPolicy['review'] = {};
  const economy: ReviewModelsPolicy['economy'] = {};
  for (const host of isolatedReviewHostsOnMachine(machine)) {
    const catalog = catalogOf(machine, host);
    if (catalog[0]) review[host] = { model: catalog[0], effort: null };
  }
  if (Object.keys(review).length === 0 && Object.keys(economy).length === 0) return undefined;
  return { review, economy, synthesis: {} };
}

export function defaultAiqLintFormatGate(): GateConfig {
  return {
    name: 'aiq',
    kind: 'aiq',
    command: 'qube aiq --up-to 2 --format json',
    stage: 'pre-pr',
    required: true,
    timeoutSeconds: 1200,
    workingDirectory: '.',
    env: {},
    externalService: false,
  };
}

function failoverFromMachine(machine: GuideMachine, primaryHost: string | undefined): ReviewFailoverPolicy | null {
  const secondary = isolatedReviewHostsOnMachine(machine).find(host => host !== primaryHost);
  if (!secondary) return null;
  const model = machine.liveModels?.[secondary]?.[0];
  if (!model) return null;
  return {
    faults: 1,
    route: {
      host: secondary,
      tier: 'review',
      timeoutSeconds: FRESH_SETUP_ROUTE_TIMEOUT_SECONDS,
      maxTurns: FRESH_SETUP_ROUTE_MAX_TURNS,
    },
  };
}

function isolatedRoute(machine: GuideMachine): ReviewRoutePolicy | null {
  const host = firstInstalledHost(machine);
  if (!host) return null;
  return {
    host,
    tier: 'review',
    timeoutSeconds: FRESH_SETUP_ROUTE_TIMEOUT_SECONDS,
    maxTurns: FRESH_SETUP_ROUTE_MAX_TURNS,
  };
}

export function applyFreshSetupPolicy(input: {
  policy: InitPolicyOptions;
  machine: GuideMachine;
  repoRoot: string | null;
  fromAdopted: boolean;
}): InitPolicyOptions {
  const next: InitPolicyOptions = { ...input.policy };
  if (!input.fromAdopted) {
    const mode = next.reviewMode ?? recommendedReviewMode(input.machine);
    next.reviewMode = mode;
    if (mode === 'isolated' || mode === 'host') {
      if (next.reviewAdapter === undefined) next.reviewAdapter = 'local';
      if (next.reviewProfile === undefined) next.reviewProfile = 'local-focused';
      if (next.reviewLanes === undefined) next.reviewLanes = defaultFreshSetupLanes(isolatedRoute(input.machine)?.host ?? null);
      if (next.reviewWaitMinutes === undefined) next.reviewWaitMinutes = 0;
      if (next.reviewAgents === undefined) next.reviewAgents = [];
      if (next.localReviewAgents === undefined) {
        next.localReviewAgents = mode === 'host' ? [...input.machine.installedHosts] : [];
      }
      if (mode === 'isolated') {
        if (next.reviewRoute === undefined) next.reviewRoute = isolatedRoute(input.machine);
        if (next.reviewModels === undefined) {
          const models = modelsFromMachine(input.machine);
          if (models) next.reviewModels = models;
        }
        if (next.reviewFailover === undefined) {
          const failover = failoverFromMachine(input.machine, next.reviewRoute?.host);
          if (failover) next.reviewFailover = failover;
        }
      } else if (next.reviewRoute === undefined) {
        next.reviewRoute = null;
      }
    } else {
      if (next.reviewAdapter === undefined) next.reviewAdapter = 'github';
      if (next.reviewProfile === undefined) next.reviewProfile = 'remote-compatible';
      if (next.reviewAgents === undefined) next.reviewAgents = [];
      if (next.reviewLanes === undefined) next.reviewLanes = [];
      if (next.reviewRoute === undefined) next.reviewRoute = null;
      if (next.localReviewAgents === undefined) next.localReviewAgents = [];
    }
    if (next.manualUiAudit === undefined) next.manualUiAudit = recommendedManualUiAudit(input.machine);
    if (next.qualityControl === undefined) next.qualityControl = recommendedQualityControl(input.machine);
  }
  if (next.gates === undefined && input.repoRoot) {
    const gates: GateConfig[] = [];
    const repoGate = detectRepositoryQualityGate(input.repoRoot);
    if (repoGate) gates.push(repoGate);
    if ((next.qualityControl ?? recommendedQualityControl(input.machine)) && input.machine.aiqAvailable) {
      gates.push(defaultAiqLintFormatGate());
    }
    if (gates.length > 0) next.gates = gates;
  }
  return next;
}

function configuredReviewModels(config: Config): string[] {
  return REVIEW_MODEL_HOST_IDS
    .map(host => config.reviewModels.review[host]?.model)
    .filter((model): model is string => typeof model === 'string' && model.trim() !== '');
}

export function freshSetupConfigIdentity(config: Pick<Config, 'reviewMode' | 'reviewAdapter' | 'reviewProfile' | 'reviewLanes' | 'reviewRoute' | 'reviewModels' | 'reviewSources'>): string {
  const models = REVIEW_MODEL_HOST_IDS.flatMap(host => {
    const model = config.reviewModels.review[host]?.model;
    return model ? [`${host}:${model}`] : [];
  });
  const lanes = config.reviewLanes.map(lane => `${lane.id}:${lane.required}:${lane.match.join(',')}`).join('|');
  const sources = config.reviewSources.map(source => `${source.id}:${source.identity}:${source.expected.join(',')}:${source.blocking}:${source.markers}:${source.enabled}`).join('|');
  return [
    config.reviewMode ?? 'inferred',
    config.reviewAdapter,
    config.reviewProfile,
    config.reviewRoute ? `${config.reviewRoute.host}:${config.reviewRoute.tier}` : 'none',
    models.join(','),
    lanes,
    sources,
  ].join(';');
}

export function freshSetupFirstPullRequestReadiness(config: Config, changedPaths: readonly string[]): FreshSetupFirstPullRequestReadiness {
  const reasons: string[] = [];
  const mode = reviewModeOf(config);
  if (mode !== 'isolated') reasons.push(`Review mode is ${mode}, not isolated.`);
  if (config.reviewAdapter !== 'local') reasons.push(`Review adapter is ${config.reviewAdapter}, not local.`);
  if (config.reviewProfile !== 'local-focused') reasons.push(`Review profile is ${config.reviewProfile}, not local-focused.`);
  const configuredAlways = new Set(config.reviewLanes.filter(lane => lane.required === 'always' && lane.optOut !== true).map(lane => lane.id));
  const laneSource = config.reviewSources.find(source => source.enabled && source.blocking && source.identity === 'lane');
  if (!configuredAlways.has('issue-compliance')) reasons.push('issue-compliance is not configured as an always-on lane.');
  if (!configuredAlways.has('code-quality')) reasons.push('code-quality is not configured as an always-on lane.');
  if (!laneSource) reasons.push('No enabled blocking lane review source is configured.');
  else {
    for (const lane of configuredAlways) if (!laneSource.expected.includes(lane)) reasons.push(`${lane} is missing from the blocking lane review source.`);
  }
  const activated = activeLocalReviewFocusesForConfig(config, changedPaths);
  if (configuredAlways.has('issue-compliance') && !activated.includes('issue-compliance')) reasons.push('issue-compliance is not activated for this change set.');
  if (configuredAlways.has('code-quality') && !activated.includes('code-quality')) reasons.push('code-quality is not activated for this change set.');
  for (const lane of ['issue-compliance', 'code-quality'] as const) {
    const plan = resolveModelReviewPlan(config, lane);
    if (!plan) reasons.push(`${lane} has no isolated model route.`);
    else if (!plan.model || plan.model.trim() === '') reasons.push(`${lane} has no validated review model.`);
  }
  if (configuredReviewModels(config).length === 0) reasons.push('No validated review model is configured.');
  return {
    ready: reasons.length === 0,
    reasons,
    activatedLanes: [...activated],
    reviewMode: mode,
    configIdentity: freshSetupConfigIdentity(config),
  };
}
