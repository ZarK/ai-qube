export const repoLayoutKinds = [
  "single-app-service",
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
  "generated-vendor-heavy",
  "unknown",
] as const;

export type RepoLayoutKind = (typeof repoLayoutKinds)[number];

export const repoProjectKinds = [
  "workspace",
  "package",
  "app",
  "service",
  "docs",
  "unknown",
] as const;

export type RepoProjectKind = (typeof repoProjectKinds)[number];

export const repoRootMarkerKinds = [
  "git",
  "package",
  "workspace",
  "ci",
  "build",
  "docs",
  "unknown",
] as const;

export type RepoRootMarkerKind = (typeof repoRootMarkerKinds)[number];

export const repoPackageManagerKinds = ["npm", "pnpm", "yarn", "bun", "unknown"] as const;

export type RepoPackageManagerKind = (typeof repoPackageManagerKinds)[number];

export const repoCiHintKinds = ["github-actions", "other"] as const;

export type RepoCiHintKind = (typeof repoCiHintKinds)[number];

export const layoutPathClasses = ["generated", "vendor", "project", "unmapped"] as const;

export type LayoutPathClass = (typeof layoutPathClasses)[number];

export const layoutGateScopeKinds = ["affected-projects", "root-app", "avoided-repo-root"] as const;

export type LayoutGateScopeKind = (typeof layoutGateScopeKinds)[number];

export const layoutConsumptionSources = [
  "layout-inspect-json",
  "layout-affected-json",
  "aie-cli",
] as const;

export type LayoutConsumptionSource = (typeof layoutConsumptionSources)[number];

export interface RepoRootMarker {
  readonly path: string;
  readonly kind: RepoRootMarkerKind;
  readonly section?: string;
}

export interface RepoProject {
  readonly id: string;
  readonly path: string;
  readonly kind: RepoProjectKind;
  readonly packageName: string | null;
  readonly packageManager: string | null;
  readonly gates: readonly string[];
}

export interface RepoPackageManager {
  readonly kind: RepoPackageManagerKind;
  readonly manifestPath: string;
  readonly lockfilePath: string | null;
}

export interface RepoCiHint {
  readonly kind: RepoCiHintKind;
  readonly path: string;
}

export interface RepoPathSignal {
  readonly path: string;
  readonly reason: string;
}

export interface RepoLayoutInspection {
  readonly kind: RepoLayoutKind;
  readonly root: string | null;
  readonly remotes: readonly { readonly name: string; readonly url: string }[];
  readonly rootMarkers: readonly RepoRootMarker[];
  readonly projects: readonly RepoProject[];
  readonly packageManagers: readonly RepoPackageManager[];
  readonly lockfiles: readonly string[];
  readonly ciHints: readonly RepoCiHint[];
  readonly generatedPaths: readonly RepoPathSignal[];
  readonly vendorPaths: readonly RepoPathSignal[];
  readonly warnings: readonly string[];
}

export interface RepoAffectedProject {
  readonly project: RepoProject;
  readonly changedPaths: readonly string[];
  readonly gates: readonly string[];
}

export interface RepoAffectedResult {
  readonly layout: RepoLayoutInspection;
  readonly changedPaths: readonly string[];
  readonly affectedProjects: readonly RepoAffectedProject[];
  readonly suggestedGates: readonly string[];
  readonly warnings: readonly string[];
}

export interface LayoutClassifiedPath {
  readonly path: string;
  readonly classification: LayoutPathClass;
}

export interface LayoutGateScope {
  readonly kind: LayoutGateScopeKind;
  readonly layoutKind: RepoLayoutKind;
  readonly source: LayoutConsumptionSource;
  readonly affectedProjectIds: readonly string[];
  readonly affectedProjectPaths: readonly string[];
  readonly suggestedGates: readonly string[];
  readonly classifiedPaths: readonly LayoutClassifiedPath[];
  readonly warnings: readonly string[];
  readonly avoidRepoRoot: boolean;
}

export interface LayoutConsumption {
  readonly inspect: RepoLayoutInspection;
  readonly affected: RepoAffectedResult | null;
  readonly scope: LayoutGateScope;
}
