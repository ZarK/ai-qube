import path from "node:path";

import type {
  LayoutClassifiedPath,
  LayoutConsumption,
  LayoutConsumptionSource,
  LayoutGateScope,
  LayoutPathClass,
  RepoAffectedProject,
  RepoAffectedResult,
  RepoCiHint,
  RepoLayoutInspection,
  RepoLayoutKind,
  RepoPackageManager,
  RepoPathSignal,
  RepoProject,
  RepoRootMarker,
} from "@tjalve/aiq/model";
import {
  repoCiHintKinds,
  repoLayoutKinds,
  repoPackageManagerKinds,
  repoProjectKinds,
  repoRootMarkerKinds,
} from "@tjalve/aiq/model";

const workspaceLayoutKinds = new Set<RepoLayoutKind>([
  "javascript-typescript-workspace",
  "python-workspace-monorepo",
  "rust-workspace",
  "go-workspace",
  "java-kotlin-multi-project",
  "dotnet-solution",
  "bazel-pants-buck-monorepo",
  "c-cpp-cmake-superbuild",
  "mobile-app-repo",
  "infrastructure-repo",
  "docs-content-repo",
  "polyrepo-multi-checkout",
]);

const rootAppLayoutKinds = new Set<RepoLayoutKind>([
  "single-app-service",
  "generated-vendor-heavy",
]);

export class LayoutConsumptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LayoutConsumptionError";
  }
}

export function parseLayoutInspectJson(text: string): RepoLayoutInspection {
  return parseLayoutInspection(parseJsonObject(text, "Layout inspect JSON"), "inspect");
}

export function parseLayoutAffectedJson(text: string): RepoAffectedResult {
  const value = parseJsonObject(text, "Layout affected JSON");
  const layout = parseLayoutInspection(
    requiredRecord(value.layout, "affected.layout"),
    "affected.layout",
  );
  const changedPaths = parseSafePathList(value.changedPaths, "affected.changedPaths");
  const affectedProjects = parseAffectedProjects(value.affectedProjects);
  const suggestedGates = parseStringList(value.suggestedGates, "affected.suggestedGates");
  const warnings = parseStringList(value.warnings, "affected.warnings");
  return { layout, changedPaths, affectedProjects, suggestedGates, warnings };
}

export function createLayoutConsumption(input: {
  inspect: RepoLayoutInspection;
  affected?: RepoAffectedResult | null;
  source: LayoutConsumptionSource;
  candidatePaths?: readonly string[];
}): LayoutConsumption {
  const affected = input.affected ?? null;
  if (affected !== null && affected.layout.kind !== input.inspect.kind) {
    throw new LayoutConsumptionError(
      "Layout inspect JSON and affected JSON do not describe the same layout kind. Provide a matching inspect and affected pair.",
    );
  }

  const classifiedPaths = classifyLayoutPaths(input.inspect, [
    ...(input.candidatePaths ?? []),
    ...(affected?.changedPaths ?? []),
  ]);
  const scope = selectLayoutGateScope({
    inspect: input.inspect,
    affected,
    source: input.source,
    classifiedPaths,
  });
  return { inspect: input.inspect, affected, scope };
}

export function classifyLayoutPath(
  layout: RepoLayoutInspection,
  filePath: string,
): LayoutPathClass {
  const relativePath = portablePath(filePath);
  if (pathMatchesSignal(layout.generatedPaths, relativePath)) {
    return "generated";
  }
  if (pathMatchesSignal(layout.vendorPaths, relativePath)) {
    return "vendor";
  }
  if (
    layout.projects.some((project) => pathBelongsToProject(layout.kind, project.path, relativePath))
  ) {
    return "project";
  }
  return "unmapped";
}

export function applyLayoutToCandidateFiles(input: {
  files: readonly string[];
  cwd: string;
  layout: LayoutConsumption;
  requireProvenScope: boolean;
}): {
  files: string[];
  layout: LayoutConsumption;
  classifiedPaths: LayoutClassifiedPath[];
  warnings: string[];
} {
  if (input.requireProvenScope && input.layout.scope.avoidRepoRoot) {
    throw new LayoutConsumptionError(formatAvoidedRepoRootMessage(input.layout));
  }

  const classifiedPaths: LayoutClassifiedPath[] = [];
  const warnings = [...input.layout.scope.warnings];
  const kept: string[] = [];

  for (const file of input.files) {
    const relativePath = toRepoRelativePath(file, input.cwd);
    if (relativePath === null) {
      throw new LayoutConsumptionError(
        `Input path ${file} is outside the project root. Use a path inside the current directory.`,
      );
    }

    const classification = classifyLayoutPath(input.layout.inspect, relativePath);
    classifiedPaths.push({ path: relativePath, classification });
    if (classification === "generated" || classification === "vendor") {
      warnings.push(`Omitted ${classification} path ${relativePath} from AIQ scope.`);
      continue;
    }

    if (
      input.layout.scope.kind === "affected-projects" &&
      !input.layout.scope.affectedProjectPaths.some((projectPath) =>
        pathBelongsToProject(input.layout.inspect.kind, projectPath, relativePath),
      )
    ) {
      warnings.push(
        `Omitted ${relativePath} because it is outside the layout-proven affected projects.`,
      );
      continue;
    }

    kept.push(file);
  }

  if (kept.length === 0) {
    throw new LayoutConsumptionError(
      "Layout-proven affected scope contains no usable files. Use aiq run with explicit project files, or provide matching layout affected JSON.",
    );
  }

  return {
    files: kept,
    layout: {
      inspect: input.layout.inspect,
      affected: input.layout.affected,
      scope: {
        ...input.layout.scope,
        classifiedPaths,
        warnings,
      },
    },
    classifiedPaths,
    warnings,
  };
}

export function toRepoRelativePath(file: string, cwd: string): string | null {
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(cwd, file);
  const relativePath = path.relative(resolvedCwd, resolvedFile);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return null;
  }
  return portablePath(relativePath === "" ? "." : relativePath);
}

export function workspaceLayoutKind(kind: RepoLayoutKind): boolean {
  return workspaceLayoutKinds.has(kind);
}

function selectLayoutGateScope(input: {
  inspect: RepoLayoutInspection;
  affected: RepoAffectedResult | null;
  source: LayoutConsumptionSource;
  classifiedPaths: readonly LayoutClassifiedPath[];
}): LayoutGateScope {
  const warnings = uniqueStrings([...input.inspect.warnings, ...(input.affected?.warnings ?? [])]);
  if (layoutReportsUncertainty(input.inspect, input.affected)) {
    return {
      kind: "avoided-repo-root",
      layoutKind: input.inspect.kind,
      source: input.source,
      affectedProjectIds: [],
      affectedProjectPaths: [],
      suggestedGates: input.affected?.suggestedGates ?? [],
      classifiedPaths: input.classifiedPaths,
      warnings: [
        ...warnings,
        "Repository layout is uncertain, so AIQ will not run a repository-root gate.",
      ],
      avoidRepoRoot: true,
    };
  }

  if (rootAppLayoutKinds.has(input.inspect.kind)) {
    const rootProjects = input.affected?.affectedProjects ?? input.inspect.projects;
    return {
      kind: "root-app",
      layoutKind: input.inspect.kind,
      source: input.source,
      affectedProjectIds: rootProjects.map((entry) => projectId(entry)),
      affectedProjectPaths: rootProjects.map((entry) => projectPath(entry)),
      suggestedGates:
        input.affected?.suggestedGates ??
        uniqueStrings(rootProjects.flatMap((entry) => projectGates(entry))),
      classifiedPaths: input.classifiedPaths,
      warnings,
      avoidRepoRoot: false,
    };
  }

  const affectedProjects = input.affected?.affectedProjects ?? [];
  const memberProjects = affectedProjects.filter((entry) => entry.project.path !== ".");
  const provenProjects = memberProjects.length > 0 ? memberProjects : affectedProjects;
  if (input.affected === null || provenProjects.length === 0) {
    return {
      kind: "avoided-repo-root",
      layoutKind: input.inspect.kind,
      source: input.source,
      affectedProjectIds: [],
      affectedProjectPaths: [],
      suggestedGates: input.affected?.suggestedGates ?? [],
      classifiedPaths: input.classifiedPaths,
      warnings: [
        ...warnings,
        "Changed paths do not map to layout-proven workspace members, so AIQ will not run a repository-root gate.",
      ],
      avoidRepoRoot: true,
    };
  }

  return {
    kind: "affected-projects",
    layoutKind: input.inspect.kind,
    source: input.source,
    affectedProjectIds: provenProjects.map((entry) => entry.project.id),
    affectedProjectPaths: provenProjects.map((entry) => entry.project.path),
    suggestedGates: input.affected.suggestedGates,
    classifiedPaths: input.classifiedPaths,
    warnings,
    avoidRepoRoot: false,
  };
}

function layoutReportsUncertainty(
  inspect: RepoLayoutInspection,
  affected: RepoAffectedResult | null,
): boolean {
  if (inspect.kind === "unknown") {
    return true;
  }
  return [...inspect.warnings, ...(affected?.warnings ?? [])].some((warning) =>
    /ambiguous|could not be classified|Affected-scope mapping is conservative/i.test(warning),
  );
}

function classifyLayoutPaths(
  layout: RepoLayoutInspection,
  paths: readonly string[],
): LayoutClassifiedPath[] {
  const unique = uniqueStrings(paths.map(portablePath).filter((value) => value.length > 0));
  return unique.map((filePath) => ({
    path: filePath,
    classification: classifyLayoutPath(layout, filePath),
  }));
}

function parseLayoutInspection(
  value: Record<string, unknown>,
  label: string,
): RepoLayoutInspection {
  const kind = parseEnum(value.kind, repoLayoutKinds, `${label}.kind`);
  return {
    kind,
    root: parseNullableString(value.root, `${label}.root`),
    remotes: parseRemotes(value.remotes, `${label}.remotes`),
    rootMarkers: parseRootMarkers(value.rootMarkers, `${label}.rootMarkers`),
    projects: parseProjects(value.projects, `${label}.projects`),
    packageManagers: parsePackageManagers(value.packageManagers, `${label}.packageManagers`),
    lockfiles: parseSafePathList(value.lockfiles, `${label}.lockfiles`),
    ciHints: parseCiHints(value.ciHints, `${label}.ciHints`),
    generatedPaths: parsePathSignals(value.generatedPaths, `${label}.generatedPaths`),
    vendorPaths: parsePathSignals(value.vendorPaths, `${label}.vendorPaths`),
    warnings: parseStringList(value.warnings, `${label}.warnings`),
  };
}

function parseAffectedProjects(value: unknown): RepoAffectedProject[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError("Layout affected JSON affectedProjects must be an array.");
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `affected.affectedProjects[${String(index)}]`);
    return {
      project: parseProject(
        requiredRecord(record.project, `affected.affectedProjects[${String(index)}].project`),
        `affected.affectedProjects[${String(index)}].project`,
      ),
      changedPaths: parseSafePathList(
        record.changedPaths,
        `affected.affectedProjects[${String(index)}].changedPaths`,
      ),
      gates: parseStringList(record.gates, `affected.affectedProjects[${String(index)}].gates`),
    };
  });
}

function parseProjects(value: unknown, label: string): RepoProject[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) =>
    parseProject(requiredRecord(entry, `${label}[${String(index)}]`), `${label}[${String(index)}]`),
  );
}

function parseProject(value: Record<string, unknown>, label: string): RepoProject {
  return {
    id: requiredString(value.id, `${label}.id`),
    path: assertSafeRepoRelativePath(requiredString(value.path, `${label}.path`), `${label}.path`),
    kind: parseEnum(value.kind, repoProjectKinds, `${label}.kind`),
    packageName: parseNullableString(value.packageName, `${label}.packageName`),
    packageManager: parseNullableString(value.packageManager, `${label}.packageManager`),
    gates: parseStringList(value.gates, `${label}.gates`),
  };
}

function parseRootMarkers(value: unknown, label: string): RepoRootMarker[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${label}[${String(index)}]`);
    const marker: RepoRootMarker = {
      path: assertSafeRepoRelativePath(
        requiredString(record.path, `${label}[${String(index)}].path`),
        `${label}[${String(index)}].path`,
      ),
      kind: parseEnum(record.kind, repoRootMarkerKinds, `${label}[${String(index)}].kind`),
    };
    if (record.section !== undefined) {
      return {
        ...marker,
        section: requiredString(record.section, `${label}[${String(index)}].section`),
      };
    }
    return marker;
  });
}

function parsePackageManagers(value: unknown, label: string): RepoPackageManager[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${label}[${String(index)}]`);
    return {
      kind: parseEnum(record.kind, repoPackageManagerKinds, `${label}[${String(index)}].kind`),
      manifestPath: assertSafeRepoRelativePath(
        requiredString(record.manifestPath, `${label}[${String(index)}].manifestPath`),
        `${label}[${String(index)}].manifestPath`,
      ),
      lockfilePath:
        record.lockfilePath === null
          ? null
          : assertSafeRepoRelativePath(
              requiredString(record.lockfilePath, `${label}[${String(index)}].lockfilePath`),
              `${label}[${String(index)}].lockfilePath`,
            ),
    };
  });
}

function parseCiHints(value: unknown, label: string): RepoCiHint[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${label}[${String(index)}]`);
    return {
      kind: parseEnum(record.kind, repoCiHintKinds, `${label}[${String(index)}].kind`),
      path: assertSafeRepoRelativePath(
        requiredString(record.path, `${label}[${String(index)}].path`),
        `${label}[${String(index)}].path`,
      ),
    };
  });
}

function parsePathSignals(value: unknown, label: string): RepoPathSignal[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${label}[${String(index)}]`);
    return {
      path: assertSafeRepoRelativePath(
        requiredString(record.path, `${label}[${String(index)}].path`),
        `${label}[${String(index)}].path`,
      ),
      reason: requiredString(record.reason, `${label}[${String(index)}].reason`),
    };
  });
}

function parseRemotes(value: unknown, label: string): Array<{ name: string; url: string }> {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${label} must be an array.`);
  }
  return value.map((entry, index) => {
    const record = requiredRecord(entry, `${label}[${String(index)}]`);
    return {
      name: requiredString(record.name, `${label}[${String(index)}].name`),
      url: requiredString(record.url, `${label}[${String(index)}].url`),
    };
  });
}

export function assertSafeRepoRelativePath(value: string, field: string): string {
  const portable = portablePath(value);
  if (portable.length === 0) {
    throw new LayoutConsumptionError(`Layout ${field} is missing.`);
  }
  if (portable.includes("\0")) {
    throw new LayoutConsumptionError(`Layout ${field} contains an invalid character.`);
  }
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) {
    throw new LayoutConsumptionError(`Layout ${field} must be a repository-relative path.`);
  }
  const segments = portable.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "..")) {
    throw new LayoutConsumptionError(`Layout ${field} must not contain parent-directory segments.`);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

function parseSafePathList(value: unknown, field: string): string[] {
  return parseStringList(value, field).map((entry) => assertSafeRepoRelativePath(entry, field));
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new LayoutConsumptionError(`Layout ${field} must be an array.`);
  }
  return value.map((entry, index) => requiredString(entry, `${field}[${String(index)}]`));
}

function parseNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, field);
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new LayoutConsumptionError(`Layout ${field} is not a supported value.`);
  }
  return value as T;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new LayoutConsumptionError(`${label} is malformed and cannot be parsed.`, {
      cause: error,
    });
  }
  return requiredRecord(parsed, label);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new LayoutConsumptionError(`${field} must be a JSON object.`);
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LayoutConsumptionError(`${field} must be a non-empty string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portablePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function pathMatchesSignal(signals: readonly RepoPathSignal[], changedPath: string): boolean {
  return signals.some((signal) => {
    const signalPath = portablePath(signal.path).replace(/\/+$/, "");
    return changedPath === signalPath || changedPath.startsWith(`${signalPath}/`);
  });
}

function pathBelongsToProject(
  layoutKind: RepoLayoutKind,
  projectPath: string,
  changedPath: string,
): boolean {
  if (projectPath === ".") {
    if (layoutKind === "single-app-service" || layoutKind === "generated-vendor-heavy") {
      return true;
    }
    return !changedPath.includes("/") || changedPath.startsWith(".github/");
  }
  const prefix = `${projectPath.replace(/\/+$/, "")}/`;
  return changedPath === projectPath || changedPath.startsWith(prefix);
}

function projectId(entry: RepoProject | RepoAffectedProject): string {
  return "project" in entry ? entry.project.id : entry.id;
}

function projectPath(entry: RepoProject | RepoAffectedProject): string {
  return "project" in entry ? entry.project.path : entry.path;
}

function projectGates(entry: RepoProject | RepoAffectedProject): readonly string[] {
  return "project" in entry ? entry.gates : entry.gates;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatAvoidedRepoRootMessage(layout: LayoutConsumption): string {
  const warning = layout.scope.warnings.at(-1);
  return warning === undefined
    ? "Repository layout is uncertain, so AIQ will not run a repository-root gate. Use aiq run with explicit project paths."
    : `${warning} Use aiq run with explicit project paths.`;
}
