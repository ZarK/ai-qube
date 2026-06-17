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
  it.each(["lint", "format", "typecheck"] as const)(
    "reports missing Terraform binary as a setup failure for %s",
    async (stageId) => {
      vi.spyOn(ToolRunner.prototype, "resolveBinaryIfAvailable").mockResolvedValue(undefined);

      const project = await createTerraformFixtureProject(`aiq-tf-missing-${stageId}-`);

      const result = await runPlannedTask(
        {
          fileCount: 1,
          files: [project.mainFile],
          id: `test-run:terraform:missing-${stageId}`,
          stageId,
        },
        project.root,
      );

      expectMissingTerraformResult(result, project.mainFile);
    },
  );

  it("runs Terraform lint and reuses cached validation for typecheck", async () => {
    const project = await createTerraformFixtureProject("aiq-tf-lint-typecheck-");

    const lint = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:lint",
        stageId: "lint",
      },
      project.root,
    );
    const typecheck = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:typecheck",
        stageId: "typecheck",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(lint, project.mainFile);
      expectMissingTerraformResult(typecheck, project.mainFile);
      return;
    }

    expect(lint.status).toBe("passed");
    expect(lint.diagnostics).toEqual([]);
    expect(lint.notes[0]).toContain("terraform validate passed");
    expect(lint.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cacheHit: false, status: "passed", tool: "terraform-init" }),
        expect.objectContaining({
          cacheHit: false,
          status: "passed",
          tool: "terraform-validate",
        }),
      ]),
    );

    expect(typecheck.status).toBe("passed");
    expect(typecheck.diagnostics).toEqual([]);
    expect(typecheck.notes.join(" ")).toContain("Reused cached Terraform validation");
    expect(typecheck.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cacheHit: true, status: "passed", tool: "terraform-init" }),
        expect.objectContaining({
          cacheHit: true,
          status: "passed",
          tool: "terraform-validate",
        }),
      ]),
    );
  }, 20_000);

  it("runs Terraform lint for terraform json inputs", async () => {
    const project = await createTerraformJsonFixtureProject("aiq-tf-json-lint-");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.terraformJsonFile],
        id: "test-run:terraform-json:lint",
        stageId: "lint",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.terraformJsonFile);
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "terraform-init" }),
        expect.objectContaining({ status: "passed", tool: "terraform-validate" }),
      ]),
    );
  }, 20_000);

  it("runs terraform format and reports formatting diagnostics", async () => {
    const project = await createTerraformFixtureProject("aiq-tf-format-");
    await writeFile(
      project.mainFile,
      [
        "terraform{",
        'required_version=">= 1.0.0"',
        "}",
        "locals{",
        "effective_region=var.region",
        "}",
        'output "effective_region"{',
        "value=local.effective_region",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:format",
        stageId: "format",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.mainFile);
      return;
    }

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.mainFile,
      message: "File requires formatting.",
      severity: "error",
      source: "terraform-fmt",
    });
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ exitCode: 3, status: "failed", tool: "terraform-fmt" }),
      ]),
    );
  }, 20_000);

  it("invalidates cached terraform validation when sibling terraform files change", async () => {
    const project = await createTerraformFixtureProject("aiq-tf-cache-invalidation-");

    const lint = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:lint-cache-seed",
        stageId: "lint",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(lint, project.mainFile);
      return;
    }

    expect(lint.status).toBe("passed");
    const originalVariablesStats = await stat(project.variablesFile);

    await writeFile(
      project.variablesFile,
      ['variable "region" {', "  type    = string", '  default = "us-east-1"', "}"].join("\n"),
      "utf8",
    );
    await utimes(project.variablesFile, originalVariablesStats.atime, originalVariablesStats.mtime);

    const typecheck = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:typecheck-cache-invalidation",
        stageId: "typecheck",
      },
      project.root,
    );

    expect(typecheck.status).toBe("passed");
    expect(typecheck.notes.join(" ")).not.toContain("Reused cached Terraform validation");
    expect(typecheck.diagnostics).toEqual([]);
    expect(typecheck.toolRuns.some((toolRun) => toolRun.cacheHit)).toBe(false);
    expect(typecheck.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cacheHit: false, status: "passed", tool: "terraform-init" }),
        expect.objectContaining({
          cacheHit: false,
          status: "passed",
          tool: "terraform-validate",
        }),
      ]),
    );
  }, 20_000);

  it("runs terraform typecheck and reports validation diagnostics with ranges", async () => {
    const project = await createTerraformFixtureProject("aiq-tf-typecheck-");
    await writeFile(
      project.mainFile,
      [
        "terraform {",
        '  required_version = ">= 1.0.0"',
        "}",
        "",
        'output "effective_region" {',
        "  value = local.missing_region",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.mainFile],
        id: "test-run:terraform:typecheck-fail",
        stageId: "typecheck",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.mainFile);
      return;
    }

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.mainFile,
      severity: "error",
      source: "terraform-validate",
    });
    expect(result.diagnostics[0]?.message).toContain("Reference to undeclared local value");
    expect(result.diagnostics[0]?.range).toMatchObject({
      startLine: 6,
    });
    expect(result.toolRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "passed", tool: "terraform-init" }),
        expect.objectContaining({ status: "failed", tool: "terraform-validate" }),
      ]),
    );
  }, 20_000);

  it("runs generic HCL lint on valid files", async () => {
    const project = await createHclFixtureProject("aiq-hcl-lint-");

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.configFile],
        id: "test-run:hcl:lint",
        stageId: "lint",
      },
      project.root,
    );

    if (!hasTerraform) {
      expectMissingTerraformResult(result, project.configFile);
      return;
    }

    expect(result.status).toBe("passed");
    expect(result.diagnostics).toEqual([]);
    expect(result.notes[0]).toContain("Generic HCL syntax check passed");
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 0,
      status: "passed",
      tool: "terraform-hcl-lint",
    });
  }, 20_000);

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
        'locals { token = "ghp_123456789012345678901234567890123456" }',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      hclProject.configFile,
      ['locals { token = "ghp_123456789012345678901234567890123456" }', ""].join("\n"),
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
