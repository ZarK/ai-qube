import { execFileSync } from 'child_process';
import { existsSync, statfsSync } from 'fs';
import { join, relative } from 'path';
import type { Config } from '../config/index.js';
import type { DoctorReadinessStatus, GateReadinessDiagnostics } from './types.js';

const LOW_DISK_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024;
const HIGH_LOOSE_OBJECT_THRESHOLD = 50000;

type ReviewPreflightDiagnostics = GateReadinessDiagnostics['reviewPreflight'];

export interface ReviewPreflightOptions {
  repoRoot: string;
  statfs?: (path: string) => { bavail?: number | bigint; bfree: number | bigint; bsize: number | bigint };
  gitCountObjects?: (repoRoot: string) => string;
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
  const gitCountObjects = options.gitCountObjects ?? ((repoRoot: string) => execFileSync('git', ['count-objects', '-v'], { cwd: repoRoot, encoding: 'utf8' }));

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

  return {
    enabled: true,
    readiness: overallStatus([disk.readiness, dist.readiness, gitObjects.readiness]),
    checks: { disk, dist, gitObjects },
    nextActions,
  };
}
