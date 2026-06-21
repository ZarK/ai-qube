import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("uses persisted current_stage and reports detected technology setup", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-doctor-progress-");
    await mkdir(path.join(project.root, ".qube", "aiq"), { recursive: true });
    await writeFile(
      path.join(project.root, ".qube", "aiq", "progress.json"),
      `${JSON.stringify({ current_stage: 3, disabled: [], order: [0, 1, 2, 3], last_run: null })}\n`,
      "utf8",
    );
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "doctor", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const output = JSON.parse(stdout.value) as {
      checks: Array<{
        detail?: string;
        name: string;
        ok: boolean;
        required?: boolean;
        source?: string;
      }>;
      detectedTech: string[];
      ok: boolean;
      stages: string[];
    };
    expect(output.ok).toBe(false);
    expect(output.stages).toEqual(["e2e", "lint", "format", "typecheck"]);
    expect(output.detectedTech).toEqual(["TypeScript"]);
    expect(output.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Biome native config", ok: true, source: "project" }),
        expect.objectContaining({
          name: "JS/TS e2e config",
          ok: false,
          required: true,
          source: "project",
        }),
        expect.objectContaining({
          name: "TypeScript project config",
          ok: true,
          required: true,
          source: "project",
        }),
        expect.objectContaining({ name: "Biome JS/TS lint/format tool", source: "bundled" }),
        expect.objectContaining({ name: "TypeScript compiler", source: "bundled" }),
      ]),
    );
  });

  it("accepts explicit doctor stage targeting flags", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-doctor-stage-targets-");

    const cases: Array<{ args: string[]; exitCode: number; stages: string[] }> = [
      { args: ["--up-to", "3"], exitCode: 1, stages: ["e2e", "lint", "format", "typecheck"] },
      { args: ["--only", "1"], exitCode: 0, stages: ["lint"] },
      { args: ["--stage", "typecheck"], exitCode: 0, stages: ["typecheck"] },
      { args: ["--profile", "standard"], exitCode: 1, stages: ["lint", "typecheck", "unit"] },
    ];

    for (const testCase of cases) {
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();
      const exitCode = await runCli(
        ["node", "aiq", "doctor", ...testCase.args, "--format", "json"],
        {
          cwd: project.root,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      expect(exitCode).toBe(testCase.exitCode);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as { stages: string[] };
      expect(output.stages).toEqual(testCase.stages);
    }
  });

  it("fails doctor when detected selected tech is missing required host tools", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-doctor-python-missing-"));
    tempDirs.push(tempDir);
    await writeFile(path.join(tempDir, "main.py"), "print('hello')\n", "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const originalPath = process.env.PATH;
    process.env.PATH = "";

    try {
      const exitCode = await runCli(
        ["node", "aiq", "doctor", "--stage", "typecheck", "--format", "json"],
        {
          cwd: tempDir,
          stderr,
          stdin: new MemoryInput(),
          stdout,
        },
      );

      expect(exitCode).toBe(1);
      expect(stderr.value).toBe("");
      const output = JSON.parse(stdout.value) as {
        checks: Array<{ detail?: string; name: string; ok: boolean; required?: boolean }>;
        detectedTech: string[];
        ok: boolean;
      };
      expect(output.ok).toBe(false);
      expect(output.detectedTech).toEqual(["Python"]);
      expect(output.checks.find((check) => check.name === "Python runtime")).toMatchObject({
        detail: expect.stringContaining("Install Python 3"),
        ok: false,
        required: true,
      });
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
