import { stat } from "node:fs/promises";
import path from "node:path";

import { defaultOutDir, resolveArtifactOutDir } from "./artifacts.js";
import { createCacheService } from "./cache.js";
import type {
  CacheService,
  EngineContext,
  FileManifest,
  ProjectGraph,
  ResolvedRunRequest,
  RunRequest,
} from "./contracts.js";
import { normalizeFileManifest } from "./files.js";
import { buildProjectGraph } from "./graph.js";

type CachedEngineSetup = {
  cache: CacheService;
  fingerprint: string;
  graph: ProjectGraph;
  trackedFiles: string[];
};

let lastEngineSetupKey: string | undefined;
let lastEngineSetupPromise: Promise<CachedEngineSetup> | undefined;

export async function resolveRunRequest(request: RunRequest): Promise<ResolvedRunRequest> {
  const cwd = path.resolve(request.cwd ?? process.cwd());

  const resolved: ResolvedRunRequest = {
    context: request.context ?? "serve",
    cwd,
    diffOnly: request.diffOnly === true,
    diffOnlyFiles: await normalizeDiffOnlyFiles(request.diffOnlyFiles, cwd),
    manifest: await normalizeFileManifest(request.manifest, cwd),
    mode: request.mode,
    outDir: resolveArtifactOutDir(cwd, request.outDir ?? defaultOutDir),
    selection: {
      stages: [...(request.stages ?? [])],
      ...(request.stageConfigurations === undefined
        ? {}
        : { stageConfigurations: structuredClone(request.stageConfigurations) }),
      profile: request.profile ?? "fast",
    },
    writeArtifacts: request.writeArtifacts !== false,
  };

  if (request.signal !== undefined) {
    resolved.signal = request.signal;
  }

  return resolved;
}

async function normalizeDiffOnlyFiles(
  diffOnlyFiles: readonly string[] | undefined,
  cwd: string,
): Promise<string[]> {
  if (diffOnlyFiles === undefined || diffOnlyFiles.length === 0) {
    return [];
  }

  return (await normalizeFileManifest({ files: diffOnlyFiles, source: "direct" }, cwd)).files;
}

export async function buildEngineContextFromResolvedRequest(
  request: ResolvedRunRequest,
): Promise<EngineContext> {
  const setup = await resolveCachedEngineSetup(request.manifest);

  return {
    ...request,
    cache: setup.cache,
    graph: setup.graph,
  };
}

export async function buildEngineContext(request: RunRequest): Promise<EngineContext> {
  return buildEngineContextFromResolvedRequest(await resolveRunRequest(request));
}

async function resolveCachedEngineSetup(manifest: FileManifest): Promise<CachedEngineSetup> {
  const key = createEngineSetupKey(manifest);

  if (lastEngineSetupKey === key && lastEngineSetupPromise !== undefined) {
    const cached = await lastEngineSetupPromise;
    if ((await readTrackedFilesFingerprint(cached.trackedFiles)) === cached.fingerprint) {
      return cached;
    }
  }

  const pending = createCachedEngineSetup(manifest).catch((error) => {
    if (lastEngineSetupKey === key && lastEngineSetupPromise === pending) {
      lastEngineSetupKey = undefined;
      lastEngineSetupPromise = undefined;
    }
    throw error;
  });

  lastEngineSetupKey = key;
  lastEngineSetupPromise = pending;
  return pending;
}

async function createCachedEngineSetup(manifest: FileManifest): Promise<CachedEngineSetup> {
  const graph = await buildProjectGraph(manifest);
  const trackedFiles = collectTrackedFiles(manifest, graph);

  return {
    cache: createCacheService(),
    fingerprint: await readTrackedFilesFingerprint(trackedFiles),
    graph,
    trackedFiles,
  };
}

function createEngineSetupKey(manifest: FileManifest): string {
  return [manifest.root, manifest.source, ...manifest.files].join("\u0000");
}

function collectTrackedFiles(manifest: FileManifest, graph: ProjectGraph): string[] {
  return [
    ...new Set([
      ...manifest.files,
      ...graph.projects.flatMap((project) => [...project.manifestFiles, ...project.sourceFiles]),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

async function readTrackedFilesFingerprint(files: readonly string[]): Promise<string> {
  const entries = await Promise.all(
    [...files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        try {
          const fileStats = await stat(file);
          return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
        } catch {
          return `${file}@missing`;
        }
      }),
  );

  return entries.join("|");
}
