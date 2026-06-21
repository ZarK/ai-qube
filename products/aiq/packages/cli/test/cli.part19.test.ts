import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  access,
  createTypeScriptFixtureProject,
  mkdir,
  parseAiuTrustedStateJson,
  path,
  readFile,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("reports status before any run without writing config state", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-status-no-run-");
    await mkdir(path.join(project.root, ".qube", "aiq"), { recursive: true });
    const progressPath = path.join(project.root, ".qube", "aiq", "progress.json");
    const progressContents = `${JSON.stringify({
      current_stage: 3,
      disabled: [],
      order: [0, 1, 2, 3],
      last_run: "previous",
    })}\n`;
    await writeFile(progressPath, progressContents, "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "status", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      artifactPaths: { plan: string; report: string };
      currentStage: { id: string; index: number };
      defaultRun: { range: string; stages: Array<{ id: string }> };
      lastRun: { failedStages: unknown[]; status: string };
      nextCommand: string;
      progressLastRun: string | null;
      selectedStages: string[];
    };
    expect(output.currentStage).toMatchObject({ id: "typecheck", index: 3 });
    expect(output.defaultRun.range).toBe("0..3");
    expect(output.defaultRun.stages.map((stage) => stage.id)).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
    ]);
    expect(output.selectedStages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.lastRun).toMatchObject({ failedStages: [], status: "none" });
    expect(output.progressLastRun).toBe("previous");
    expect(output.nextCommand).toBe("aiq run <paths...>");
    expect(output.artifactPaths.report).toBe(
      path.join(project.root, ".qube", "aiq", "out", "aiq.report.json"),
    );
    expect(await readFile(progressPath, "utf8")).toBe(progressContents);
    await expect(access(path.join(project.root, ".qube", "aiq", "config.json"))).rejects.toThrow();
  });

  it("emits trusted missing-quality evidence before any run", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-evidence-no-run-");
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
      schemaVersion: number;
      states: Array<{
        value: {
          kind: string;
          lastRunStatus: string;
          ready: boolean;
          selectedTarget?: { id: string; status: string };
          status: string;
        };
      }>;
      trust: string;
    };
    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.result).toBe("missing");
    expect(evidence.reasonCode).toBe("missing-evidence");
    expect(evidence.trust).toBe("local-evidence");
    expect(evidence.states[0]?.value).toMatchObject({
      kind: "quality",
      lastRunStatus: "missing",
      ready: true,
      status: "fail",
    });
    expect(evidence.states[0]?.value.selectedTarget).toMatchObject({
      id: "missing-report",
      status: "fail",
    });

    const trustedState = parseAiuTrustedStateJson({
      sourceId: "quality",
      command: { id: "quality", argv: ["aiq", "evidence", "--format", "json"] },
      stdout: stdout.value,
    });
    expect(trustedState.ok).toBe(true);
    if (trustedState.ok) {
      expect(trustedState.states[0]?.value.kind).toBe("quality");
      expect(trustedState.states[0]?.value.status).toBe("fail");
    }
  });
});
