import { describe, expect, it } from "vitest";
import type { RunRequest, RunResult } from "./cli-test-support.js";
import {
  MemoryInput,
  MemoryOutput,
  createRunWorkflowOutput,
  createTypeScriptFixtureProject,
  mkdir,
  path,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("rejects non-config flags on aiq config", async () => {
    for (const argv of [
      ["node", "aiq", "config", "--scenario", "smoke"],
      ["node", "aiq", "config", "--tag", "ci"],
      ["node", "aiq", "config", "--kind", "warm"],
      ["node", "aiq", "config", "--corpus-root", "fixtures"],
      ["node", "aiq", "config", "--host", "0.0.0.0"],
      ["node", "aiq", "config", "--port", "0"],
      ["node", "aiq", "config", "--debounce-ms", "5"],
    ]) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(argv, {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      });

      expect(exitCode).toBe(2);
      expect(stdout.value).toBe("");
      expect(stderr.value).toContain(
        "The config command only accepts --print-config, --set-stage, and --format options.",
      );
    }
  });

  it("uses persisted current_stage as the default cumulative run target", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-progress-run-");
    await mkdir(path.join(project.root, ".qube", "aiq"), { recursive: true });
    await writeFile(path.join(project.root, ".qube", "aiq", "config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(project.root, ".qube", "aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      request: { selection: { stages: string[] } };
      stages: Array<{ stageId: string }>;
      workflow: {
        currentStage: { id: string; index: number };
        defaultRun: { range: string };
        nextCommand: string;
        selectedStages: string[];
      };
    };
    expect(output.request.selection.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.stages.map((stage) => stage.stageId)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(output.workflow).toMatchObject({
      currentStage: { id: "typecheck", index: 3 },
      defaultRun: {
        range: "0..3",
      },
      nextCommand: "aiq run <paths...> --only 0 --verbose",
      selectedStages: ["e2e", "lint", "format", "typecheck"],
    });
  });

  it("reports progress default stages when workflow requests omit explicit stages", () => {
    const workflow = createRunWorkflowOutput(
      {
        path: "/tmp/project/.qube/aiq/progress.json",
        progress: {
          current_stage: 3,
          disabled: [],
          last_run: null,
          order: [0, 1, 2, 3],
        },
        source: "file",
      },
      {
        stages: undefined,
      } as RunRequest,
      {
        stages: [],
        summary: {
          status: "passed",
        },
      } as RunResult,
    );

    expect(workflow.selectedStages).toEqual(["e2e", "lint", "format", "typecheck"]);
  });
});
