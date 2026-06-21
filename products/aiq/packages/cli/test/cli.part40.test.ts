import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  parseJsonLines,
  path,
  runCli,
  waitFor,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("supports watch cadence stages and only replans when config changes", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-cadence-");
    const configDir = path.join(project.root, ".qube", "aiq");
    const configPath = path.join(configDir, "config.json");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          surfaces: {
            watch: {
              cadenceMs: 150,
              cadenceStages: ["typecheck"],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const controller = new AbortController();
    const runPromise = runCli(
      [
        "node",
        "aiq",
        "watch",
        "src/index.ts",
        "--stage",
        "lint",
        "--stage",
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "20",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const startupRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines[0];
    });

    expect(startupRun.trigger).toBe("startup");
    expect(startupRun.result.plan.stages).toEqual(["lint"]);

    const cadenceRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find((line) => line.trigger === "cadence");
    });

    expect(cadenceRun.result.plan.stages).toEqual(["typecheck"]);
    expect(cadenceRun.result.plan.runId).not.toBe(startupRun.result.plan.runId);

    await writeFile(project.filePath, "export const value = 2;\n", "utf8");

    const fileChangeRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find((line) => line.trigger.endsWith(path.join("src", "index.ts")));
    });

    expect(fileChangeRun.result.plan.stages).toEqual(["lint"]);
    expect(fileChangeRun.result.plan.runId).toBe(startupRun.result.plan.runId);

    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          version: 1,
          surfaces: {
            watch: {
              cadenceMs: 150,
              cadenceStages: [],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const configRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { plan: { stages: string[]; runId: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.find(
        (line) =>
          line.trigger.endsWith(path.join(".qube", "aiq", "config.json")) &&
          line.result.plan.runId !== startupRun.result.plan.runId,
      );
    });

    expect(configRun.result.plan.stages).toEqual(["lint", "typecheck"]);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  });
});
