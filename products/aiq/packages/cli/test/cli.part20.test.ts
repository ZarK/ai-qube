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
  it("emits trusted malformed-quality evidence for invalid report shapes", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-evidence-malformed-run-");
    const reportDir = path.join(project.root, ".qube", "aiq", "out");
    await mkdir(reportDir, { recursive: true });
    await writeFile(
      path.join(reportDir, "aiq.report.json"),
      `${JSON.stringify({
        artifactType: "report",
        finishedAt: new Date().toISOString(),
        runId: "run-invalid",
        summary: { status: "failed" },
        stages: [
          {
            stageId: "typecheck",
            status: "failed",
            diagnostics: [{ file: 42, message: "bad diagnostic", severity: "error" }],
          },
        ],
        request: { manifest: { files: ["src/index.ts"] } },
      })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "evidence", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const evidence = JSON.parse(stdout.value) as {
      reasonCode: string;
      result: string;
      states: Array<{
        value: {
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
    };
    expect(evidence.result).toBe("failed");
    expect(evidence.reasonCode).toBe("malformed-evidence");
    expect(evidence.states[0]?.value).toMatchObject({
      lastRunStatus: "malformed",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "malformed-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: stdout.value,
    });
    expect(trustedState.ok).toBe(true);
  });
});
