import path from "node:path";

import {
  type JavaScriptTestRunner,
  detectJavaScriptTestRunner,
  readPackageJson,
} from "../utils/node-utils.js";
import { fileExists } from "./javascript-e2e-runner.js";
import type { JavaScriptPackageProject } from "./javascript-projects.js";

export async function findConfiguredJavaScriptTestProject(
  project: JavaScriptPackageProject,
): Promise<(JavaScriptPackageProject & { runner: JavaScriptTestRunner }) | undefined> {
  let projectRoot = project.projectRoot;
  let packageJsonPath = project.packageJsonPath;

  while (true) {
    const runner = await detectJavaScriptTestRunner(projectRoot);
    const candidate = { files: project.files, packageJsonPath, projectRoot, runner };
    if (runner !== undefined && (await candidateCoversJavaScriptProject(candidate, project))) {
      return { ...candidate, runner };
    }

    const parentPackageJsonPath = await findParentPackageJson(projectRoot);
    if (parentPackageJsonPath === undefined) {
      return undefined;
    }

    projectRoot = path.dirname(parentPackageJsonPath);
    packageJsonPath = parentPackageJsonPath;
  }
}

async function candidateCoversJavaScriptProject(
  candidate: JavaScriptPackageProject,
  project: JavaScriptPackageProject,
): Promise<boolean> {
  return (
    candidate.packageJsonPath === project.packageJsonPath ||
    (await packageJsonCoversWorkspaceProject(candidate.packageJsonPath, project.projectRoot))
  );
}

async function findParentPackageJson(projectRoot: string): Promise<string | undefined> {
  let currentRoot = projectRoot;
  let nextRoot = path.dirname(currentRoot);
  while (nextRoot !== currentRoot) {
    const parentPackageJsonPath = path.join(nextRoot, "package.json");
    if (await fileExists(parentPackageJsonPath)) {
      return parentPackageJsonPath;
    }

    currentRoot = nextRoot;
    nextRoot = path.dirname(currentRoot);
  }

  return undefined;
}

export async function packageJsonCoversWorkspaceProject(
  packageJsonPath: string,
  projectRoot: string,
): Promise<boolean> {
  const packageJson = await readPackageJson(packageJsonPath);
  const workspacePatterns = readWorkspacePatterns(packageJson);
  if (workspacePatterns.length === 0) {
    return false;
  }

  const root = path.dirname(packageJsonPath);
  const relativeProjectRoot = path.relative(root, projectRoot).replace(/\\/gu, "/");
  if (relativeProjectRoot.length === 0 || relativeProjectRoot.startsWith("../")) {
    return false;
  }

  return workspacePatterns.some((pattern) =>
    workspacePatternMatchesProject(pattern, relativeProjectRoot),
  );
}

export function readWorkspacePatterns(packageJson: Record<string, unknown>): string[] {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof workspaces === "object" && workspaces !== null) {
    const packages = (workspaces as Record<string, unknown>).packages;
    return Array.isArray(packages)
      ? packages.filter((entry): entry is string => typeof entry === "string")
      : [];
  }

  return [];
}

export function workspacePatternMatchesProject(
  pattern: string,
  relativeProjectRoot: string,
): boolean {
  const normalizedPattern = pattern.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -"/**".length);
    return relativeProjectRoot === prefix || relativeProjectRoot.startsWith(`${prefix}/`);
  }

  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -"/*".length);
    if (!relativeProjectRoot.startsWith(`${prefix}/`)) {
      return false;
    }

    return !relativeProjectRoot.slice(prefix.length + 1).includes("/");
  }

  return relativeProjectRoot === normalizedPattern;
}
