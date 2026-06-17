import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildProjectGraph,
  selectDotNetProjects,
  selectGoProjects,
  selectJavaScriptPackageProjects,
  selectJavaScriptProjects,
  selectJvmProjects,
  selectPythonProjects,
  selectRustProjects,
  selectScriptProjects,
  selectTerraformProjects,
  selectTypeScriptProjects,
} from "../src/graph.js";
import { normalizeFileManifest } from "../src/index.js";

const fixtureBashRoot = path.resolve("test-projects/bash");
const fixtureDotNetRoot = path.resolve("test-projects/dotnet");
const fixtureGoRoot = path.resolve("test-projects/go");
const fixtureJavaMavenRoot = path.resolve("test-projects/java-maven");
const fixturePowerShellRoot = path.resolve("test-projects/powershell");
const fixturePythonRoot = path.resolve("test-projects/python");
const fixtureRustRoot = path.resolve("test-projects/rust");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createTypeScriptWorkspace(): Promise<{
  packageJsonPath: string;
  root: string;
  sourceFile: string;
  tsconfigPath: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-ts-"));
  tempDirs.push(root);

  const srcDir = path.join(root, "src");
  await mkdir(srcDir, { recursive: true });

  const packageJsonPath = path.join(root, "package.json");
  const tsconfigPath = path.join(root, "tsconfig.json");
  const vitestConfigPath = path.join(root, "vitest.config.ts");
  const sourceFile = path.join(srcDir, "index.ts");

  await writeFile(
    packageJsonPath,
    JSON.stringify(
      {
        name: "graph-fixture",
        private: true,
        scripts: {
          test: "vitest run",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    tsconfigPath,
    JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
        },
        include: ["src/**/*.ts", "vitest.config.ts"],
      },
      null,
      2,
    ),
  );
  await writeFile(vitestConfigPath, "export default {};\n", "utf8");
  await writeFile(sourceFile, "export const answer = 42;\n", "utf8");

  return {
    packageJsonPath,
    root,
    sourceFile,
    tsconfigPath,
  };
}

async function createDotNetWorkspace(): Promise<{
  projectFile: string;
  root: string;
  solutionFile: string;
  sourceFile: string;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-dotnet-"));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureDotNetRoot, root, { recursive: true });

  return {
    projectFile: path.join(root, "src", "DotNetFixture", "DotNetFixture.csproj"),
    root,
    solutionFile: path.join(root, "DotNetFixture.slnx"),
    sourceFile: path.join(root, "src", "DotNetFixture", "Greeter.cs"),
  };
}

async function createJvmWorkspace(): Promise<{
  buildFile: string;
  root: string;
  sourceFile: string;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-jvm-"));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureJavaMavenRoot, root, { recursive: true });

  return {
    buildFile: path.join(root, "pom.xml"),
    root,
    sourceFile: path.join(root, "src", "main", "java", "dev", "aiq", "fixture", "Greeting.java"),
  };
}

async function createHashicorpWorkspace(): Promise<{
  hclFile: string;
  root: string;
  terraformFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-hashicorp-"));
  tempDirs.push(root);

  const terraformFile = path.join(root, "main.tf");
  const hclFile = path.join(root, "config.hcl");
  await mkdir(root, { recursive: true });
  await writeFile(terraformFile, 'terraform { required_version = ">= 1.0.0" }\n', "utf8");
  await writeFile(hclFile, 'container "web" { image = "nginx:latest" }\n', "utf8");

  return { hclFile, root, terraformFile };
}

async function createGoWorkspace(): Promise<{
  moduleFile: string;
  root: string;
  sourceFile: string;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-go-"));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureGoRoot, root, { recursive: true });

  return {
    moduleFile: path.join(root, "go.mod"),
    root,
    sourceFile: path.join(root, "greeter.go"),
  };
}

async function createRustWorkspace(): Promise<{
  manifestFile: string;
  root: string;
  sourceFile: string;
}> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-rust-"));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureRustRoot, root, { recursive: true });

  return {
    manifestFile: path.join(root, "Cargo.toml"),
    root,
    sourceFile: path.join(root, "src", "lib.rs"),
  };
}

async function createScriptWorkspace(
  fixtureRoot: string,
  prefix: string,
  sourceRelativePath: string,
): Promise<{ packageJsonFile: string; root: string; sourceFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await cp(fixtureRoot, root, { recursive: true });

  return {
    packageJsonFile: path.join(root, "package.json"),
    root,
    sourceFile: path.join(root, sourceRelativePath),
  };
}

describe("project graph", () => {
  it("maps overlapping TypeScript and JavaScript package ownership for a source file", async () => {
    const workspace = await createTypeScriptWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([
      `javascript-package:${workspace.packageJsonPath}`,
      `typescript-typecheck:${workspace.tsconfigPath}`,
    ]);

    await expect(selectJavaScriptProjects(graph, [workspace.sourceFile])).resolves.toEqual({
      projects: [
        {
          executionMode: "npm",
          files: [workspace.sourceFile],
          projectRoot: workspace.root,
          runner: "vitest",
        },
      ],
      unsupportedProjects: [],
    });

    expect(selectTypeScriptProjects(graph, [workspace.sourceFile])).toEqual({
      projects: [
        {
          files: [workspace.sourceFile],
          projectRoot: workspace.root,
          tsconfigPath: workspace.tsconfigPath,
        },
      ],
      unsupportedFiles: [],
    });
  });

  it("reuses the JavaScript project lookup across a single selection pass", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-js-selection-"));
    tempDirs.push(root);

    const packageARoot = path.join(root, "package-a");
    const packageBRoot = path.join(root, "package-b");
    const packageAFile = path.join(packageARoot, "src", "index.ts");
    const packageBFile = path.join(packageBRoot, "src", "index.ts");

    await mkdir(path.dirname(packageAFile), { recursive: true });
    await mkdir(path.dirname(packageBFile), { recursive: true });
    await writeFile(
      path.join(packageARoot, "package.json"),
      `${JSON.stringify({ name: "package-a", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(packageBRoot, "package.json"),
      `${JSON.stringify({ name: "package-b", private: true }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(packageAFile, "export const packageA = 1;\n", "utf8");
    await writeFile(packageBFile, "export const packageB = 2;\n", "utf8");

    const manifest = await normalizeFileManifest(
      {
        files: [packageAFile, packageBFile],
        source: "direct",
      },
      root,
    );

    const graph = await buildProjectGraph(manifest);
    const instrumentedProjects = [...graph.projects];
    const originalMap = instrumentedProjects.map.bind(instrumentedProjects);
    let mapCalls = 0;

    instrumentedProjects.map = function map(callbackfn, thisArg) {
      mapCalls += 1;
      return originalMap(callbackfn, thisArg);
    };

    expect(
      selectJavaScriptPackageProjects(
        {
          ...graph,
          projects: instrumentedProjects,
        },
        [packageAFile, packageBFile],
      ),
    ).toEqual({
      projects: [
        {
          files: [packageAFile],
          packageJsonPath: path.join(packageARoot, "package.json"),
          projectRoot: packageARoot,
        },
        {
          files: [packageBFile],
          packageJsonPath: path.join(packageBRoot, "package.json"),
          projectRoot: packageBRoot,
        },
      ],
      unsupportedFiles: [],
    });
    expect(mapCalls).toBe(1);
  });

  it("fails async JavaScript graph selection when package metadata is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-js-invalid-"));
    tempDirs.push(root);

    const srcDir = path.join(root, "src");
    await mkdir(srcDir, { recursive: true });

    const sourceFile = path.join(srcDir, "index.ts");
    const packageJsonPath = path.join(root, "package.json");

    await writeFile(packageJsonPath, "{\n", "utf8");
    await writeFile(sourceFile, "export const answer = 42;\n", "utf8");

    const manifest = await normalizeFileManifest(
      {
        files: [sourceFile],
        source: "direct",
      },
      root,
    );

    const graph = await buildProjectGraph(manifest);

    await expect(selectJavaScriptProjects(graph, [sourceFile])).rejects.toThrow(
      `Failed to read package metadata at "${packageJsonPath}"`,
    );
  });

  it("fails async JavaScript graph selection when package metadata is unreadable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-graph-js-unreadable-"));
    tempDirs.push(root);

    const srcDir = path.join(root, "src");
    await mkdir(srcDir, { recursive: true });

    const sourceFile = path.join(srcDir, "index.ts");
    const packageJsonPath = path.join(root, "package.json");

    await mkdir(packageJsonPath, { recursive: true });
    await writeFile(sourceFile, "export const answer = 42;\n", "utf8");

    const manifest = await normalizeFileManifest(
      {
        files: [sourceFile],
        source: "direct",
      },
      root,
    );

    const graph = await buildProjectGraph(manifest);

    await expect(selectJavaScriptProjects(graph, [sourceFile])).rejects.toThrow(
      `Failed to read package metadata at "${packageJsonPath}"`,
    );
  });

  it("records both dotnet project and solution ownership and honors selector preference", async () => {
    const workspace = await createDotNetWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.projectFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([
      `dotnet-project:${workspace.projectFile}`,
      `dotnet-solution:${workspace.solutionFile}`,
    ]);

    expect(graph.fileToProjectIds[workspace.projectFile]).toEqual([
      `dotnet-project:${workspace.projectFile}`,
      `dotnet-solution:${workspace.solutionFile}`,
    ]);

    expect(selectDotNetProjects(graph, [workspace.sourceFile], "prefer-project")).toEqual({
      projects: [
        {
          files: [workspace.sourceFile],
          projectRoot: path.dirname(workspace.projectFile),
          targetPath: workspace.projectFile,
        },
      ],
      unsupportedFiles: [],
    });

    expect(selectDotNetProjects(graph, [workspace.sourceFile], "prefer-solution")).toEqual({
      projects: [
        {
          files: [workspace.sourceFile],
          projectRoot: workspace.root,
          targetPath: workspace.solutionFile,
        },
      ],
      unsupportedFiles: [],
    });

    expect(selectDotNetProjects(graph, [workspace.projectFile], "prefer-project")).toEqual({
      projects: [
        {
          files: [workspace.projectFile],
          projectRoot: path.dirname(workspace.projectFile),
          targetPath: workspace.projectFile,
        },
      ],
      unsupportedFiles: [],
    });

    expect(selectDotNetProjects(graph, [workspace.projectFile], "prefer-solution")).toEqual({
      projects: [
        {
          files: [workspace.projectFile],
          projectRoot: workspace.root,
          targetPath: workspace.solutionFile,
        },
      ],
      unsupportedFiles: [],
    });
  });

  it("groups JVM source files under the extracted selector", async () => {
    const workspace = await createJvmWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.buildFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([`jvm:${workspace.buildFile}`]);
    expect(graph.fileToProjectIds[workspace.buildFile]).toEqual([`jvm:${workspace.buildFile}`]);
    expect(selectJvmProjects(graph, [workspace.sourceFile])).toEqual({
      projects: [
        {
          buildFilePath: workspace.buildFile,
          buildSystem: "maven",
          files: [workspace.sourceFile],
          projectRoot: workspace.root,
        },
      ],
      unsupportedFiles: [],
    });
  });

  it("groups Python fixture files under the extracted graph selector", async () => {
    const configFile = path.join(fixturePythonRoot, "pyproject.toml");
    const sourceFile = path.join(fixturePythonRoot, "main.py");
    const testFile = path.join(fixturePythonRoot, "tests", "test_main.py");
    const manifest = await normalizeFileManifest(
      {
        files: [configFile, sourceFile, testFile],
        source: "direct",
      },
      fixturePythonRoot,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[configFile]).toEqual([`python:${fixturePythonRoot}`]);
    expect(graph.fileToProjectIds[sourceFile]).toEqual([`python:${fixturePythonRoot}`]);
    expect(graph.fileToProjectIds[testFile]).toEqual([`python:${fixturePythonRoot}`]);
    expect(selectPythonProjects(graph, [configFile, sourceFile, testFile])).toEqual([
      {
        files: [sourceFile, configFile, testFile],
        projectRoot: fixturePythonRoot,
      },
    ]);
  });

  it("groups Go files under the extracted graph selector", async () => {
    const workspace = await createGoWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.moduleFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([`go:${workspace.moduleFile}`]);
    expect(graph.fileToProjectIds[workspace.moduleFile]).toEqual([`go:${workspace.moduleFile}`]);
    expect(selectGoProjects(graph, [workspace.sourceFile])).toEqual({
      projects: [
        {
          files: [workspace.sourceFile],
          moduleFilePath: workspace.moduleFile,
          projectRoot: workspace.root,
        },
      ],
      unsupportedFiles: [],
    });
  });

  it("groups Rust files under the extracted graph selector", async () => {
    const workspace = await createRustWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.manifestFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([
      `rust:${workspace.manifestFile}`,
    ]);
    expect(graph.fileToProjectIds[workspace.manifestFile]).toEqual([
      `rust:${workspace.manifestFile}`,
    ]);
    expect(selectRustProjects(graph, [workspace.sourceFile])).toEqual({
      projects: [
        {
          files: [workspace.sourceFile],
          manifestPath: workspace.manifestFile,
          projectRoot: workspace.root,
        },
      ],
      unsupportedFiles: [],
    });
  });

  it("groups Bash files under the shared script selector", async () => {
    const workspace = await createScriptWorkspace(
      fixtureBashRoot,
      "aiq-engine-graph-bash-",
      "example.sh",
    );
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.packageJsonFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([`script:${workspace.root}`]);
    expect(selectScriptProjects(graph, [workspace.sourceFile])).toEqual([
      {
        files: [workspace.sourceFile],
        projectRoot: workspace.root,
      },
    ]);
  });

  it("groups PowerShell files under the shared script selector", async () => {
    const workspace = await createScriptWorkspace(
      fixturePowerShellRoot,
      "aiq-engine-graph-powershell-",
      "example.ps1",
    );
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.packageJsonFile, workspace.sourceFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.sourceFile]).toEqual([`script:${workspace.root}`]);
    expect(selectScriptProjects(graph, [workspace.sourceFile])).toEqual([
      {
        files: [workspace.sourceFile],
        projectRoot: workspace.root,
      },
    ]);
  });

  it("groups Terraform and HCL files under the shared extracted selector", async () => {
    const workspace = await createHashicorpWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.terraformFile, workspace.hclFile],
        source: "direct",
      },
      workspace.root,
    );

    const graph = await buildProjectGraph(manifest);

    expect(graph.fileToProjectIds[workspace.terraformFile]).toEqual([
      `terraform-directory:${workspace.root}`,
    ]);
    expect(graph.fileToProjectIds[workspace.hclFile]).toEqual([
      `terraform-directory:${workspace.root}`,
    ]);
    expect(selectTerraformProjects(graph, [workspace.terraformFile, workspace.hclFile])).toEqual([
      {
        files: [workspace.hclFile, workspace.terraformFile],
        hclFiles: [workspace.hclFile],
        projectRoot: workspace.root,
        terraformFiles: [workspace.terraformFile],
      },
    ]);
  });
});
