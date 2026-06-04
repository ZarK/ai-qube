import path from "node:path";

import { describe, expect, it } from "vitest";
import type { RunResult } from "../../model/src/index.js";
import {
  collectGitHubAnnotations,
  formatRunResultAsGitHubAnnotations,
  formatRunResultAsText,
} from "../src/index.js";

describe("reporters", () => {
  it("maps engine diagnostics to GitHub annotations with relative paths", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const result = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          code: "lint/style/noVar",
          file: path.join(workspaceRoot, "src", "index.ts"),
          message: "Unexpected var, use let or const instead.",
          range: {
            endColumn: 4,
            endLine: 1,
            startColumn: 1,
            startLine: 1,
          },
          severity: "error",
          source: "biome",
        },
      ],
    });

    const annotations = collectGitHubAnnotations(result);

    expect(annotations).toEqual([
      {
        endColumn: 4,
        endLine: 1,
        file: "src/index.ts",
        level: "error",
        message: "Unexpected var, use let or const instead.",
        startColumn: 1,
        startLine: 1,
        title: "AIQ/biome lint/style/noVar",
      },
    ]);
  });

  it("formats workflow commands and escapes multiline messages", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const result = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          file: path.join(workspaceRoot, "README.md"),
          message: "Line one\nLine two",
          severity: "warning",
          source: "aiq",
        },
      ],
    });

    const output = formatRunResultAsGitHubAnnotations(result);

    expect(output).toBe("::warning file=README.md,title=AIQ/aiq::Line one%0ALine two\n");
  });

  it("groups human output into actionable problem categories", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const missingPython = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          file: path.join(workspaceRoot, "src", "main.py"),
          message: "ty was not detected. Install Astral ty to run Python typecheck.",
          severity: "error",
          source: "ty",
        },
      ],
      stageId: "typecheck",
      status: "failed",
    });
    const unsupportedJs = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [],
      notes: ["No supported JavaScript or TypeScript test runner was detected for unit in: ."],
      stageId: "unit",
      status: "not_implemented",
    });
    const qualityFailure = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          file: path.join(workspaceRoot, "src", "index.ts"),
          message: "Unexpected var, use let or const instead.",
          severity: "error",
          source: "biome",
        },
      ],
      stageId: "lint",
      status: "failed",
    });
    const metricFailure = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          code: "metrics/complexity-limit",
          file: path.join(workspaceRoot, "src", "workflow.ts"),
          message: "runWorkflow complexity 13 is greater than 12.",
          severity: "error",
          source: "lizard",
        },
      ],
      stageId: "complexity",
      status: "failed",
    });
    const setupFailure = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [
        {
          file: workspaceRoot,
          message: "Project config is missing required test runner settings.",
          severity: "error",
          source: "aiq",
        },
      ],
      stageId: "unit",
      status: "failed",
    });
    const multiWordTool = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [],
      notes: ["go test was not detected. Install Go to run unit tests."],
      stageId: "unit",
      status: "failed",
    });

    expect(formatRunResultAsText(missingPython)).toContain("Missing tools:");
    expect(formatRunResultAsText(missingPython)).toContain("[stage 3 typecheck] Python/ty");
    expect(formatRunResultAsText(missingPython)).toContain("aiq setup");
    expect(formatRunResultAsText(unsupportedJs)).toContain("Unsupported projects:");
    expect(formatRunResultAsText(qualityFailure)).toContain("Quality failures:");
    expect(formatRunResultAsText(qualityFailure)).toContain("Suggested next commands:");
    expect(formatRunResultAsText(qualityFailure)).not.toContain("aiq setup");
    expect(formatRunResultAsText(metricFailure)).toContain("metric diagnostic from lizard");
    expect(formatRunResultAsText(metricFailure)).toContain(
      "Do not start broad refactors until stage 0 e2e passes",
    );
    expect(formatRunResultAsText(metricFailure)).toContain("Use direct purpose-revealing names");
    expect(formatRunResultAsText(metricFailure)).toContain(
      "no vague helper/manager/processor names",
    );
    expect(formatRunResultAsText(setupFailure)).toContain("Setup issues:");
    expect(formatRunResultAsText(setupFailure)).toContain("aiq setup");
    expect(formatRunResultAsText(multiWordTool)).toContain("Go/go test");
  });
});

function createRunResult(options: {
  cwd: string;
  diagnostics: Array<{
    code?: string;
    file: string;
    message: string;
    range?: {
      endColumn?: number;
      endLine?: number;
      startColumn: number;
      startLine: number;
    };
    severity: "error" | "info" | "warning";
    source: string;
  }>;
  notes?: string[];
  stageId?: RunResult["stages"][number]["stageId"];
  status?: RunResult["stages"][number]["status"];
}): RunResult {
  const stageId = options.stageId ?? "lint";
  const status = options.status ?? (options.diagnostics.length === 0 ? "passed" : "failed");
  const result: RunResult = {
    artifactType: "report",
    artifactVersion: 1,
    artifacts: {
      outDir: path.join(options.cwd, ".aiq", "out"),
      planPath: path.join(options.cwd, ".aiq", "out", "aiq.plan.json"),
      reportPath: path.join(options.cwd, ".aiq", "out", "aiq.report.json"),
    },
    context: "github",
    durationMs: 1,
    engineVersion: "0.0.0",
    finishedAt: "2026-03-23T00:00:00.000Z",
    mode: "check",
    ok: options.diagnostics.length === 0,
    stages: [
      {
        diagnostics: options.diagnostics,
        durationMs: 1,
        notes: options.notes ?? [],
        stageId,
        status,
        toolRuns: [],
      },
    ],
    plan: {
      artifactType: "plan",
      artifactVersion: 1,
      artifacts: {
        outDir: path.join(options.cwd, ".aiq", "out"),
      },
      context: "github",
      createdAt: "2026-03-23T00:00:00.000Z",
      engineVersion: "0.0.0",
      input: {
        entries: options.diagnostics.map((diagnostic) => ({
          extension: path.extname(diagnostic.file),
          path: diagnostic.file,
        })),
        files: options.diagnostics.map((diagnostic) => diagnostic.file),
        root: options.cwd,
        source: "direct",
        summary: {
          fileCount: options.diagnostics.length,
        },
      },
      stages: [stageId],
      profile: "deep",
      runId: "run_123",
      summary: {
        fileCount: options.diagnostics.length,
        stageCount: 1,
        taskCount: 1,
      },
      tasks: [
        {
          fileCount: options.diagnostics.length,
          files: options.diagnostics.map((diagnostic) => diagnostic.file),
          id: "task_123",
          stageId,
        },
      ],
    },
    request: {
      context: "github",
      cwd: options.cwd,
      manifest: {
        entries: options.diagnostics.map((diagnostic) => ({
          extension: path.extname(diagnostic.file),
          path: diagnostic.file,
        })),
        files: options.diagnostics.map((diagnostic) => diagnostic.file),
        root: options.cwd,
        source: "direct",
        summary: {
          fileCount: options.diagnostics.length,
        },
      },
      mode: "check",
      outDir: path.join(options.cwd, ".aiq", "out"),
      selection: {
        stages: [stageId],
        profile: "deep",
      },
      writeArtifacts: true,
    },
    runId: "run_123",
    startedAt: "2026-03-23T00:00:00.000Z",
    summary: {
      cacheHitCount: 0,
      cacheHitRate: 0,
      cacheMissCount: 0,
      diagnosticCount: options.diagnostics.length,
      durationMs: 1,
      fileCount: options.diagnostics.length,
      notImplementedStageCount: status === "not_implemented" ? 1 : 0,
      stageCount: 1,
      status,
      taskCount: 1,
      toolDurationMs: 0,
      toolRunCount: 0,
    },
  };

  return result;
}
