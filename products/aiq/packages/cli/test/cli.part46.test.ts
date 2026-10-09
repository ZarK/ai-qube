import { describe, expect, it } from "vitest";
import {
  os,
  path,
  MemoryInput,
  MemoryOutput,
  access,
  cp,
  createJsWorkspaceLayoutInspect,
  createSingleAppLayoutInspect,
  createTypeScriptFixtureProject,
  mkdir,
  mkdtemp,
  runCli,
  tempDirs,
  writeFile,
  writeLayoutContractFiles,
} from "./cli-test-support.js";

const aieJsWorkspace = path.resolve("../aie/test/fixtures/layout/js-workspace");
const aieSingleApp = path.resolve("../aie/test/fixtures/layout/single-app-service");

async function copyLayoutFixture(name: string, source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `aiq-cli-layout-${name}-`));
  tempDirs.push(root);
  await cp(source, root, { recursive: true });
  return root;
}

describe("CLI layout consumption", () => {
  it("scopes aiq run to the JS workspace member proven by affected JSON", async () => {
    await access(path.join(aieJsWorkspace, "packages", "core", "src", "index.ts"));
    const root = await copyLayoutFixture("js-workspace", aieJsWorkspace);
    const inspect = createJsWorkspaceLayoutInspect();
    const core = inspect.projects.find((project) => project.id === "@fixture/core");
    if (core === undefined) {
      throw new Error("JS workspace layout contract is missing @fixture/core.");
    }
    await writeLayoutContractFiles(root, inspect, {
      layout: inspect,
      changedPaths: ["packages/core/src/index.ts"],
      affectedProjects: [
        {
          project: core,
          changedPaths: ["packages/core/src/index.ts"],
          gates: ["build", "typecheck", "test"],
        },
      ],
      suggestedGates: ["build", "typecheck", "test"],
      warnings: [],
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "packages/core/src/index.ts", "--dry-run", "--format", "json"],
      {
        cwd: root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const payload = JSON.parse(stdout.value) as {
      plan: {
        layout: {
          inspect: { kind: string };
          scope: {
            kind: string;
            affectedProjectIds: string[];
            suggestedGates: string[];
            source: string;
          };
        };
        input: { files: string[] };
      };
    };
    expect(payload.plan.layout.inspect.kind).toBe("javascript-typescript-workspace");
    expect(payload.plan.layout.scope.kind).toBe("affected-projects");
    expect(payload.plan.layout.scope.affectedProjectIds).toEqual(["@fixture/core"]);
    expect(payload.plan.layout.scope.suggestedGates).toEqual(["build", "typecheck", "test"]);
    expect(payload.plan.layout.scope.source).toBe("layout-affected-json");
    expect(
      payload.plan.input.files.every((file) => file.replace(/\\/g, "/").includes("packages/core")),
    ).toBe(true);
  });

  it("runs all declared workspace members without changed paths or layout files", async () => {
    const root = await copyLayoutFixture("workspace-gate", aieJsWorkspace);
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "--dry-run", "--format", "json"], {
      cwd: root,
      stdout,
      stderr,
      stdin: new MemoryInput(),
    });
    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const payload = JSON.parse(stdout.value.slice(stdout.value.indexOf('{\n  "dryRun"')));
    expect(payload.plan.layout.scope.affectedProjectPaths.sort()).toEqual([
      "apps/web",
      "packages/core",
      "tools/cli",
    ]);
    expect(
      payload.plan.input.files.some((file: string) =>
        file.replace(/\\/gu, "/").includes("packages/core/src"),
      ),
    ).toBe(true);
    expect(
      payload.plan.input.files.some((file: string) =>
        file.replace(/\\/gu, "/").includes("apps/web/src"),
      ),
    ).toBe(true);
  });

  it("keeps a nested single-app change on the root app", async () => {
    await access(path.join(aieSingleApp, "src", "index.ts"));
    const root = await copyLayoutFixture("single-app", aieSingleApp);
    const inspect = createSingleAppLayoutInspect("single-app-fixture");
    await writeLayoutContractFiles(root, inspect, {
      layout: inspect,
      changedPaths: ["src/index.ts"],
      affectedProjects: [
        {
          project: inspect.projects[0],
          changedPaths: ["src/index.ts"],
          gates: ["build", "typecheck", "test"],
        },
      ],
      suggestedGates: ["build", "typecheck", "test"],
      warnings: [],
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "check", "src/index.ts", "--dry-run", "--format", "json"],
      {
        cwd: root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const payload = JSON.parse(stdout.value) as {
      plan: { layout: { scope: { kind: string; affectedProjectPaths: string[] } } };
    };
    expect(payload.plan.layout.scope.kind).toBe("root-app");
    expect(payload.plan.layout.scope.affectedProjectPaths).toEqual(["."]);
  });

  it("fails first-run when layout JSON is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-cli-layout-missing-"));
    tempDirs.push(root);
    await writeFile(path.join(root, "package.json"), '{"name":"missing-layout"}\n', "utf8");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();

    const exitCode = await runCli(["node", "aiq"], {
      cwd: root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("Layout inspect JSON is missing");
  });

  it("fails first-run when layout reports uncertainty", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-layout-unknown-");
    await writeLayoutContractFiles(
      project.root,
      {
        kind: "unknown",
        root: null,
        remotes: [],
        rootMarkers: [],
        projects: [],
        packageManagers: [],
        lockfiles: [],
        ciHints: [],
        generatedPaths: [],
        vendorPaths: [],
        warnings: ["Repository layout could not be classified from supported local signals."],
      },
      {
        layout: {
          kind: "unknown",
          root: null,
          remotes: [],
          rootMarkers: [],
          projects: [],
          packageManagers: [],
          lockfiles: [],
          ciHints: [],
          generatedPaths: [],
          vendorPaths: [],
          warnings: ["Repository layout could not be classified from supported local signals."],
        },
        changedPaths: ["src/index.ts"],
        affectedProjects: [],
        suggestedGates: ["test"],
        warnings: ["Repository layout could not be classified from supported local signals."],
      },
    );

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("will not run a repository-root gate");
  });

  it("fails loudly when layout inspect JSON is malformed", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-layout-malformed-");
    await writeFile(path.join(project.root, ".qube", "aiq", "layout-inspect.json"), "{", "utf8");

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stdout.value).toBe("");
    expect(stderr.value).toContain("malformed");
  });

  it("rejects parent-directory paths in layout JSON", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-layout-escape-");
    const inspect = createSingleAppLayoutInspect();
    const rootProject = inspect.projects[0];
    if (rootProject === undefined) {
      throw new Error("Single-app layout contract is missing the root project.");
    }
    inspect.projects[0] = { ...rootProject, path: "../outside" };
    await writeLayoutContractFiles(project.root, inspect, {
      layout: inspect,
      changedPaths: ["src/index.ts"],
      affectedProjects: [],
      suggestedGates: [],
      warnings: [],
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(["node", "aiq", "run", "src/index.ts"], {
      cwd: project.root,
      stderr,
      stdin: new MemoryInput(),
      stdout,
    });

    expect(exitCode).toBe(2);
    expect(stderr.value).toContain("parent-directory");
  });

  it("omits generated files from a layout-aware run", async () => {
    const project = await createTypeScriptFixtureProject("aiq-cli-layout-generated-");
    await mkdir(path.join(project.root, "dist"), { recursive: true });
    await writeFile(path.join(project.root, "dist", "bundle.js"), "export {}\n", "utf8");
    const inspect = createSingleAppLayoutInspect();
    inspect.generatedPaths = [
      { path: "dist", reason: "Generated package build output path exists." },
    ];
    await writeLayoutContractFiles(project.root, inspect, {
      layout: inspect,
      changedPaths: ["src/index.ts", "dist/bundle.js"],
      affectedProjects: [
        {
          project: inspect.projects[0],
          changedPaths: ["src/index.ts"],
          gates: ["build", "typecheck", "test"],
        },
      ],
      suggestedGates: ["build", "typecheck", "test"],
      warnings: [],
    });

    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "src/index.ts", "dist/bundle.js", "--dry-run", "--format", "json"],
      {
        cwd: project.root,
        stderr,
        stdin: new MemoryInput(),
        stdout,
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const payload = JSON.parse(stdout.value) as {
      plan: {
        input: { files: string[] };
        layout: { scope: { classifiedPaths: Array<{ path: string; classification: string }> } };
      };
    };
    expect(
      payload.plan.input.files.some((file) => file.replace(/\\/g, "/").endsWith("src/index.ts")),
    ).toBe(true);
    expect(
      payload.plan.input.files.some((file) => file.replace(/\\/g, "/").includes("/dist/")),
    ).toBe(false);
    expect(
      payload.plan.layout.scope.classifiedPaths.some((entry) => entry.path === "dist/bundle.js"),
    ).toBe(false);
  });
  it("reports ignored explicit files as failed JSON stages", async () => {
    const project = await createTypeScriptFixtureProject("aiq-ignored-target-");
    await mkdir(path.join(project.root, "dist"));
    await writeFile(path.join(project.root, "dist", "bundle.js"), "export {};\n");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "dist/bundle.js", "--only", "5", "--format", "json"],
      {
        cwd: project.root,
        stdout,
        stderr,
        stdin: new MemoryInput(),
      },
    );
    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const report = JSON.parse(stdout.value);
    expect(report.stages[0]).toMatchObject({
      status: "failed",
      notes: ["Explicit target selected no files."],
    });
    expect(report.plan.input.files).toEqual([]);
  });

  it.each([
    { name: "file list", args: ["--files-from", "empty.txt"] },
    { name: "standard input", args: ["--stdin-file-list"] },
  ])("reports an explicit empty $name as a failed stage in JSON", async ({ args }) => {
    const project = await createTypeScriptFixtureProject("aiq-empty-list-");
    await writeFile(path.join(project.root, "empty.txt"), "");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", ...args, "--only", "5", "--format", "json"],
      { cwd: project.root, stdout, stderr, stdin: new MemoryInput() },
    );
    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const report = JSON.parse(stdout.value);
    expect(report.summary.status).toBe("failed");
    expect(report.stages).toEqual([
      expect.objectContaining({
        stageId: "sloc",
        status: "failed",
        notes: ["Explicit target selected no files."],
      }),
    ]);
    expect(report.plan.input.files).toEqual([]);
  });

  it("keeps an ignored explicit target empty for diff-only full-run stages", async () => {
    const project = await createTypeScriptFixtureProject("aiq-empty-diff-target-");
    await mkdir(path.join(project.root, "dist"));
    await writeFile(path.join(project.root, "dist", "bundle.js"), "var value = 1;\n");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "dist/bundle.js", "--diff-only", "--only", "3", "--format", "json"],
      { cwd: project.root, stdout, stderr, stdin: new MemoryInput() },
    );
    expect(exitCode).toBe(1);
    expect(stderr.value).toBe("");
    const report = JSON.parse(stdout.value);
    expect(report.summary.status).toBe("failed");
    expect(report.stages).toEqual([
      expect.objectContaining({
        stageId: "typecheck",
        status: "failed",
        notes: ["Explicit target selected no files."],
        toolRuns: [],
      }),
    ]);
    expect(report.plan.input.files).toEqual([]);
  });

  it("reports an unmeasured Shell selection as warning in JSON", async () => {
    const project = await createTypeScriptFixtureProject("aiq-unmeasured-target-");
    await writeFile(path.join(project.root, "script.sh"), "echo hello\n");
    const stdout = new MemoryOutput();
    const stderr = new MemoryOutput();
    const exitCode = await runCli(
      ["node", "aiq", "run", "script.sh", "--only", "5", "--format", "json"],
      {
        cwd: project.root,
        stdout,
        stderr,
        stdin: new MemoryInput(),
      },
    );
    expect(exitCode).toBe(0);
    expect(stderr.value).toBe("");
    const report = JSON.parse(stdout.value);
    expect(report.summary.status).toBe("warning");
    expect(report.stages[0]).toMatchObject({
      status: "warning",
      notes: ["No supported files were selected for sloc."],
    });
  });
});
