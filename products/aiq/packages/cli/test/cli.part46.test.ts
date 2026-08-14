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
    expect(payload.plan.layout.scope.classifiedPaths).toEqual(
      expect.arrayContaining([{ path: "dist/bundle.js", classification: "generated" }]),
    );
  });
});
