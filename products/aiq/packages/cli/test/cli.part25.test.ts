import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdtemp,
  os,
  parseJsonLines,
  path,
  readFile,
  runCli,
  tempDirs,
  waitFor,
  writeServeListeningOutput,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("accepts --port 0 for ephemeral serve ports", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-serve-port-zero-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      ["node", "aiq", "serve", "--host", "127.0.0.1", "--port", "0", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const listening = await waitFor(() => {
      const lines = parseJsonLines<{ event: string; url: string }>(stdout.value);
      return lines.find((line) => line.event === "listening");
    });

    const listeningUrl = new URL(listening.url);
    expect(listeningUrl.protocol).toBe("http:");
    expect(listeningUrl.hostname).toBe("127.0.0.1");
    expect(Number(listeningUrl.port)).toBeGreaterThan(0);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });

  it("formats IPv6 serve URLs with brackets", () => {
    const stdout = new MemoryOutput();

    writeServeListeningOutput(
      {
        cwd: process.cwd(),
        stderr: new MemoryOutput(),
        stdin: new MemoryInput(),
        stdout,
      },
      "json",
      "::1",
      4317,
    );

    expect(
      parseJsonLines<{ event: string; host: string; port: number; url: string }>(stdout.value),
    ).toMatchObject([
      {
        event: "listening",
        host: "::1",
        port: 4317,
        url: "http://[::1]:4317",
      },
    ]);
  });

  it("renders benchmark output as JSON", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-bench-"));
    tempDirs.push(tempDir);

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      [
        "node",
        "aiq",
        "bench",
        "--scenario",
        "javascript-lint-single-file-cold",
        "--format",
        "json",
        "--out-dir",
        tempDir,
      ],
      {
        cwd: process.cwd(),
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as {
      artifactType: string;
      primaryMetric: { field: string; goal: string; unit: string; value: number };
      scenarios: Array<{
        id: string;
        kind: string;
        manifest: { fileCount: number; shape: string };
      }>;
      selection: { matchedScenarioCount: number; scenarioIds: string[] };
      summary: { failedBudgetCount: number; scenarioCount: number };
    };
    expect(output.artifactType).toBe("benchmark");
    expect(output.primaryMetric).toMatchObject({
      field: "summary.totalDurationMs",
      goal: "minimize",
      unit: "ms",
    });
    expect(output.selection).toMatchObject({
      matchedScenarioCount: 1,
      scenarioIds: ["javascript-lint-single-file-cold"],
    });
    expect(output.summary.failedBudgetCount).toBe(0);
    expect(output.summary.scenarioCount).toBe(1);
    expect(output.scenarios[0]).toMatchObject({
      id: "javascript-lint-single-file-cold",
      kind: "cold",
      manifest: {
        fileCount: 1,
        shape: "single-file",
      },
    });

    const artifactJson = JSON.parse(
      await readFile(path.join(tempDir, "aiq.benchmark.json"), "utf8"),
    ) as { artifactType: string };
    expect(artifactJson.artifactType).toBe("benchmark");
  });
});
