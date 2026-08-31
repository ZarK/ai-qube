import { execFileSync } from 'child_process';
import { existsSync, statfsSync } from 'fs';
import { join, relative } from 'path';
import { AGENT_HOST_IDS, getAgentHostCapabilityProfile, observeAgentHostReadiness, type AgentHostId } from '@tjalve/qube-core';
import type { Config } from '../config/index.js';
import { plannedReviewRouteChains, plannedReviewRouteTargets, selectProbedReviewRoute } from '../app/local_review_runner.js';
import type { LocalReviewLaneId } from '../local_review_evidence.js';
import { probeModelRoute, type RouteProbeCheck, type RoutedProbeHost } from '../app/model_route_probe.js';
import type { DoctorReadinessStatus, GateReadinessDiagnostics } from './types.js';
import type { GitHubReadiness } from '../providers/github_adapter_exports.js';

const LOW_DISK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
const HIGH_LOOSE_OBJECT_THRESHOLD = 50000;
const GIT_COUNT_OBJECTS_TIMEOUT_MS = 5000;
const GIT_COUNT_OBJECTS_MAX_BUFFER = 1024 * 1024;

type ReviewPreflightDiagnostics = GateReadinessDiagnostics['reviewPreflight'];

export interface ReviewPreflightOptions {
  repoRoot: string;
  statfs?: (path: string) => { bavail?: number | bigint; bfree: number | bigint; bsize: number | bigint };
  gitCountObjects?: (repoRoot: string) => string;
  githubReadiness?: GitHubReadiness;
  probeRoute?: (host: RoutedProbeHost, model: string | null) => RouteProbeCheck;
  requiredLanes?: readonly LocalReviewLaneId[];
}

function localReviewEnabled(config: Config): boolean {
  return config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed' || config.reviewAdapter === 'shadow';
}

function disabledPreflight(): ReviewPreflightDiagnostics {
  return {
    enabled: false,
    readiness: 'disabled',
    hostReadiness: [],
    checks: {
      disk: { readiness: 'disabled', freeBytes: null, thresholdBytes: LOW_DISK_THRESHOLD_BYTES, nextAction: null },
      dist: { readiness: 'disabled', path: 'products/aie/dist/bin/run.js', present: false, nextAction: null },
      gitObjects: { readiness: 'disabled', looseCount: null, threshold: HIGH_LOOSE_OBJECT_THRESHOLD, nextAction: null },
      githubReviewAuth: { readiness: 'disabled', authenticated: false, scopes: null, nextAction: null },
      routeProbes: { readiness: 'disabled', routes: [], chains: [], nextAction: null },
    },
    nextActions: [],
  };
}

function countLooseObjects(output: string): number | null {
  const match = /^count:\s*(\d+)/m.exec(output);
  return match ? Number(match[1]) : null;
}

function overallStatus(statuses: DoctorReadinessStatus[]): DoctorReadinessStatus {
  if (statuses.includes('missing')) return 'missing';
  if (statuses.includes('needs-action')) return 'needs-action';
  if (statuses.includes('unavailable')) return 'unavailable';
  return 'ready';
}

export function buildReviewPreflightDiagnostics(config: Config, options: ReviewPreflightOptions): ReviewPreflightDiagnostics {
  if (!localReviewEnabled(config)) return disabledPreflight();

  const nextActions: string[] = [];
  const statfs = options.statfs ?? statfsSync;
  const gitCountObjects = options.gitCountObjects ?? ((repoRoot: string) => execFileSync('git', ['count-objects', '-v'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GIT_COUNT_OBJECTS_MAX_BUFFER,
    timeout: GIT_COUNT_OBJECTS_TIMEOUT_MS,
  }));

  let disk: ReviewPreflightDiagnostics['checks']['disk'];
  try {
    const stats = statfs(options.repoRoot);
    const freeBlocks = stats.bavail ?? stats.bfree;
    const freeBytes = Number(freeBlocks) * Number(stats.bsize);
    const nextAction = freeBytes < LOW_DISK_THRESHOLD_BYTES
      ? 'Free disk space before spawning local review lanes; keep at least 2 GiB available for build output and local review evidence.'
      : null;
    if (nextAction) nextActions.push(nextAction);
    disk = {
      readiness: nextAction ? 'needs-action' : 'ready',
      freeBytes,
      thresholdBytes: LOW_DISK_THRESHOLD_BYTES,
      nextAction,
    };
  } catch {
    const nextAction = 'Review-preflight could not read free disk space; check filesystem access before spawning local review lanes.';
    nextActions.push(nextAction);
    disk = { readiness: 'unavailable', freeBytes: null, thresholdBytes: LOW_DISK_THRESHOLD_BYTES, nextAction };
  }

  const distPath = join(options.repoRoot, 'products', 'aie', 'dist', 'bin', 'run.js');
  const distPresent = existsSync(distPath);
  const distNextAction = distPresent ? null : 'Build AIE before publishing local review lanes: run `pnpm --filter @tjalve/aie run build`.';
  if (distNextAction) nextActions.push(distNextAction);
  const dist = {
    readiness: distPresent ? 'ready' as const : 'missing' as const,
    path: relative(options.repoRoot, distPath).replace(/\\/g, '/'),
    present: distPresent,
    nextAction: distNextAction,
  };

  let gitObjects: ReviewPreflightDiagnostics['checks']['gitObjects'];
  try {
    const looseCount = countLooseObjects(gitCountObjects(options.repoRoot));
    const nextAction = looseCount === null
      ? 'Review-preflight could not parse loose git object count; verify git output from `git count-objects -v` before spawning local review lanes.'
      : looseCount >= HIGH_LOOSE_OBJECT_THRESHOLD
        ? 'Loose git object count is high; run git housekeeping such as `git gc --prune=now` when no review or merge operation is active.'
        : null;
    if (nextAction) nextActions.push(nextAction);
    gitObjects = {
      readiness: looseCount === null ? 'unavailable' : nextAction ? 'needs-action' : 'ready',
      looseCount,
      threshold: HIGH_LOOSE_OBJECT_THRESHOLD,
      nextAction,
    };
  } catch {
    const nextAction = 'Review-preflight could not inspect loose git objects; verify git is available and the repository is readable.';
    nextActions.push(nextAction);
    gitObjects = { readiness: 'unavailable', looseCount: null, threshold: HIGH_LOOSE_OBJECT_THRESHOLD, nextAction };
  }

  const github = options.githubReadiness;
  const githubNextAction = github?.nextAction ?? 'Run `aie doctor --json` to evaluate GitHub review publication readiness.';
  const githubReviewAuth: ReviewPreflightDiagnostics['checks']['githubReviewAuth'] = !github || github.status === 'needs-action'
    ? {
      readiness: github?.reasonCode === 'missing-cli' ? 'missing' : 'unavailable',
      authenticated: false,
      scopes: null,
      nextAction: githubNextAction,
    }
    : github.status === 'not-required'
      ? { readiness: 'disabled', authenticated: false, scopes: null, nextAction: null }
      : github.status === 'unverified'
        ? github.cliVersion && github.host && github.repository
          ? { readiness: 'ready', authenticated: true, scopes: null, nextAction: null }
          : { readiness: 'unavailable', authenticated: false, scopes: null, nextAction: githubNextAction }
        : { readiness: 'ready', authenticated: true, scopes: null, nextAction: null };
  if (githubReviewAuth.nextAction) nextActions.push(githubReviewAuth.nextAction);

  let routeProbes: ReviewPreflightDiagnostics['checks']['routeProbes'];
  const routeTargets = plannedReviewRouteTargets(config);
  if (routeTargets.length === 0) {
    routeProbes = { readiness: 'disabled', routes: [], chains: [], nextAction: null };
  } else {
    const probeRoute = options.probeRoute ?? probeModelRoute;
    const routes = routeTargets.map(target => {
      try {
        const check = probeRoute(target.host, target.model);
        return {
          host: check.host,
          model: check.model,
          status: check.status,
          executable: check.executable,
          version: check.version,
          modelListed: check.modelListed,
          reasonCode: check.reasonCode ?? null,
          transport: check.transport ?? null,
          resolvedModel: check.resolvedModel ?? null,
          availableModels: [...(check.availableModels ?? [])],
          nextAction: check.diagnostic,
        };
      } catch (error: unknown) {
        return {
          host: target.host,
          model: target.model,
          status: 'blocked' as const,
          executable: null,
          version: null,
          modelListed: null,
          reasonCode: 'model-route-probe-blocked',
          transport: null,
          resolvedModel: null,
          availableModels: [],
          nextAction: `Route probe for ${target.host} failed unexpectedly: ${(error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0]}`,
        };
      }
    });
    const checksByRoute = new Map(routes.map(route => [`${route.host}::${route.model ?? ''}`, route]));
    const requiredLanes = options.requiredLanes ? new Set(options.requiredLanes) : null;
    const chains = plannedReviewRouteChains(config).map(chain => {
      const preferred = { host: chain.preferredRoute.host, model: chain.preferredRoute.model };
      const fallback = chain.fallbackRoute ? { host: chain.fallbackRoute.host, model: chain.fallbackRoute.model } : null;
      const preferredCheck = checksByRoute.get(`${preferred.host}::${preferred.model ?? ''}`);
      const fallbackCheck = fallback ? checksByRoute.get(`${fallback.host}::${fallback.model ?? ''}`) : null;
      const selection = selectProbedReviewRoute(
        chain.preferredRoute,
        chain.fallbackRoute,
        preferredCheck?.status === 'ready',
        fallbackCheck?.status === 'ready',
        preferredCheck?.reasonCode ?? undefined,
      );
      const selectedRoute = selection.route
        ? { host: selection.route.host, model: selection.route.model }
        : null;
      return {
        lane: chain.lane,
        required: chain.lane === null || requiredLanes === null || requiredLanes.has(chain.lane),
        readiness: selectedRoute ? 'ready' as const : 'blocked' as const,
        preferredRoute: preferred,
        fallbackRoute: fallback,
        selectedRoute,
        substitution: selection.source === 'fallback' ? selection.route?.substitution ?? null : null,
      };
    });
    const blockedChains = chains.filter(chain => chain.required && chain.readiness === 'blocked');
    const nextAction = blockedChains.length > 0
      ? `Fix ${blockedChains.length} blocked required review route chain(s) before running routed review lanes; each unavailable route reports its own action.`
      : null;
    if (nextAction) nextActions.push(nextAction);
    for (const chain of blockedChains) {
      for (const route of [chain.preferredRoute, chain.fallbackRoute]) {
        if (!route) continue;
        const action = checksByRoute.get(`${route.host}::${route.model ?? ''}`)?.nextAction;
        if (action && !nextActions.includes(action)) nextActions.push(action);
      }
    }
    routeProbes = {
      readiness: blockedChains.length > 0 ? 'needs-action' : 'ready',
      routes,
      chains,
      nextAction,
    };
  }

  const selectedHosts = new Set<AgentHostId>();
  for (const host of [...config.localReviewAgents, ...routeTargets.map((target) => target.host)]) {
    if (AGENT_HOST_IDS.includes(host as AgentHostId)) selectedHosts.add(host as AgentHostId);
  }
  const hostReadiness = [...selectedHosts].map((host) => observeAgentHostReadiness(getAgentHostCapabilityProfile(host)));

  return {
    enabled: true,
    readiness: overallStatus([disk.readiness, dist.readiness, gitObjects.readiness, githubReviewAuth.readiness, ...(routeProbes.readiness === 'disabled' ? [] : [routeProbes.readiness])]),
    hostReadiness,
    checks: { disk, dist, gitObjects, githubReviewAuth, routeProbes },
    nextActions,
  };
}
