import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRunner } from "../../engine/src/tool-runner.js";
import {
  MemoryInput,
  MemoryOutput,
  access,
  initializeGitRepository,
  mkdir,
  mkdtemp,
  os,
  path,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";

afterEach(() => vi.restoreAllMocks());

async function createProject(files: Record<string, string>, ignore: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-input-discovery-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".qube", "aiq"), { recursive: true });
  await writeFile(
    path.join(root, ".qube", "aiq", "config.json"),
    JSON.stringify({ version: 1, inputs: { ignore } }),
  );
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, "app", name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

async function runProject(root: string, stages: string, extraArgs: string[] = []) {
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const stageArgs =
    stages === "5,6,7"
      ? ["--stage", "sloc", "--stage", "complexity", "--stage", "maintainability"]
      : ["--only", stages];
  const exitCode = await runCli(
    ["node", "aiq", "run", "app", ...stageArgs, "--format", "json", ...extraArgs],
    { cwd: root, stdout, stderr, stdin: new MemoryInput() },
  );
  expect(stderr.value).toBe("");
  return { exitCode, report: JSON.parse(stdout.value) };
}

describe("CLI project source exclusions", () => {
  it.each(["1", "2", "3"])("keeps ignored Python sources out of stage %s", async (stage) => {
    const root = await createProject(
      {
        "pyproject.toml": "[project]\nname = 'app'\nversion = '1.0'\n",
        "ignored.py": "invalid python !!!\n",
        "nested/ignored.py": "invalid python !!!\n",
      },
      ["**/*.py"],
    );
    const { exitCode, report } = await runProject(root, stage);
    expect(exitCode).toBe(0);
    expect(report.plan.input.files).toEqual([path.join(root, "app", "pyproject.toml")]);
    expect(report.stages).toEqual([
      expect.objectContaining({
        status: "warning",
        toolRuns: [],
        notes: expect.arrayContaining([expect.stringMatching(/No .*files/)]),
      }),
    ]);
  });

  it("preserves exclusions through diff-only full-stage workspace selection", async () => {
    const root = await createProject(
      {
        "pyproject.toml": "[project]\nname = 'app'\nversion = '1.0'\n",
        "ignored.py": "invalid python !!!\n",
      },
      ["**/*.py", ".qube/**"],
    );
    await initializeGitRepository(root);
    const { exitCode, report } = await runProject(root, "3", ["--diff-only"]);
    expect(exitCode).toBe(0);
    expect(report.plan.input.files).toEqual([path.join(root, "app", "pyproject.toml")]);
    expect(report.stages[0]).toMatchObject({
      status: "warning",
      toolRuns: [],
      notes: ["No supported files were selected for typecheck."],
    });
  });

  it.each([
    {
      language: "C#",
      marker: "App.csproj",
      content: '<Project Sdk="Microsoft.NET.Sdk" />',
      source: "Ignored.cs",
    },
    {
      language: "JavaScript",
      marker: "package.json",
      content: '{"name":"app"}',
      source: "ignored.js",
    },
    {
      language: "TypeScript",
      marker: "package.json",
      content: '{"name":"app"}',
      source: "ignored.ts",
    },
    {
      language: "Go",
      marker: "go.mod",
      content: "module example.com/app\n\ngo 1.23\n",
      source: "ignored.go",
    },
    {
      language: "Rust",
      marker: "Cargo.toml",
      content: '[package]\nname = "app"\nversion = "0.1.0"\n',
      source: "ignored.rs",
    },
    { language: "Java", marker: "pom.xml", content: "<project></project>", source: "Ignored.java" },
    { language: "Kotlin", marker: "build.gradle.kts", content: "", source: "Ignored.kt" },
    {
      language: "Python",
      marker: "pyproject.toml",
      content: "[project]\nname = 'app'\nversion = '1.0'\n",
      source: "ignored.py",
    },
  ])(
    "does not rediscover excluded $language sources for metrics",
    async ({ marker, content, source }) => {
      const root = await createProject(
        {
          [marker]: content,
          [source]: "invalid source !!!\n",
          [`nested/${source}`]: "invalid source !!!\n",
        },
        [`**/*${path.extname(source)}`],
      );
      const { exitCode, report } = await runProject(root, "5,6,7");
      expect(exitCode).toBe(0);
      expect(report.plan.input.files).toEqual([path.join(root, "app", marker)]);
      expect(report.stages).toHaveLength(3);
      for (const stage of report.stages) {
        expect(stage).toMatchObject({ status: "warning", toolRuns: [] });
        expect(stage.notes.join(" ")).toMatch(/no .*files/i);
      }
    },
  );

  it.each([
    { language: "Bash", source: "main.sh", test: "nested/main.bats" },
    { language: "PowerShell", source: "main.ps1", test: "nested/main.Tests.ps1" },
  ])("does not rediscover ignored $language tests", async ({ language, source, test }) => {
    const root = await createProject({ [source]: "# source\n", [test]: "invalid test !!!\n" }, [
      "nested/**",
    ]);
    const { report } = await runProject(root, "4");
    expect(report.stages[0].notes.join(" ")).toContain(`No ${language} test files`);
  });

  it("does not discover sources in an ignored project referenced by a C# solution", async () => {
    const root = await createProject(
      {
        "App.slnx": '<Solution><Project Path="excluded/App.csproj" /></Solution>',
        "excluded/App.csproj": '<Project Sdk="Microsoft.NET.Sdk" />',
        "excluded/Source.cs": "class Source {}\n",
      },
      ["excluded"],
    );
    const { exitCode, report } = await runProject(root, "5,6,7");
    expect(exitCode).toBe(0);
    expect(report.plan.input.files).toEqual([path.join(root, "app", "App.slnx")]);
    for (const stage of report.stages) {
      expect(stage).toMatchObject({ status: "warning", toolRuns: [] });
    }
  });

  it("omits ignored Terraform files from the validation project", async () => {
    const root = await createProject(
      {
        "main.tf": "terraform {}\n",
        "ignored.tf": "invalid terraform !!!\n",
        "nested/ignored.tf": "invalid terraform !!!\n",
      },
      ["**/ignored.tf"],
    );
    vi.spyOn(ToolRunner.prototype, "resolveRequiredBinary").mockResolvedValue("terraform");
    const run = vi
      .spyOn(ToolRunner.prototype, "run")
      .mockImplementation(async (_command, args, options) => {
        if (args[0] === "init" || args[0] === "validate") {
          await expect(access(path.join(options.cwd, "main.tf"))).resolves.toBeUndefined();
          await expect(access(path.join(options.cwd, "ignored.tf"))).rejects.toThrow();
          await expect(access(path.join(options.cwd, "nested", "ignored.tf"))).rejects.toThrow();
        }
        return {
          durationMs: 1,
          exitCode: 0,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          stderr: "",
          stdout: args[0] === "validate" ? '{"valid":true,"diagnostics":[]}' : "",
        };
      });
    const { exitCode, report } = await runProject(root, "1");
    expect(exitCode).toBe(0);
    expect(report.stages[0].status).toBe("passed");
    expect(
      run.mock.calls.filter(([, args]) => args[0] === "init" || args[0] === "validate"),
    ).toHaveLength(2);
  });
});
