import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheService } from "../src/cache.js";
import type {
  EngineContext,
  PlannedTask,
  RunPlan,
  StageId,
  StageResult,
} from "../src/contracts.js";
import { artifactSchemaVersion, engineVersion } from "../src/contracts.js";

const runPlannedTaskMock =
  vi.fn<
    (
      task: PlannedTask,
      cwdOrContext: EngineContext | string,
      signal?: AbortSignal,
    ) => Promise<StageResult>
  >();
const resetRunnerRunScopedValuesMock = vi.fn<(cache: EngineContext["cache"]) => void>();

vi.mock("../src/runners.js", () => ({
  resetRunnerRunScopedValues: resetRunnerRunScopedValuesMock,
  runPlannedTask: runPlannedTaskMock,
}));

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject;
    resolve = promiseResolve;
  });
  return { promise, reject, resolve };
}

function createStageResult(stageId: StageId): StageResult {
  return {
    diagnostics: [],
    durationMs: 1,
    notes: [],
    stageId,
    status: "passed",
    toolRuns: [],
  };
}

function createEngineContext(
  stages: readonly StageId[],
  ecosystem: EngineContext["graph"]["projects"][number]["ecosystem"],
): EngineContext {
  const file = "/tmp/project/main.py";
  return {
    cache: createCacheService(),
    context: "cli",
    cwd: "/tmp/project",
    graph: {
      fileToProjectIds: {
        [file]: ["project-1"],
      },
      projects: [
        {
          ecosystem,
          id: "project-1",
          language: ecosystem,
          manifestFiles: ["/tmp/project/pyproject.toml"],
          metadata: {},
          name: "project",
          root: "/tmp/project",
          sourceFiles: [file],
        },
      ],
      root: "/tmp/project",
      version: "1",
    },
    manifest: {
      entries: [{ extension: ".py", path: file }],
      files: [file],
      root: "/tmp/project",
      source: "direct",
      summary: { fileCount: 1 },
    },
    mode: "check",
    outDir: "/tmp/out",
    selection: {
      profile: "fast",
      stages: [...stages],
    },
    writeArtifacts: false,
  };
}

function createPlan(stages: readonly StageId[]): RunPlan {
  return {
    artifactType: "plan",
    artifactVersion: artifactSchemaVersion,
    artifacts: { outDir: "/tmp/out" },
    context: "cli",
    createdAt: "2026-03-27T00:00:00.000Z",
    engineVersion,
    input: {
      entries: [{ extension: ".py", path: "/tmp/project/main.py" }],
      files: ["/tmp/project/main.py"],
      root: "/tmp/project",
      source: "direct",
      summary: { fileCount: 1 },
    },
    profile: "fast",
    runId: "run-1",
    stages: [...stages],
    summary: {
      fileCount: 1,
      stageCount: stages.length,
      taskCount: stages.length,
    },
    tasks: stages.map((stageId, index) => ({
      fileCount: 1,
      files: ["/tmp/project/main.py"],
      id: `run-1:${index + 1}:${stageId}`,
      stageId,
    })),
  };
}

describe("runResolvedRequest scheduling", () => {
  beforeEach(() => {
    vi.resetModules();
    runPlannedTaskMock.mockReset();
    resetRunnerRunScopedValuesMock.mockReset();
  });

  it("runs Python-only coverage after the concurrent pre-coverage batch and preserves report order", async () => {
    const stages: StageId[] = ["lint", "unit", "coverage", "security"];
    const started: StageId[] = [];
    const deferredByStage = new Map(
      stages.map((stageId) => [stageId, createDeferred<StageResult>()]),
    );
    runPlannedTaskMock.mockImplementation((task) => {
      started.push(task.stageId);
      const deferred = deferredByStage.get(task.stageId);
      if (deferred === undefined) {
        throw new Error("Missing stage");
      }

      return deferred.promise;
    });

    const { runResolvedRequest } = await import("../src/run.js");
    const promise = runResolvedRequest(createEngineContext(stages, "python"), createPlan(stages));

    await Promise.resolve();
    expect(started).toEqual(["lint", "unit", "security"]);

    deferredByStage.get("lint")?.resolve(createStageResult("lint"));
    deferredByStage.get("security")?.resolve(createStageResult("security"));
    await Promise.resolve();
    expect(started).toEqual(["lint", "unit", "security"]);

    deferredByStage.get("unit")?.resolve(createStageResult("unit"));
    await vi.waitFor(() => {
      expect(started).toEqual(["lint", "unit", "security", "coverage"]);
    });

    deferredByStage.get("coverage")?.resolve(createStageResult("coverage"));
    const result = await promise;

    expect(resetRunnerRunScopedValuesMock).toHaveBeenCalledTimes(1);
    expect(result.stages.map((stage) => stage.stageId)).toEqual(stages);
  });

  it("falls back to sequential execution when a Python selection includes an unsupported concurrent stage", async () => {
    const stages: StageId[] = ["lint", "e2e", "security"];
    const started: StageId[] = [];
    const deferredByStage = new Map(
      stages.map((stageId) => [stageId, createDeferred<StageResult>()]),
    );
    runPlannedTaskMock.mockImplementation((task) => {
      started.push(task.stageId);
      const deferred = deferredByStage.get(task.stageId);
      if (deferred === undefined) {
        throw new Error("Missing stage");
      }

      return deferred.promise;
    });

    const { runResolvedRequest } = await import("../src/run.js");
    const promise = runResolvedRequest(createEngineContext(stages, "python"), createPlan(stages));

    await Promise.resolve();
    expect(started).toEqual(["lint"]);

    deferredByStage.get("lint")?.resolve(createStageResult("lint"));
    await vi.waitFor(() => {
      expect(started).toEqual(["lint", "e2e"]);
    });

    deferredByStage.get("e2e")?.resolve(createStageResult("e2e"));
    await vi.waitFor(() => {
      expect(started).toEqual(["lint", "e2e", "security"]);
    });

    deferredByStage.get("security")?.resolve(createStageResult("security"));
    const result = await promise;

    expect(result.stages.map((stage) => stage.stageId)).toEqual(stages);
  });

  it("waits for sibling tasks in a concurrent Python batch to settle before surfacing a failure", async () => {
    const stages: StageId[] = ["lint", "unit", "security"];
    const started: StageId[] = [];
    const deferredByStage = new Map(
      stages.map((stageId) => [stageId, createDeferred<StageResult>()]),
    );
    runPlannedTaskMock.mockImplementation((task) => {
      started.push(task.stageId);
      const deferred = deferredByStage.get(task.stageId);
      if (deferred === undefined) {
        throw new Error("Missing stage");
      }

      return deferred.promise;
    });

    const { runResolvedRequest } = await import("../src/run.js");
    const promise = runResolvedRequest(createEngineContext(stages, "python"), createPlan(stages));

    await Promise.resolve();
    expect(started).toEqual(["lint", "unit", "security"]);

    const lintFailure = new Error("lint failed");
    deferredByStage.get("lint")?.reject(lintFailure);
    await Promise.resolve();

    let settled = false;
    void promise.catch(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(started).toEqual(["lint", "unit", "security"]);

    deferredByStage.get("unit")?.resolve(createStageResult("unit"));
    deferredByStage.get("security")?.resolve(createStageResult("security"));

    await expect(promise).rejects.toThrow(lintFailure);
    expect(settled).toBe(true);
  });
});
