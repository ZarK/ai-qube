import path from "node:path";

import type { ProjectDescriptor, ProjectGraph, ProjectMetadata } from "../contracts.js";

type HashicorpProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: "terraform-directory";
  };
};

export type HashicorpProject = {
  files: string[];
  hclFiles: string[];
  projectRoot: string;
  terraformFiles: string[];
};

const terraformFileSuffixes = [".tf", ".tfvars", ".tf.json", ".tfvars.json"];

export const terraformExtensions = new Set([".tf", ".tfvars"]);
export const hclExtensions = new Set([".hcl"]);
export const hashicorpTaskExtensions = new Set([...terraformExtensions, ...hclExtensions]);

export async function discoverHashicorpProjects(file: string): Promise<ProjectDescriptor[]> {
  const project = createHashicorpProject(file);
  return project === undefined ? [] : [project];
}

export function selectHashicorpProjects(
  graph: ProjectGraph,
  files: readonly string[],
): HashicorpProject[] {
  return selectSingleKindProjects(graph, files, "terraform-directory").projects.map((project) => ({
    files: project.files,
    hclFiles: project.files.filter((file) => isHclFile(file)),
    projectRoot: project.root,
    terraformFiles: project.files.filter((file) => isTerraformFile(file)),
  }));
}

export async function resolveHashicorpProjects(
  graph: ProjectGraph | undefined,
  files: readonly string[],
): Promise<HashicorpProject[]> {
  if (graph !== undefined) {
    return selectHashicorpProjects(graph, files);
  }

  const projectFiles = new Map<string, string[]>();
  const projectTerraformFiles = new Map<string, string[]>();
  const projectHclFiles = new Map<string, string[]>();

  for (const file of files) {
    const resolvedFile = path.resolve(file);
    const projectRoot = path.dirname(resolvedFile);
    const existingFiles = projectFiles.get(projectRoot);

    if (existingFiles === undefined) {
      projectFiles.set(projectRoot, [resolvedFile]);
    } else {
      existingFiles.push(resolvedFile);
    }

    if (isTerraformFile(resolvedFile)) {
      const existingTerraformFiles = projectTerraformFiles.get(projectRoot);
      if (existingTerraformFiles === undefined) {
        projectTerraformFiles.set(projectRoot, [resolvedFile]);
      } else {
        existingTerraformFiles.push(resolvedFile);
      }
      continue;
    }

    if (isHclFile(resolvedFile)) {
      const existingHclFiles = projectHclFiles.get(projectRoot);
      if (existingHclFiles === undefined) {
        projectHclFiles.set(projectRoot, [resolvedFile]);
      } else {
        existingHclFiles.push(resolvedFile);
      }
    }
  }

  return [...projectFiles.entries()]
    .map(([projectRoot, selectedFiles]) => ({
      files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
      hclFiles: [...new Set(projectHclFiles.get(projectRoot) ?? [])].sort((left, right) =>
        left.localeCompare(right),
      ),
      projectRoot,
      terraformFiles: [...new Set(projectTerraformFiles.get(projectRoot) ?? [])].sort(
        (left, right) => left.localeCompare(right),
      ),
    }))
    .sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
}

export function filterHashicorpTaskFiles(files: readonly string[]): string[] {
  return files.filter((file) => isHashicorpTaskFile(file));
}

export function filterHclFiles(files: readonly string[]): string[] {
  return files.filter((file) => isHclFile(file));
}

export function filterTerraformFiles(files: readonly string[]): string[] {
  return files.filter((file) => isTerraformFile(file));
}

export function isHashicorpTaskFile(file: string): boolean {
  return isTerraformFile(file) || isHclFile(file);
}

export function isHclFile(file: string): boolean {
  return hclExtensions.has(path.extname(file).toLowerCase());
}

export function isTerraformFile(file: string): boolean {
  const lowerName = path.basename(file).toLowerCase();
  return terraformFileSuffixes.some((suffix) => lowerName.endsWith(suffix));
}

function createHashicorpProject(file: string): HashicorpProjectDescriptor | undefined {
  const resolvedFile = path.resolve(file);
  if (!isHashicorpTaskFile(resolvedFile)) {
    return undefined;
  }

  const projectRoot = path.dirname(resolvedFile);

  return {
    ecosystem: "terraform",
    id: `terraform-directory:${projectRoot}`,
    language: isHclFile(resolvedFile) ? "hcl" : "terraform",
    manifestFiles: [],
    metadata: {
      kind: "terraform-directory",
    },
    name: readProjectName(projectRoot),
    root: projectRoot,
    sourceFiles: [resolvedFile],
  };
}

function getProjectsForKind(
  graph: ProjectGraph,
  file: string,
  kind: "terraform-directory",
): HashicorpProjectDescriptor[] {
  const ids = graph.fileToProjectIds[path.resolve(file)] ?? [];
  const projectsById = new Map(graph.projects.map((project) => [project.id, project]));

  return ids
    .map((id) => projectsById.get(id))
    .filter(
      (project): project is HashicorpProjectDescriptor =>
        project !== undefined && project.metadata.kind === kind,
    );
}

function selectSingleKindProjects(
  graph: ProjectGraph,
  files: readonly string[],
  kind: "terraform-directory",
): {
  projects: Array<HashicorpProjectDescriptor & { files: string[] }>;
  unsupportedFiles: string[];
} {
  const groupedFiles = new Map<string, string[]>();
  const unsupportedFiles = new Set<string>();
  const selectedProjectsById = new Map<string, HashicorpProjectDescriptor>();

  for (const file of files) {
    const project = getProjectsForKind(graph, file, kind)[0];
    if (project === undefined) {
      unsupportedFiles.add(file);
      continue;
    }

    const existingFiles = groupedFiles.get(project.id);
    if (existingFiles === undefined) {
      groupedFiles.set(project.id, [file]);
      selectedProjectsById.set(project.id, project);
      continue;
    }

    existingFiles.push(file);
  }

  return {
    projects: [...groupedFiles.entries()]
      .map(([projectId, selectedFiles]) => {
        const project = selectedProjectsById.get(projectId);
        if (project === undefined) {
          return undefined;
        }

        return {
          ...project,
          files: [...new Set(selectedFiles)].sort((left, right) => left.localeCompare(right)),
        };
      })
      .filter(
        (project): project is HashicorpProjectDescriptor & { files: string[] } =>
          project !== undefined,
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    unsupportedFiles: [...unsupportedFiles].sort((left, right) => left.localeCompare(right)),
  };
}

function readProjectName(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}
