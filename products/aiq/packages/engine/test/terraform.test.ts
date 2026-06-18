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
});
