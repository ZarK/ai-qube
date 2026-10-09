import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
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

  it("renders selected stages with their start time, duration, reason, and target debug commands", () => {
    const result = createRunResult({
      cwd: "/repo",
      diagnostics: [],
      stageId: "lint",
      status: "passed",
    });
    result.durationMs = 25_900;
    const firstStage = result.stages[0];
    if (firstStage === undefined) throw new Error("Expected a selected stage.");
    firstStage.durationMs = 21_100;
    result.stages.push({
      stageId: "complexity",
      status: "failed",
      startedAt: "2026-03-23T00:00:22.000Z",
      durationMs: 2100,
      diagnostics: [],
      notes: [],
      toolRuns: [],
    });
    result.stages.push({
      stageId: "coverage",
      status: "warning",
      startedAt: "2026-03-23T00:00:24.000Z",
      durationMs: 1000,
      diagnostics: [],
      notes: ["zero tests detected"],
      toolRuns: [],
    });
    expect(formatRunResultAsText(result, { targets: ["src", "test folder"] })).toBe(
      [
        "[00m00s/00m21s] Stage 1 (lint): PASSED",
        "[00m22s/00m02s] Stage 6 (complexity): FAILED",
        "[00m24s/00m01s] Stage 8 (coverage): WARNING (zero tests detected)",
        "",
        "Total execution time: 00m25s",
        "",
        "To debug failed stages:",
        "  aiq run src 'test folder' --only 6 --verbose  # Debug stage 6 (complexity)",
        "",
      ].join("\n"),
    );
  });

  it("passes shell metacharacters in debug targets as literal arguments", () => {
    const windows = process.platform === "win32";
    const targets = [
      "$(Write-Output INJECTED).ts",
      "$(printf INJECTED).ts",
      "`echo INJECTED`.ts",
      "quote'$(echo INJECTED).ts",
      "a; echo INJECTED; #.ts",
      ...(windows ? [] : ['double"quote.ts', "a&echo INJECTED|cat.ts"]),
      "test folder/file.ts",
      "C:\\source\\file.ts",
    ];
    const result = createRunResult({ cwd: "/repo", diagnostics: [], status: "failed" });
    const output = formatRunResultAsText(result, { targets });
    const command = output.split("\n").find((line) => line.startsWith("  aiq run "));
    expect(command).toBeDefined();
    const script = windows
      ? `function aiq { ConvertTo-Json -InputObject ([string[]]$args) -Compress }; ${command}`
      : `aiq() { printf '%s\\0' "$@"; }; ${command}`;
    const stdout = execFileSync(
      windows ? "powershell.exe" : "/bin/sh",
      windows ? ["-NoProfile", "-NonInteractive", "-Command", script] : ["-c", script],
      { encoding: "utf8" },
    );
    const args = windows ? JSON.parse(stdout) : stdout.split("\0").slice(0, -1);
    expect(args).toEqual(["run", ...targets, "--only", "1", "--verbose"]);
  });

  it.skipIf(process.platform !== "win32")(
    "omits targets unsafe for Windows command shims or PowerShell quotes",
    () => {
      const result = createRunResult({ cwd: "/repo", diagnostics: [], status: "failed" });
      for (const character of ['"', "&", "|", "<", ">", "%", "^", "\u2018", "\u2019"]) {
        const output = formatRunResultAsText(result, { targets: [`a${character}b.ts`] });
        expect(output).toContain("Debug command omitted");
        expect(output).not.toContain("aiq run");
      }
    },
  );

  it("omits executable hints when a target contains control characters", () => {
    const result = createRunResult({ cwd: "/repo", diagnostics: [], status: "failed" });
    for (const target of ["line\nbreak.ts", "escape\u001b.ts", "line\u2028break.ts"]) {
      const output = formatRunResultAsText(result, { targets: ["src", target] });
      expect(output).toContain("Debug command omitted");
      expect(output).not.toContain("aiq run");
      expect(output).not.toContain(target);
    }
  });

  it("colors terminal output and honors NO_COLOR", () => {
    const result = createRunResult({
      cwd: "/repo",
      diagnostics: [],
      status: "passed",
    });
    vi.stubEnv("NO_COLOR", undefined);
    try {
      expect(formatRunResultAsText(result, { color: true })).toContain("\u001b[32mPASSED\u001b[0m");
      expect(formatRunResultAsText(result, { color: true })).toContain("\u001b[2m[00m00s/00m00s]");
      expect(formatRunResultAsText(result)).not.toContain("\u001b[");
      const failed = createRunResult({ cwd: "/repo", diagnostics: [], status: "failed" });
      const warning = createRunResult({ cwd: "/repo", diagnostics: [], status: "warning" });
      expect(formatRunResultAsText(failed, { color: true })).toContain("\u001b[31mFAILED\u001b[0m");
      expect(formatRunResultAsText(warning, { color: true })).toContain(
        "\u001b[33mWARNING\u001b[0m",
      );
      vi.stubEnv("NO_COLOR", "");
      expect(formatRunResultAsText(result, { color: true })).not.toContain("\u001b[");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps detailed human output available for verbose callers", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const result = createRunResult({
      cwd: workspaceRoot,
      diagnostics: [],
      stageId: "typecheck",
      status: "passed",
    });

    const output = formatRunResultAsText(result, { detail: true });

    expect(output).toContain("Run: run_123");
    expect(output).toContain("Context: github");
    expect(output).toContain("Artifacts:");
    expect(output).toContain("- typecheck: passed");
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
