import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  parseAiuTrustedStateJson,
  path,
  readFile,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("prints successful current-stage workflow guidance and advancement", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-successful-run-");
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

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Current stage satisfied: yes (3 typecheck)");
    expect(stdout.value).toContain("Advance: aiq config --set-stage 4");

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
      stale: boolean;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("passed");
    expect(evidence.stale).toBe(false);
    expect(evidence.states[0]?.value).toMatchObject({
      lastRunStatus: "pass",
      ready: false,
      status: "pass",
    });

    const reportPath = path.join(project.root, ".aiq", "out", "aiq.report.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as { finishedAt: string };
    report.finishedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    const staleStdout = new MemoryOutput();
    const staleStderr = new MemoryOutput();
    const staleExitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr: staleStderr,
      stdin: new MemoryInput(),
      stdout: staleStdout,
    });

    expect(staleExitCode).toBe(0);
    expect(staleStderr.value).toBe("");
    const staleEvidence = JSON.parse(staleStdout.value) as {
      reasonCode: string;
      result: string;
      stale: boolean;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(staleEvidence.result).toBe("stale");
    expect(staleEvidence.reasonCode).toBe("stale-evidence");
    expect(staleEvidence.stale).toBe(true);
    expect(staleEvidence.states[0]?.value).toMatchObject({
      lastRunStatus: "stale",
      ready: true,
      status: "fail",
    });
    expect(staleEvidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "stale-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: staleStdout.value,
    });
    expect(trustedState.ok).toBe(true);

    const statusStdout = new MemoryOutput();
    const statusStderr = new MemoryOutput();
    const statusExitCode = await runCli(["node", "aiq", "status"], {
      cwd: project.root,
      stderr: statusStderr,
      stdin: new MemoryInput(),
      stdout: statusStdout,
    });

    expect(statusExitCode).toBe(0);
    expect(statusStderr.value).toBe("");
    expect(statusStdout.value).toContain("Last run: passed");
    expect(statusStdout.value).toContain("Next: aiq config --set-stage 4");
  });
});
