import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  parseAiuTrustedStateJson,
  path,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("prints focused failed-stage workflow guidance and records failed status", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-failed-run-");
    await writeFile(project.filePath, "export const value: string = 1;\n", "utf8");
    await mkdir(path.join(project.root, ".aiq"), { recursive: true });
    await writeFile(path.join(project.root, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(project.root, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts", "--only", "3"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ workflow");
    expect(stdout.value).toContain("Current stage: 3 typecheck");
    expect(stdout.value).toContain("Default run: stages 0..3 (e2e, lint, format, typecheck)");
    expect(stdout.value).toContain("Selected stages: typecheck");
    expect(stdout.value).toContain("Debug 3 typecheck: aiq run <paths...> --only 3 --verbose");

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    const status = JSON.parse(statusStdout.value) as {
      lastRun: { failedStages: Array<{ id: string; index: number }>; status: string };
      nextCommand: string;
    };
    expect(status.lastRun.status).toBe("failed");
    expect(status.lastRun.failedStages).toEqual([{ id: "typecheck", index: 3, name: "typecheck" }]);
    expect(status.nextCommand).toBe("aiq run <paths...> --only 3 --verbose");

    const evidenceStdout = new MemoryOutput();
    const evidenceStderr = new MemoryOutput();
    const evidenceExitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr: evidenceStderr,
      stdin: new MemoryInput(),
      stdout: evidenceStdout,
    });

    expect(evidenceExitCode).toBe(0);
    expect(evidenceStderr.value).toBe("");
    const evidence = JSON.parse(evidenceStdout.value) as {
      result: string;
      states: Array<{
        value: {
          failingChecks: string[];
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("failed");
    expect(evidence.states[0]?.value).toMatchObject({
      failingChecks: ["typecheck"],
      lastRunStatus: "fail",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "typecheck",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: evidenceStdout.value,
    });
    expect(trustedState.ok).toBe(true);
  });
});
