import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { StageResult } from "../src/contracts.js";
import { runPlannedTask } from "../src/runners.js";
import { ToolRunner } from "../src/tool-runner.js";

const fixtureTerraformRoot = path.resolve("test-projects/terraform");
const fixtureHclRoot = path.resolve("test-projects/hcl");
const hasTerraform = commandAvailable("terraform");
const fakeGitHubToken = ["ghp", "123456789012345678901234567890123456"].join("_");
const tempDirs: string[] = [];

function commandAvailable(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function createTerraformFixtureProject(
  prefix: string,
): Promise<{ mainFile: string; root: string; variablesFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await mkdir(root, { recursive: true });
  await cp(fixtureTerraformRoot, root, { recursive: true });

  return {
    mainFile: path.join(root, "main.tf"),
    root,
    variablesFile: path.join(root, "variables.tf"),
  };
}

async function createHclFixtureProject(
  prefix: string,
): Promise<{ configFile: string; root: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await mkdir(root, { recursive: true });
  await cp(fixtureHclRoot, root, { recursive: true });

  return {
    configFile: path.join(root, "config.hcl"),
    root,
  };
}

async function createTerraformJsonFixtureProject(
  prefix: string,
): Promise<{ root: string; terraformJsonFile: string }> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(workspaceRoot);

  const root = path.join(workspaceRoot, "project");
  await mkdir(root, { recursive: true });

  const terraformJsonFile = path.join(root, "main.tf.json");
  await writeFile(
    terraformJsonFile,
    `${JSON.stringify({ terraform: { required_version: ">= 1.0.0" } }, null, 2)}\n`,
    "utf8",
  );

  return {
    root,
    terraformJsonFile,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

function expectMissingTerraformResult(result: StageResult, file: string): void {
  expect(JSON.stringify(result)).not.toContain("not_implemented");
  expect(result.status).toBe("failed");
  expect(result.notes[0]).toContain("requires the 'terraform' binary");
  expect(result.notes[0]).toContain("aiq doctor");
  expect(result.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file,
        severity: "error",
        source: "terraform",
      }),
    ]),
  );
  expect(result.diagnostics[0]?.message).toContain("requires the 'terraform' binary");
  expect(result.toolRuns).toEqual(
    expect.arrayContaining([expect.objectContaining({ status: "failed", tool: "terraform" })]),
  );
}

describe("Terraform and HCL runners", () => {
  it("runs generic HCL lint and reports syntax diagnostics", async () => {
    const project = await createHclFixtureProject("aiq-hcl-lint-fail-");
    await writeFile(
      project.configFile,
      ['container "web" {', "  image =", "}", ""].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.configFile],
        id: "test-run:hcl:lint-fail",
        stageId: "lint",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.configFile);
      return;
    }

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.configFile,
      severity: "error",
      source: "terraform-hcl-lint",
    });
    expect(result.diagnostics[0]?.range).toMatchObject({
      startLine: 2,
    });
    expect(result.toolRuns[0]).toMatchObject({
      status: "failed",
      tool: "terraform-hcl-lint",
    });
  }, 20_000);

  it("runs generic HCL format and reports formatting diagnostics", async () => {
    const project = await createHclFixtureProject("aiq-hcl-format-");
    await writeFile(project.configFile, 'container "web"{image="nginx:latest"}\n', "utf8");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.configFile],
        id: "test-run:hcl:format",
        stageId: "format",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.configFile);
      return;
    }

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.configFile,
      message: "File requires formatting.",
      severity: "error",
      source: "terraform-hcl-format",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 3,
      status: "failed",
      tool: "terraform-hcl-format",
    });
  }, 20_000);

  it("runs the shared security scan for Terraform and HCL inputs", async () => {
    const terraformProject = await createTerraformFixtureProject("aiq-tf-security-");
    const hclProject = await createHclFixtureProject("aiq-hcl-security-");

    await writeFile(
      terraformProject.mainFile,
      [
        "terraform {",
        '  required_version = ">= 1.0.0"',
        "}",
        "",
        `locals { token = "${fakeGitHubToken}" }`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      hclProject.configFile,
      [`locals { token = "${fakeGitHubToken}" }`, ""].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 2,
        files: [terraformProject.mainFile, hclProject.configFile],
        id: "test-run:terraform-hcl:security",
        stageId: "security",
      },
      terraformProject.root,
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: terraformProject.mainFile,
          severity: "error",
          source: "aiq-security",
        }),
        expect.objectContaining({
          file: hclProject.configFile,
          severity: "error",
          source: "aiq-security",
        }),
      ]),
    );
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });
});
