import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  createGoFixtureProject,
  createRustFixtureProject,
  expectProjectResolutionFailure,
  mkdtemp,
  os,
  path,
  runPlannedTask,
  tempDirs,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it("keeps supported Go typecheck while reporting unsupported selected Go files", async () => {
    const project = await createGoFixtureProject("aiq-mixed-go-resolution-");
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-go-no-module-"));
    tempDirs.push(unsupportedRoot);
    const unsupportedFile = path.join(unsupportedRoot, "orphan.go");
    await writeFile(unsupportedFile, "package orphan\n", "utf8");

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveInstalledBinary").mockResolvedValue("go");
    vi.spyOn(toolRunner, "run").mockResolvedValue({
      durationMs: 5,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: "",
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: { files: [project.sourceFile, unsupportedFile], source: "direct" },
        mode: "check",
        outDir: project.root,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [project.sourceFile, unsupportedFile],
        id: "test:1:typecheck-go-mixed-resolution",
        stageId: "typecheck",
      },
      engineContext,
    );

    expectProjectResolutionFailure(result, {
      artifact: "go.mod",
      file: unsupportedFile,
      source: "go-unavailable",
    });
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "go-build" });
    expect(result.notes.join(" ")).toContain("go build passed");
  });

  it("keeps supported Rust typecheck while reporting unsupported selected Rust files", async () => {
    const project = await createRustFixtureProject("aiq-mixed-rust-resolution-");
    const unsupportedRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-rust-no-manifest-"));
    tempDirs.push(unsupportedRoot);
    const unsupportedFile = path.join(unsupportedRoot, "orphan.rs");
    await writeFile(unsupportedFile, "fn orphan() {}\n", "utf8");

    const toolRunner = new ToolRunner();
    vi.spyOn(toolRunner, "resolveInstalledBinary").mockResolvedValue("cargo");
    vi.spyOn(toolRunner, "createRustProcessEnv").mockResolvedValue({});
    vi.spyOn(toolRunner, "run").mockResolvedValue({
      durationMs: 5,
      exitCode: 0,
      finishedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      stderr: "",
      stdout: "",
    });

    const engineContext = withToolRunnerOverride(
      await buildEngineContext({
        context: "cli",
        manifest: { files: [project.sourceFile, unsupportedFile], source: "direct" },
        mode: "check",
        outDir: project.root,
        stages: ["typecheck"],
      }),
      toolRunner,
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [project.sourceFile, unsupportedFile],
        id: "test:1:typecheck-rust-mixed-resolution",
        stageId: "typecheck",
      },
      engineContext,
    );

    expectProjectResolutionFailure(result, {
      artifact: "Cargo.toml",
      file: unsupportedFile,
      source: "rust-unavailable",
    });
    expect(result.toolRuns[0]).toMatchObject({ status: "passed", tool: "cargo-check" });
    expect(result.notes.join(" ")).toContain("cargo check passed");
  });
});
