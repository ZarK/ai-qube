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
});
