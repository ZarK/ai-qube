import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildProjectGraph } from "../../src/graph.js";
import { normalizeFileManifest } from "../../src/index.js";
import {
  discoverTerraformProjects,
  selectTerraformProjects,
} from "../../src/languages/terraform.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createHashicorpWorkspace(): Promise<{
  hclFile: string;
  root: string;
  terraformFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-terraform-language-"));
  tempDirs.push(root);

  const terraformFile = path.join(root, "main.tf");
  const hclFile = path.join(root, "config.hcl");
  await mkdir(root, { recursive: true });
  await writeFile(terraformFile, 'terraform { required_version = ">= 1.0.0" }\n', "utf8");
  await writeFile(hclFile, 'container "web" { image = "nginx:latest" }\n', "utf8");

  return { hclFile, root, terraformFile };
}

async function createTerraformJsonWorkspace(): Promise<{
  root: string;
  terraformJsonFile: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-engine-terraform-json-language-"));
  tempDirs.push(root);

  const terraformJsonFile = path.join(root, "main.tf.json");
  await mkdir(root, { recursive: true });
  await writeFile(
    terraformJsonFile,
    `${JSON.stringify({ terraform: { required_version: ">= 1.0.0" } }, null, 2)}\n`,
    "utf8",
  );

  return { root, terraformJsonFile };
}

describe("terraform language module", () => {
  it("discovers Terraform and HCL files as one shared ecosystem", async () => {
    const workspace = await createHashicorpWorkspace();

    await expect(discoverTerraformProjects(workspace.terraformFile)).resolves.toEqual([
      expect.objectContaining({
        ecosystem: "terraform",
        id: `terraform-directory:${workspace.root}`,
        language: "terraform",
        root: workspace.root,
        sourceFiles: [workspace.terraformFile],
      }),
    ]);
    await expect(discoverTerraformProjects(workspace.hclFile)).resolves.toEqual([
      expect.objectContaining({
        ecosystem: "terraform",
        id: `terraform-directory:${workspace.root}`,
        language: "hcl",
        root: workspace.root,
        sourceFiles: [workspace.hclFile],
      }),
    ]);
  });

  it("selects mixed Terraform and HCL files under one project root", async () => {
    const workspace = await createHashicorpWorkspace();
    const manifest = await normalizeFileManifest(
      {
        files: [workspace.terraformFile, workspace.hclFile],
        source: "direct",
      },
      workspace.root,
    );
    const graph = await buildProjectGraph(manifest);

    expect(selectTerraformProjects(graph, [workspace.terraformFile, workspace.hclFile])).toEqual([
      {
        files: [workspace.hclFile, workspace.terraformFile],
        hclFiles: [workspace.hclFile],
        projectRoot: workspace.root,
        terraformFiles: [workspace.terraformFile],
      },
    ]);
  });

  it("discovers terraform json files through the shared classifier", async () => {
    const workspace = await createTerraformJsonWorkspace();

    await expect(discoverTerraformProjects(workspace.terraformJsonFile)).resolves.toEqual([
      expect.objectContaining({
        ecosystem: "terraform",
        id: `terraform-directory:${workspace.root}`,
        language: "terraform",
        root: workspace.root,
        sourceFiles: [workspace.terraformJsonFile],
      }),
    ]);
  });
});
