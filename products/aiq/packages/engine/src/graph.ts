import type {
  FileManifest,
  ProjectDescriptor,
  ProjectGraph,
  ProjectMetadata,
} from "./contracts.js";
import { engineVersion } from "./contracts.js";
import {
  type DotNetProject,
  type DotNetTargetPreference as LanguageDotNetTargetPreference,
  discoverDotNetProjects as discoverDotNetLanguageProjects,
  selectDotNetProjects as selectDotNetLanguageProjects,
} from "./languages/dotnet.js";
import {
  type GoProject,
  discoverGoProjects as discoverGoLanguageProjects,
  selectGoProjects as selectGoLanguageProjects,
} from "./languages/go.js";
import {
  type JavaScriptPackageProject,
  discoverJavaScriptProjects as discoverJavaScriptLanguageProjects,
  selectJavaScriptPackageProjects as selectJavaScriptLanguagePackageProjects,
  selectJavaScriptProjects as selectJavaScriptLanguageProjects,
} from "./languages/javascript.js";
import {
  type JvmProject,
  discoverJvmProjects as discoverJvmLanguageProjects,
  selectJvmProjects as selectJvmLanguageProjects,
} from "./languages/jvm.js";
import {
  type PythonProject,
  discoverPythonProjects as discoverPythonLanguageProjects,
  selectPythonProjects as selectPythonLanguageProjects,
} from "./languages/python.js";
import {
  type RustProject,
  discoverRustProjects as discoverRustLanguageProjects,
  selectRustProjects as selectRustLanguageProjects,
} from "./languages/rust.js";
import {
  type ScriptProject,
  discoverScriptProjects as discoverScriptLanguageProjects,
  selectScriptProjects as selectScriptLanguageProjects,
} from "./languages/script.js";
import {
  type TerraformProject,
  discoverTerraformProjects as discoverTerraformLanguageProjects,
  selectTerraformProjects as selectTerraformLanguageProjects,
} from "./languages/terraform.js";
import {
  type TypeScriptProject,
  discoverTypeScriptProjects as discoverTypeScriptLanguageProjects,
  selectTypeScriptProjects as selectTypeScriptLanguageProjects,
} from "./languages/typescript.js";
import { type Registry, createRegistry } from "./registries.js";
type GraphProjectKind =
  | "dotnet-project-target"
  | "dotnet-solution-target"
  | "go"
  | "javascript-package"
  | "jvm"
  | "python"
  | "rust"
  | "script"
  | "terraform-directory"
  | "typescript-typecheck";

type GraphProjectDescriptor = ProjectDescriptor & {
  metadata: ProjectMetadata & {
    kind: GraphProjectKind;
  };
};

export type GraphJavaScriptTestRunner = "jest" | "vitest";
export type GraphDotNetTargetPreference = LanguageDotNetTargetPreference;

export type GraphJavaScriptPackageProject = JavaScriptPackageProject;

export type GraphDotNetProject = DotNetProject;

export type GraphGoProject = GoProject;

export type GraphRustProject = RustProject;

export type GraphJvmProject = JvmProject;

export type GraphScriptProject = ScriptProject;

export type GraphPythonProject = PythonProject;

export type GraphTerraformProject = {} & TerraformProject;

export type GraphTypeScriptProject = TypeScriptProject;

export type GraphLanguageModule = {
  id: string;
  discoverProjects: (file: string) => Promise<ProjectDescriptor[]>;
};

export function createGraphLanguageModuleRegistry(
  modules: readonly GraphLanguageModule[],
): Registry<GraphLanguageModule> {
  return createRegistry(modules);
}

const typeScriptGraphLanguageModule = {
  id: "typescript",
  async discoverProjects(file: string): Promise<GraphProjectDescriptor[]> {
    return (await discoverTypeScriptLanguageProjects(file)) as GraphProjectDescriptor[];
  },
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): { projects: GraphTypeScriptProject[]; unsupportedFiles: string[] } {
    return selectTypeScriptLanguageProjects(graph, files);
  },
};

const javaScriptGraphLanguageModule = {
  id: "javascript",
  async discoverProjects(file: string): Promise<GraphProjectDescriptor[]> {
    return (await discoverJavaScriptLanguageProjects(file)) as GraphProjectDescriptor[];
  },
  selectPackageProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): { projects: GraphJavaScriptPackageProject[]; unsupportedFiles: string[] } {
    return selectJavaScriptLanguagePackageProjects(graph, files);
  },
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): Promise<{
    projects: Array<{ files: string[]; projectRoot: string; runner: GraphJavaScriptTestRunner }>;
    unsupportedProjectRoots: string[];
  }> {
    return selectJavaScriptLanguageProjects(graph, files);
  },
};

const pythonGraphLanguageModule = {
  discoverProjects: discoverPythonLanguageProjects,
  id: "python",
};

const scriptGraphLanguageModule = {
  discoverProjects: discoverScriptLanguageProjects,
  id: "script",
  selectProjects(graph: ProjectGraph, files: readonly string[]): GraphScriptProject[] {
    return selectScriptLanguageProjects(graph, files);
  },
};

const goGraphLanguageModule = {
  discoverProjects: discoverGoLanguageProjects,
  id: "go",
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): { projects: GraphGoProject[]; unsupportedFiles: string[] } {
    return selectGoLanguageProjects(graph, files);
  },
};

const rustGraphLanguageModule = {
  discoverProjects: discoverRustLanguageProjects,
  id: "rust",
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): { projects: GraphRustProject[]; unsupportedFiles: string[] } {
    return selectRustLanguageProjects(graph, files);
  },
};

const jvmGraphLanguageModule = {
  discoverProjects: discoverJvmLanguageProjects,
  id: "jvm",
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
  ): { projects: GraphJvmProject[]; unsupportedFiles: string[] } {
    return selectJvmLanguageProjects(graph, files);
  },
};

const dotNetGraphLanguageModule = {
  discoverProjects: discoverDotNetLanguageProjects,
  id: "dotnet",
  selectProjects(
    graph: ProjectGraph,
    files: readonly string[],
    targetPreference: GraphDotNetTargetPreference,
  ): { projects: GraphDotNetProject[]; unsupportedFiles: string[] } {
    return selectDotNetLanguageProjects(graph, files, targetPreference);
  },
};

const terraformGraphLanguageModule = {
  discoverProjects: discoverTerraformLanguageProjects,
  id: "terraform",
  selectProjects(graph: ProjectGraph, files: readonly string[]): GraphTerraformProject[] {
    return selectTerraformLanguageProjects(graph, files);
  },
};

export const defaultGraphLanguageModules = createGraphLanguageModuleRegistry([
  typeScriptGraphLanguageModule,
  javaScriptGraphLanguageModule,
  pythonGraphLanguageModule,
  scriptGraphLanguageModule,
  goGraphLanguageModule,
  rustGraphLanguageModule,
  jvmGraphLanguageModule,
  dotNetGraphLanguageModule,
  terraformGraphLanguageModule,
]);

export async function buildProjectGraph(manifest: FileManifest): Promise<ProjectGraph> {
  return buildProjectGraphWithModules(manifest, defaultGraphLanguageModules);
}

export async function buildProjectGraphWithModules(
  manifest: FileManifest,
  languageModules: Registry<GraphLanguageModule>,
): Promise<ProjectGraph> {
  const projectsById = new Map<string, ProjectDescriptor>();
  const fileToProjectIds = new Map<string, Set<string>>();

  for (const file of [...manifest.files].sort((left, right) => left.localeCompare(right))) {
    const descriptors = await collectProjectsForFile(file, languageModules);
    if (descriptors.length === 0) {
      continue;
    }

    const fileProjectIds = fileToProjectIds.get(file) ?? new Set<string>();
    fileToProjectIds.set(file, fileProjectIds);

    for (const descriptor of descriptors) {
      const existing = projectsById.get(descriptor.id);
      if (existing === undefined) {
        projectsById.set(descriptor.id, {
          ...descriptor,
          manifestFiles: [...new Set(descriptor.manifestFiles)].sort((left, right) =>
            left.localeCompare(right),
          ),
          sourceFiles: [...new Set(descriptor.sourceFiles)].sort((left, right) =>
            left.localeCompare(right),
          ),
        });
      } else {
        existing.manifestFiles = [
          ...new Set([...existing.manifestFiles, ...descriptor.manifestFiles]),
        ].sort((left, right) => left.localeCompare(right));
        existing.sourceFiles = [
          ...new Set([...existing.sourceFiles, ...descriptor.sourceFiles]),
        ].sort((left, right) => left.localeCompare(right));
      }

      fileProjectIds.add(descriptor.id);
    }
  }

  return {
    fileToProjectIds: Object.fromEntries(
      [...fileToProjectIds.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([file, projectIds]) => [
          file,
          [...projectIds].sort((left, right) => left.localeCompare(right)),
        ]),
    ),
    projects: [...projectsById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    root: manifest.root,
    version: engineVersion,
  };
}

export function selectDotNetProjects(
  graph: ProjectGraph,
  files: readonly string[],
  targetPreference: GraphDotNetTargetPreference,
): {
  projects: GraphDotNetProject[];
  unsupportedFiles: string[];
} {
  return dotNetGraphLanguageModule.selectProjects(graph, files, targetPreference);
}

export function selectGoProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GraphGoProject[]; unsupportedFiles: string[] } {
  return goGraphLanguageModule.selectProjects(graph, files);
}

export function selectRustProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GraphRustProject[]; unsupportedFiles: string[] } {
  return rustGraphLanguageModule.selectProjects(graph, files);
}

export function selectJvmProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GraphJvmProject[]; unsupportedFiles: string[] } {
  return jvmGraphLanguageModule.selectProjects(graph, files);
}

export function selectScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): GraphScriptProject[] {
  return scriptGraphLanguageModule.selectProjects(graph, files);
}

export function selectPythonProjects(
  graph: ProjectGraph,
  files: readonly string[],
): GraphPythonProject[] {
  return selectPythonLanguageProjects(graph, files);
}

export function selectJavaScriptPackageProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GraphJavaScriptPackageProject[]; unsupportedFiles: string[] } {
  return javaScriptGraphLanguageModule.selectPackageProjects(graph, files);
}

export function selectJavaScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): Promise<{
  projects: Array<{ files: string[]; projectRoot: string; runner: GraphJavaScriptTestRunner }>;
  unsupportedProjectRoots: string[];
}> {
  return javaScriptGraphLanguageModule.selectProjects(graph, files);
}

export function selectTypeScriptProjects(
  graph: ProjectGraph,
  files: readonly string[],
): { projects: GraphTypeScriptProject[]; unsupportedFiles: string[] } {
  return typeScriptGraphLanguageModule.selectProjects(graph, files);
}

export function selectTerraformProjects(
  graph: ProjectGraph,
  files: readonly string[],
): GraphTerraformProject[] {
  return selectTerraformLanguageProjects(graph, files);
}

async function collectProjectsForFile(
  file: string,
  languageModules: Registry<GraphLanguageModule>,
): Promise<ProjectDescriptor[]> {
  return (await Promise.all(languageModules.entries.map((module) => module.discoverProjects(file))))
    .flat()
    .sort((left, right) => left.id.localeCompare(right.id));
}
