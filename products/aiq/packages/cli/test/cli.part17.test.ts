import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  os,
  path,
  readFile,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("initializes canonical config and progress files with aiq config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-init-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("AIQ config initialized");
    expect(stdout.value).toContain(path.join(tempDir, ".qube", "aiq", "config.json"));
    expect(stdout.value).toContain(path.join(tempDir, ".qube", "aiq", "progress.json"));

    const config = JSON.parse(
      await readFile(path.join(tempDir, ".qube", "aiq", "config.json"), "utf8"),
    ) as { version: number };
    const progress = JSON.parse(
      await readFile(path.join(tempDir, ".qube", "aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; disabled: number[]; last_run: string | null; order: number[] };
    expect(config).toEqual({ version: 1 });
    expect(progress).toEqual({
      current_stage: 1,
      disabled: [],
      order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      last_run: null,
    });
  });

  it("fails fast when aiq config finds malformed existing config", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-invalid-init-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".aiq"), { recursive: true });
    await writeFile(path.join(tempDir, ".aiq", "aiq.config.json"), '{"version":1,}\n', "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Failed to parse");
  });

  it("prints effective config with persisted progress state", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-print-"));
    tempDirs.push(tempDir);
    await mkdir(path.join(tempDir, ".qube", "aiq"), { recursive: true });
    await writeFile(path.join(tempDir, ".qube", "aiq", "config.json"), '{"version":1}\n', "utf8");
    await writeFile(
      path.join(tempDir, ".qube", "aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--print-config", "--format", "json"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      config: { version: number };
      progress: { current_stage: number; order: number[] };
      progressSource: string;
      profile: string;
      stages: string[];
    };
    expect(output.config.version).toBe(1);
    expect(output.progress.current_stage).toBe(3);
    expect(output.progress.order).toEqual([0, 1, 2, 3]);
    expect(output.progressSource).toBe("file");
    expect(output.profile).toBe("fast");
    expect(output.stages).toEqual(["lint"]);
  });

  it("persists current_stage with aiq config --set-stage", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-config-set-stage-"));
    tempDirs.push(tempDir);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--set-stage", "6"], {
      cwd: tempDir,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain("Set current_stage=6");

    const progress = JSON.parse(
      await readFile(path.join(tempDir, ".qube", "aiq", "progress.json"), "utf8"),
    ) as { current_stage: number; order: number[] };
    expect(progress.current_stage).toBe(6);
    expect(progress.order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("rejects invalid aiq config --set-stage values", async () => {
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "config", "--set-stage", "10"], {
      cwd: process.cwd(),
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("--set-stage must be between 0 and 9");
  });
});
