import path from "node:path";

import { type LoadedAiqProgress, loadAiqProgress } from "@tjalve/aiq/config";

import type { CliIo, ParsedArgs } from "./types.js";

export interface WatchDirectoryTarget {
  dir: string;
  names: Set<string>;
}

interface WatchReplanState {
  replanPaths: Set<string>;
}

export function buildWatchReplanPaths(
  cwd: string,
  configPath?: string,
  progressPath?: string,
  watchProgressPath = false,
  filesFromPath?: string,
): Set<string> {
  const replanPaths = new Set<string>();
  if (configPath === undefined) {
    replanPaths.add(path.resolve(cwd, "aiq.config.json"));
    replanPaths.add(path.resolve(cwd, ".qube", "aiq", "config.json"));
  } else {
    replanPaths.add(path.resolve(cwd, configPath));
  }
  if (progressPath !== undefined) {
    replanPaths.add(path.resolve(cwd, progressPath));
  } else if (watchProgressPath) {
    replanPaths.add(path.resolve(cwd, ".qube", "aiq", "progress.json"));
  }
  if (filesFromPath !== undefined) {
    replanPaths.add(path.resolve(cwd, filesFromPath));
  }
  return replanPaths;
}

export async function loadOptionalWatchProgress(
  parsed: ParsedArgs,
  io: CliIo,
): Promise<LoadedAiqProgress | undefined> {
  if (!usesWatchProgressDefaults(parsed)) {
    return undefined;
  }

  const progress = await loadAiqProgress(io.cwd);
  return progress.source === "file" ? progress : undefined;
}

export function usesWatchProgressDefaults(parsed: ParsedArgs): boolean {
  return parsed.stages.length === 0 && parsed.profile === undefined;
}

export function shouldReprepareWatchRun(prepared: WatchReplanState, trigger: string): boolean {
  const resolvedTrigger = path.resolve(trigger);
  if (prepared.replanPaths.has(resolvedTrigger)) {
    return true;
  }

  return [...prepared.replanPaths].some(
    (replanPath) => path.dirname(replanPath) === resolvedTrigger,
  );
}

export function buildWatchTargets(
  cwd: string,
  files: readonly string[],
  configPath?: string,
  progressPath?: string,
  watchProgressPath = false,
  filesFromPath?: string,
): WatchDirectoryTarget[] {
  const targets = new Map<string, Set<string>>();

  for (const file of files) {
    addWatchTarget(targets, cwd, file);
  }

  if (filesFromPath !== undefined) {
    addWatchTarget(targets, cwd, filesFromPath);
  }

  if (configPath !== undefined) {
    addWatchTarget(targets, cwd, configPath);
  } else {
    addWatchTarget(targets, cwd, path.join(cwd, "aiq.config.json"));
    addWatchTarget(targets, cwd, path.join(cwd, ".qube", "aiq", "config.json"));
  }

  if (progressPath !== undefined) {
    addWatchTarget(targets, cwd, progressPath);
  } else if (watchProgressPath) {
    addWatchTarget(targets, cwd, path.join(cwd, ".qube", "aiq", "progress.json"));
  }

  return [...targets.entries()]
    .map(([dir, names]) => ({ dir, names }))
    .sort((left, right) => left.dir.localeCompare(right.dir));
}

function addWatchTarget(targets: Map<string, Set<string>>, cwd: string, filePath: string): void {
  const absolutePath = path.resolve(cwd, filePath);
  const dir = path.dirname(absolutePath);
  const name = path.basename(absolutePath);
  const names = targets.get(dir) ?? new Set<string>();
  names.add(name);
  targets.set(dir, names);
}

export function sameWatchTargets(
  left: WatchDirectoryTarget[],
  right: WatchDirectoryTarget[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((target, index) => {
    const other = right[index];
    return other !== undefined && normalizeWatchTarget(target) === normalizeWatchTarget(other);
  });
}

function normalizeWatchTarget(target: WatchDirectoryTarget): string {
  return `${target.dir}:${[...target.names].sort().join(",")}`;
}

export function sameWatchPaths(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

export function matchesWatchTarget(
  filename: Buffer | string | null | undefined,
  names: Set<string>,
): boolean {
  if (filename === null || filename === undefined) {
    return true;
  }

  return names.has(filename.toString());
}

export function resolveWatchTrigger(
  dir: string,
  filename: Buffer | string | null | undefined,
  names?: Set<string>,
): string {
  if (filename === null || filename === undefined) {
    if (names?.size === 1) {
      const [name] = names;
      if (name !== undefined) {
        return path.join(dir, name);
      }
    }

    return dir;
  }

  return path.join(dir, filename.toString());
}
