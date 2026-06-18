import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("uses repo config surface defaults for plan requests", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-surface-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "aiq.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            standard: {
              changedOnly: true,
              stages: ["lint", "unit"],
            },
          },
          surfaces: {
            cli: {
              profile: "standard",
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
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[]; profile: string };
    expect(output.profile).toBe("standard");
    expect(output.stages).toEqual(["lint", "unit"]);
  });

  it("uses persisted current_stage as the default cumulative plan target", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-plan-progress-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await mkdir(path.join(tempDir, "src"), { recursive: true });
    await writeFile(path.join(tempDir, "src/index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(tempDir, ".aiq", "aiq.config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(tempDir, ".aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 6, disabled: [], order: [0, 1, 2, 3, 4, 5, 6], last_run: null })}\n`,
      "utf8",
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "plan", "src/index.ts", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");

    const output = JSON.parse(stdout.value) as { stages: string[] };
    expect(output.stages).toEqual([
      "e2e",
      "lint",
      "format",
      "typecheck",
      "unit",
      "sloc",
      "complexity",
    ]);
  });
});
