export type RepoLayoutKind =
  | "single-app-service"
  | "javascript-typescript-workspace"
  | "python-workspace-monorepo"
  | "rust-workspace"
  | "go-workspace"
  | "java-kotlin-multi-project"
  | "dotnet-solution"
  | "bazel-pants-buck-monorepo"
  | "c-cpp-cmake-superbuild"
  | "mobile-app-repo"
  | "infrastructure-repo"
  | "docs-content-repo"
  | "polyrepo-multi-checkout"
  | "generated-vendor-heavy"
  | "unknown";

export type RepoProjectKind = "workspace" | "package" | "app" | "service" | "docs" | "unknown";

export interface RepoRootMarker {
  readonly path: string;
  readonly kind: "git" | "package" | "workspace" | "ci" | "build" | "docs" | "unknown";
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
  readonly kind: "npm" | "pnpm" | "yarn" | "bun" | "unknown";
  readonly manifestPath: string;
  readonly lockfilePath: string | null;
}

export interface RepoCiHint {
  readonly kind: "github-actions" | "other";
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

export const REPO_LAYOUT_KINDS: readonly RepoLayoutKind[] = Object.freeze([
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
]);
