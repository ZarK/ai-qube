import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as graphModule from "../src/graph.js";
import {
  buildEngineContext,
  buildEngineContextFromResolvedRequest,
  createCacheService,
  resolveRunRequest,
} from "../src/index.js";

const fixtureFile = path.resolve("test-projects/typescript/src/index.ts");

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("engine core services", () => {
  it("builds an engine context with normalized request fields plus graph and cache", async () => {
    const context = await buildEngineContext({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
    });

    expect(context).toMatchObject({
      context: "cli",
      cwd: process.cwd(),
      outDir: path.resolve(process.cwd(), ".qube/aiq/out"),
      selection: {
        profile: "fast",
        stages: ["lint"],
      },
    });
    expect(context.graph.root).toBe(process.cwd());
    expect(context.graph.fileToProjectIds[fixtureFile]).toEqual(
      expect.arrayContaining([
        expect.stringContaining("javascript-package:"),
        expect.stringContaining("typescript-typecheck:"),
      ]),
    );

    await context.cache.set("probe", "ok");
    expect(await context.cache.get("probe")).toBe("ok");
  });

  it("reuses identical back-to-back engine setup when tracked files are unchanged", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-context-cache-"));

    try {
      const sourceFile = path.join(root, "src", "index.ts");
      await mkdir(path.dirname(sourceFile), { recursive: true });
      await writeFile(
        path.join(root, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(sourceFile, "export const value = 1;\n", "utf8");

      const request = await resolveRunRequest({
        context: "cli",
        cwd: root,
        manifest: {
          files: [sourceFile],
          source: "direct",
        },
        mode: "check",
        stages: ["lint"],
      });
      const buildProjectGraphSpy = vi.spyOn(graphModule, "buildProjectGraph");

      const first = await buildEngineContextFromResolvedRequest(request);
      const second = await buildEngineContextFromResolvedRequest(request);

      expect(buildProjectGraphSpy).toHaveBeenCalledTimes(1);
      expect(second.cache).toBe(first.cache);
      expect(second.graph).toBe(first.graph);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("supports cache lifecycle operations and scoped prefix invalidation", async () => {
    const cache = createCacheService();
    let createCalls = 0;

    const [first, second] = await Promise.all([
      cache.getOrCreate("shared", async () => {
        createCalls += 1;
        return "value";
      }),
      cache.getOrCreate("shared", async () => {
        createCalls += 1;
        return "other";
      }),
    ]);

    expect(first).toEqual({ cacheHit: false, value: "value" });
    expect(second).toEqual({ cacheHit: true, value: "value" });
    expect(createCalls).toBe(1);

    const prefix = `${cache.generateKey(["metrics", "manifest-a"])}:`;
    const keepKey = cache.generateKey(["metrics", "manifest-a:keep"]);
    const staleKey = cache.generateKey(["metrics", "manifest-a:stale"]);
    const siblingKey = cache.generateKey(["metrics", "manifest-a-extra:stale"]);

    await cache.set(keepKey, "keep");
    await cache.set(staleKey, "stale");
    await cache.set(siblingKey, "sibling");
    await cache.deleteByPrefix(prefix, [keepKey]);

    expect(await cache.get(keepKey)).toBe("keep");
    expect(await cache.get(staleKey)).toBeUndefined();
    expect(await cache.get(siblingKey)).toBe("sibling");

    await cache.delete(keepKey);
    expect(await cache.get(keepKey)).toBeUndefined();

    await cache.clear();
    expect(await cache.get(siblingKey)).toBeUndefined();
  });

  it("clones stage configurations so later caller mutations do not leak into resolved requests", async () => {
    const stageConfigurations = {
      lint: {
        languages: {
          typescript: {
            toolId: "biome",
          },
        },
      },
    };

    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      stageConfigurations,
    });

    stageConfigurations.lint.languages.typescript.toolId = "python";

    expect(request.selection.stageConfigurations).toEqual({
      lint: {
        languages: {
          typescript: {
            toolId: "biome",
          },
        },
      },
    });
  });

  it("builds cache keys with explicit segment boundaries", () => {
    const cache = createCacheService();

    expect(cache.generateKey(["metrics", "manifest-a"])).toBe("metrics\u0000manifest-a");
    expect(cache.generateKey(["metrics", "manifest-a:keep"])).not.toBe(
      cache.generateKey(["metrics:manifest-a", "keep"]),
    );
  });

  it("expires zero-ttl entries immediately", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const cache = createCacheService();
    await cache.set("instant", "gone", 0);

    expect(await cache.get("instant")).toBeUndefined();
  });
});
