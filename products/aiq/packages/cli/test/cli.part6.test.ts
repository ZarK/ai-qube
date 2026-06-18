import { describe, expect, it } from "vitest";
import {
  MemoryInput,
  MemoryOutput,
  createTypeScriptFixtureProject,
  mkdir,
  path,
  runCli,
  writeFile,
} from "./cli-test-support.js";
describe("CLI foundation", () => {
  it("keeps option-only aiq invocations on the configured project gate", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-json-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain('"firstRun"');
    expect(stdout.value).toContain('"target": "."');
    expect(stdout.value).toContain('"mode": "check"');
    expect(stdout.value).toContain('"source": "direct"');
  });

  it("prints a first-run dry-run plan for the configured project gate", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-dry-run-");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq", "--dry-run", "--format", "json"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    expect(stdout.value).toContain('"firstRun"');
    expect(stdout.value).toContain('"target": "."');
    expect(stdout.value).toContain('"dryRun": true');
    expect(stdout.value).toContain('"input"');
  });

  it("keeps first-run and doctor scoped to product tech when reference directories contain foreign projects", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-first-run-reference-scope-");
    await Promise.all([
      mkdir(path.join(project.root, "docs"), { recursive: true }),
      mkdir(path.join(project.root, "examples", "jvm"), { recursive: true }),
      mkdir(path.join(project.root, "fixtures", "rust"), { recursive: true }),
      mkdir(path.join(project.root, "reference", "python"), { recursive: true }),
      mkdir(path.join(project.root, "references", "go"), { recursive: true }),
      mkdir(path.join(project.root, "samples", "dotnet"), { recursive: true }),
      mkdir(path.join(project.root, "test-projects", "go"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(project.root, "docs", "example.py"), "print('reference only')\n", "utf8"),
      writeFile(path.join(project.root, "examples", "jvm", "pom.xml"), "<project />\n", "utf8"),
      writeFile(path.join(project.root, "fixtures", "rust", "Cargo.toml"), "[package]\n", "utf8"),
      writeFile(
        path.join(project.root, "reference", "python", "pyproject.toml"),
        "[project]\nname = 'reference'\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "references", "go", "go.mod"),
        "module references\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "samples", "dotnet", "Reference.csproj"),
        "<Project />\n",
        "utf8",
      ),
      writeFile(
        path.join(project.root, "test-projects", "go", "go.mod"),
        "module reference\n",
        "utf8",
      ),
    ]);

    const doctorStdout = new MemoryOutput();
    const doctorStderr = new MemoryOutput();
    const doctorExitCode = await runCli(
      ["node", "aiq", "doctor", "--stage", "typecheck", "--format", "json"],
      {
        cwd: project.root,
        stderr: doctorStderr,
        stdin: new MemoryInput(),
        stdout: doctorStdout,
      },
    );

    expect(doctorExitCode).toBe(0);
    expect(doctorStderr.value).toBe("");
    const doctorOutput = JSON.parse(doctorStdout.value) as { detectedTech: string[]; ok: boolean };
    expect(doctorOutput.ok).toBe(true);
    expect(doctorOutput.detectedTech).toEqual(["TypeScript"]);

    const firstRunStdout = new MemoryOutput();
    const firstRunStderr = new MemoryOutput();
    const firstRunExitCode = await runCli(
      ["node", "aiq", "--stage", "typecheck", "--dry-run", "--format", "json"],
      {
        cwd: project.root,
        stderr: firstRunStderr,
        stdin: new MemoryInput(),
        stdout: firstRunStdout,
      },
    );

    expect(firstRunExitCode).toBe(0);
    expect(firstRunStderr.value).toBe("");
    expect(firstRunStdout.value).toContain('"detectedProjects"');
    expect(firstRunStdout.value).toContain('"dryRun": true');
    expect(firstRunStdout.value).toContain('"typecheck"');
    expect(firstRunStdout.value).not.toContain("example.py");
    expect(firstRunStdout.value).not.toContain("pom.xml");
    expect(firstRunStdout.value).not.toContain("Cargo.toml");
    expect(firstRunStdout.value).not.toContain("pyproject.toml");
    expect(firstRunStdout.value).not.toContain("Reference.csproj");
    expect(firstRunStdout.value).not.toContain("go.mod");
  });
});
