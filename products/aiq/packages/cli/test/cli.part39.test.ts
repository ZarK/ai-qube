import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  parseJsonLines,
  path,
  runCli,
  waitFor,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("reruns watch on fixture changes and exits with the last run status", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-");
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
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "40",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    const firstRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean; request: { context: string } };
      }>(stdout.value);
      return lines.find((line) => line.event === "run");
    });

    expect(firstRun.result.ok).toBe(true);
    expect(firstRun.result.request.context).toBe("watch");

    await writeFile(
      project.filePath,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );

    const secondRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean; request: { context: string } };
        trigger: string;
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.length >= 2 ? lines[1] : undefined;
    });

    expect(secondRun.result.ok).toBe(false);
    expect(secondRun.result.request.context).toBe("watch");
    expect(secondRun.trigger).toContain(path.join("src", "index.ts"));
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(1);
  }, 15_000);

  it("coalesces rapid watch changes into one rerun", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-watch-burst-");
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
        "typecheck",
        "--format",
        "json",
        "--debounce-ms",
        "120",
      ],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
      { signal: controller.signal },
    );

    await waitFor(() => {
      const lines = parseJsonLines<{ event: string }>(stdout.value).filter(
        (line) => line.event === "run",
      );
      return lines.length >= 1 ? lines[0] : undefined;
    });

    await writeFile(
      project.filePath,
      "const value: string = 42;\nexport const broken = value;\n",
      "utf8",
    );
    await writeFile(project.filePath, "export const value = 2;\n", "utf8");

    const secondRun = await waitFor(() => {
      const lines = parseJsonLines<{
        event: string;
        result: { ok: boolean };
      }>(stdout.value).filter((line) => line.event === "run");
      return lines.length >= 2 ? lines[1] : undefined;
    });

    expect(secondRun.result.ok).toBe(true);

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });

    expect(
      parseJsonLines<{ event: string }>(stdout.value).filter((line) => line.event === "run"),
    ).toHaveLength(2);
    expect(stderr.value).toBe("");

    controller.abort();
    await expect(runPromise).resolves.toBe(0);
  }, 10_000);
});
