import type { RunStageConfigurations, StageId } from "@tjalve/aiq/model";
import { describe, expect, it } from "vitest";
import {
  type RunnerStageDefinition,
  createRunnerExecutionContext,
  resolveStageHandlers,
  runnerExecutionContextStorage,
} from "../src/runners.js";

describe("runners unit: resolveStageHandlers", () => {
  const mockStageDefinition = {
    aggregation: "combine",
    id: "lint" as StageId,
    moduleIds: ["biome", "python", "terraform"],
    note: "Mock lint stage",
    scope: "language-modules",
  } satisfies RunnerStageDefinition;

  const mockTask = {
    id: "test-task",
    stageId: "lint" as StageId,
    files: ["src/index.ts", "main.py", "infra.tf", "readme.md"],
    fileCount: 4,
  };

  it("resolves default handlers when no stageConfigurations are provided", () => {
    const context = createRunnerExecutionContext(process.cwd());

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, mockTask);
      expect(handlers.length).toBeGreaterThanOrEqual(1);
      expect(handlers.some((h) => h.files.includes("src/index.ts"))).toBe(true);
      expect(handlers.some((h) => h.files.includes("main.py"))).toBe(true);
    });
  });

  it("filters files and selects correct tool when stageConfigurations are provided", () => {
    const stageConfigurations: RunStageConfigurations = {
      lint: {
        languages: {
          typescript: { toolId: "biome" },
          python: { toolId: "python" },
        },
      },
    };

    const context = {
      ...createRunnerExecutionContext(process.cwd()),
      stageConfigurations,
    };

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, mockTask);

      expect(handlers.length).toBe(2);

      const biomeHandler = handlers.find((h) => h.files.some((f) => f.endsWith(".ts")));
      const pythonHandler = handlers.find((h) => h.files.some((f) => f.endsWith(".py")));

      expect(biomeHandler).toBeDefined();
      expect(pythonHandler).toBeDefined();

      expect(biomeHandler?.files).toEqual(["src/index.ts"]);
      expect(pythonHandler?.files).toEqual(["main.py"]);
    });
  });

  it("handles tool selection overrides", () => {
    const stageConfigurations: RunStageConfigurations = {
      lint: {
        languages: {
          javascript: { toolId: "python" },
        },
      },
    };

    const context = {
      ...createRunnerExecutionContext(process.cwd()),
      stageConfigurations,
    };

    const jsTask = {
      ...mockTask,
      files: ["index.js", "main.py"],
    };

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, jsTask);

      expect(handlers.length).toBe(1);
      expect(handlers[0].files).toEqual(["index.js"]);
    });
  });

  it("handles empty tool selection and empty files gracefully", () => {
    const stageConfigurations: RunStageConfigurations = {
      lint: {
        languages: {},
      },
    };

    const context = {
      ...createRunnerExecutionContext(process.cwd()),
      stageConfigurations,
    };

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, mockTask);
      expect(handlers.length).toBe(0);
    });
  });

  it("selects only files that match configured language, even if task has more", () => {
    const stageConfigurations: RunStageConfigurations = {
      lint: {
        languages: {
          typescript: { toolId: "biome" },
        },
      },
    };

    const context = {
      ...createRunnerExecutionContext(process.cwd()),
      stageConfigurations,
    };

    const mixedFilesTask = {
      ...mockTask,
      files: ["src/index.ts", "main.py", "styles.css"],
    };

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, mixedFilesTask);

      expect(handlers.length).toBe(1);
      expect(handlers[0].files).toEqual(["src/index.ts"]);
    });
  });

  it("can group multiple languages into the same tool and collect all relevant files", () => {
    const stageConfigurations: RunStageConfigurations = {
      lint: {
        languages: {
          javascript: { toolId: "biome" },
          typescript: { toolId: "biome" },
        },
      },
    };

    const context = {
      ...createRunnerExecutionContext(process.cwd()),
      stageConfigurations,
    };

    const mixedFilesTask = {
      ...mockTask,
      files: ["index.js", "src/index.ts", "main.py"],
    };

    runnerExecutionContextStorage.run(context, () => {
      const handlers = resolveStageHandlers(mockStageDefinition, mixedFilesTask);

      expect(handlers.length).toBe(1);
      expect(handlers[0].files.length).toBe(2);
      expect(handlers[0].files).toContain("index.js");
      expect(handlers[0].files).toContain("src/index.ts");
    });
  });
});
