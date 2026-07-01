import { execFileSync } from 'child_process';
import { existsSync, statfsSync } from 'fs';
import { join, relative } from 'path';
import type { Config } from '../config/index.js';
import type { DoctorReadinessStatus, GateReadinessDiagnostics } from './types.js';

const LOW_DISK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
const HIGH_LOOSE_OBJECT_THRESHOLD = 50000;
const GIT_COUNT_OBJECTS_TIMEOUT_MS = 5000;
const GIT_COUNT_OBJECTS_MAX_BUFFER = 1024 * 1024;
const GH_AUTH_STATUS_TIMEOUT_MS = 5000;
const GH_AUTH_STATUS_MAX_BUFFER = 1024 * 1024;

type ReviewPreflightDiagnostics = GateReadinessDiagnostics['reviewPreflight'];

export interface ReviewPreflightOptions {
  repoRoot: string;
  statfs?: (path: string) => { bavail?: number | bigint; bfree: number | bigint; bsize: number | bigint };
  gitCountObjects?: (repoRoot: string) => string;
  ghAuthStatus?: (repoRoot: string) => string;
}

function localReviewEnabled(config: Config): boolean {
  return config.reviewAdapter === 'local' || config.reviewAdapter === 'mixed' || config.reviewAdapter === 'shadow';
}

function disabledPreflight(): ReviewPreflightDiagnostics {
  return {
    enabled: false,
    readiness: 'disabled',
    checks: {
      disk: { readiness: 'disabled', freeBytes: null, thresholdBytes: LOW_DISK_THRESHOLD_BYTES, nextAction: null },
      dist: { readiness: 'disabled', path: 'products/aie/dist/bin/run.js', present: false, nextAction: null },
      gitObjects: { readiness: 'disabled', looseCount: null, threshold: HIGH_LOOSE_OBJECT_THRESHOLD, nextAction: null },
      githubReviewAuth: { readiness: 'disabled', authenticated: false, scopes: null, nextAction: null },
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

function parseGhScopes(output: string): string[] | null {
  const match = output.match(/Token scopes:\s*([^\r\n]+)/i);
  if (!match) return null;
  return match[1]
    .split(',')
    .map(scope => scope.replace(/^['"\s]+|['"\s]+$/g, '').trim())
    .filter(scope => scope !== '');
}

function canCreatePullRequestReviews(scopes: readonly string[] | null): boolean {
  if (scopes === null) return true;
  const normalized = scopes.map(scope => scope.toLowerCase());
  return normalized.includes('repo') || normalized.includes('pull_requests:write') || normalized.includes('pull-requests:write');
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
  const ghAuthStatus = options.ghAuthStatus ?? ((repoRoot: string) => execFileSync('gh', ['auth', 'status'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: GH_AUTH_STATUS_MAX_BUFFER,
    timeout: GH_AUTH_STATUS_TIMEOUT_MS,
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

  let githubReviewAuth: ReviewPreflightDiagnostics['checks']['githubReviewAuth'];
  try {
    const output = ghAuthStatus(options.repoRoot);
    const scopes = parseGhScopes(output);
    const nextAction = canCreatePullRequestReviews(scopes)
      ? null
      : 'GitHub CLI authentication may not be able to create pull request reviews; refresh `gh auth login` or token scopes with repo or pull_requests:write access before publishing lane reviews.';
    if (nextAction) nextActions.push(nextAction);
    githubReviewAuth = {
      readiness: nextAction ? 'needs-action' : 'ready',
      authenticated: true,
      scopes,
      nextAction,
    };
  } catch {
    const nextAction = 'GitHub CLI authentication is unavailable; run `gh auth status` and `gh auth login` before publishing lane reviews as pull request reviews.';
    nextActions.push(nextAction);
    githubReviewAuth = { readiness: 'unavailable', authenticated: false, scopes: null, nextAction };
  }

  return {
    enabled: true,
    readiness: overallStatus([disk.readiness, dist.readiness, gitObjects.readiness, githubReviewAuth.readiness]),
    checks: { disk, dist, gitObjects, githubReviewAuth },
    nextActions,
  };
}
