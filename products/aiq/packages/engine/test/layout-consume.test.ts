import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repoLayoutKinds } from "@tjalve/aiq/model";
import { describe, expect, it } from "vitest";
import {
  LayoutConsumptionError,
  applyLayoutToCandidateFiles,
  classifyLayoutPath,
  createLayoutConsumption,
  parseLayoutAffectedJson,
  parseLayoutInspectJson,
} from "../src/layout-consume.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const aieLayoutFixtures = path.resolve(testDir, "../../../../aie/test/fixtures/layout");
const qubeCoreLayoutSource = path.resolve(
  testDir,
  "../../../../../packages/qube-core/src/repo_layout.ts",
);

function jsWorkspaceInspect() {
  return {
    kind: "javascript-typescript-workspace",
    root: null,
    remotes: [],
    rootMarkers: [{ path: "pnpm-workspace.yaml", kind: "workspace" }],
    projects: [
      {
        id: "fixture-root",
        path: ".",
        kind: "workspace",
        packageName: "fixture-root",
        packageManager: "pnpm",
        gates: ["build"],
      },
      {
        id: "@fixture/core",
        path: "packages/core",
        kind: "package",
        packageName: "@fixture/core",
        packageManager: "pnpm",
        gates: ["build", "typecheck", "test"],
      },
      {
        id: "@fixture/web",
        path: "apps/web",
        kind: "package",
        packageName: "@fixture/web",
        packageManager: "pnpm",
        gates: ["build", "typecheck", "test"],
      },
    ],
    packageManagers: [
      { kind: "pnpm", manifestPath: "package.json", lockfilePath: "pnpm-lock.yaml" },
    ],
    lockfiles: ["pnpm-lock.yaml"],
    ciHints: [],
    generatedPaths: [{ path: "dist", reason: "Generated package build output path exists." }],
    vendorPaths: [{ path: "vendor", reason: "Vendored dependency path exists." }],
    warnings: [],
  };
}

function singleAppInspect() {
  return {
    kind: "single-app-service",
    root: null,
    remotes: [],
    rootMarkers: [{ path: "package.json", kind: "package" }],
    projects: [
      {
        id: "single-app-fixture",
        path: ".",
        kind: "app",
        packageName: "single-app-fixture",
        packageManager: "npm",
        gates: ["build", "typecheck", "test"],
      },
    ],
    packageManagers: [{ kind: "npm", manifestPath: "package.json", lockfilePath: null }],
    lockfiles: [],
    ciHints: [{ kind: "github-actions", path: ".github/workflows/ci.yml" }],
    generatedPaths: [{ path: "dist", reason: "Generated package build output path exists." }],
    vendorPaths: [],
    warnings: [],
  };
}

describe("layout consumption", () => {
  it("keeps consume kinds aligned with the shared layout contract", async () => {
    const source = await readFile(qubeCoreLayoutSource, "utf8");
    for (const kind of repoLayoutKinds) {
      expect(source).toContain(`"${kind}"`);
    }
  });

  it("reads inspect and affected JSON for the JS workspace fixture contract", () => {
    const inspect = parseLayoutInspectJson(JSON.stringify(jsWorkspaceInspect()));
    const core = inspect.projects.find((project) => project.id === "@fixture/core");
    expect(core).toBeDefined();
    const affected = parseLayoutAffectedJson(
      JSON.stringify({
        ok: true,
        command: "repo affected",
        layout: inspect,
        changedPaths: ["packages/core/src/index.ts"],
        affectedProjects: [
          {
            project: core,
            changedPaths: ["packages/core/src/index.ts"],
            gates: ["build", "typecheck", "test"],
          },
        ],
        suggestedGates: ["build", "typecheck", "test"],
        warnings: [],
      }),
    );
    const layout = createLayoutConsumption({
      inspect,
      affected,
      source: "layout-affected-json",
      candidatePaths: ["packages/core/src/index.ts"],
    });

    expect(layout.inspect.kind).toBe("javascript-typescript-workspace");
    expect(layout.scope.kind).toBe("affected-projects");
    expect(layout.scope.affectedProjectIds).toEqual(["@fixture/core"]);
    expect(layout.scope.avoidRepoRoot).toBe(false);
    expect(aieLayoutFixtures.replace(/\\/g, "/")).toContain("fixtures/layout");
  });

  it("keeps a nested single-app change on the root app scope", () => {
    const inspect = parseLayoutInspectJson(JSON.stringify(singleAppInspect()));
    const app = inspect.projects[0];
    expect(app).toBeDefined();
    const affected = parseLayoutAffectedJson(
      JSON.stringify({
        layout: inspect,
        changedPaths: ["src/index.ts", "test/index.test.ts"],
        affectedProjects: [
          {
            project: app,
            changedPaths: ["src/index.ts", "test/index.test.ts"],
            gates: ["build", "typecheck", "test"],
          },
        ],
        suggestedGates: ["build", "typecheck", "test"],
        warnings: [],
      }),
    );
    const layout = createLayoutConsumption({
      inspect,
      affected,
      source: "layout-affected-json",
      candidatePaths: ["src/index.ts"],
    });

    expect(layout.scope.kind).toBe("root-app");
    expect(layout.scope.affectedProjectPaths).toEqual(["."]);
    expect(layout.scope.avoidRepoRoot).toBe(false);
  });

  it("classifies generated and vendor paths from layout signals", () => {
    const inspect = parseLayoutInspectJson(JSON.stringify(jsWorkspaceInspect()));
    expect(classifyLayoutPath(inspect, "dist/index.js")).toBe("generated");
    expect(classifyLayoutPath(inspect, "vendor/lib/index.js")).toBe("vendor");
    expect(classifyLayoutPath(inspect, "packages/core/src/index.ts")).toBe("project");
  });

  it("omits generated paths from scoped files", () => {
    const inspect = parseLayoutInspectJson(JSON.stringify(singleAppInspect()));
    const layout = createLayoutConsumption({
      inspect,
      source: "layout-inspect-json",
      candidatePaths: ["src/index.ts", "dist/bundle.js"],
    });
    const scoped = applyLayoutToCandidateFiles({
      files: ["src/index.ts", "dist/bundle.js"],
      cwd: process.cwd(),
      layout,
      requireProvenScope: false,
    });

    expect(scoped.files).toEqual(["src/index.ts"]);
    expect(scoped.classifiedPaths).toEqual(
      expect.arrayContaining([
        { path: "src/index.ts", classification: "project" },
        { path: "dist/bundle.js", classification: "generated" },
      ]),
    );
  });

  it("avoids a repository-root gate when layout is unknown", () => {
    const inspect = parseLayoutInspectJson(
      JSON.stringify({
        ...jsWorkspaceInspect(),
        kind: "unknown",
        warnings: ["Repository layout could not be classified from supported local signals."],
      }),
    );
    const layout = createLayoutConsumption({
      inspect,
      source: "layout-inspect-json",
      candidatePaths: ["packages/core/src/index.ts"],
    });

    expect(layout.scope.kind).toBe("avoided-repo-root");
    expect(layout.scope.avoidRepoRoot).toBe(true);
    expect(() =>
      applyLayoutToCandidateFiles({
        files: ["packages/core/src/index.ts"],
        cwd: process.cwd(),
        layout,
        requireProvenScope: true,
      }),
    ).toThrow(/will not run a repository-root gate/);
  });

  it.each([
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
  ] as const)("uses member scope for %s affected JSON", (kind) => {
    const inspect = parseLayoutInspectJson(
      JSON.stringify({
        ...jsWorkspaceInspect(),
        kind,
        projects: [
          {
            id: "root",
            path: ".",
            kind: "workspace",
            packageName: null,
            packageManager: null,
            gates: ["build"],
          },
          {
            id: "member",
            path: "packages/core",
            kind: "package",
            packageName: "member",
            packageManager: null,
            gates: ["test"],
          },
        ],
      }),
    );
    const layout = createLayoutConsumption({
      inspect,
      affected: parseLayoutAffectedJson(
        JSON.stringify({
          layout: inspect,
          changedPaths: ["packages/core/src/lib.rs"],
          affectedProjects: [
            {
              project: inspect.projects.find((project) => project.id === "member"),
              changedPaths: ["packages/core/src/lib.rs"],
              gates: ["test"],
            },
          ],
          suggestedGates: ["test"],
          warnings: [],
        }),
      ),
      source: "layout-affected-json",
    });

    expect(layout.scope.kind).toBe("affected-projects");
    expect(layout.scope.affectedProjectIds).toEqual(["member"]);
  });

  it("fails loudly on malformed inspect JSON", () => {
    expect(() => parseLayoutInspectJson("{")).toThrow(LayoutConsumptionError);
    expect(() => parseLayoutInspectJson(JSON.stringify({ kind: "not-a-layout" }))).toThrow(
      /not a supported value/,
    );
  });

  it("rejects absolute and parent-directory layout paths", () => {
    expect(() =>
      parseLayoutInspectJson(
        JSON.stringify({
          ...singleAppInspect(),
          projects: [
            {
              id: "escape",
              path: "../outside",
              kind: "app",
              packageName: null,
              packageManager: null,
              gates: [],
            },
          ],
        }),
      ),
    ).toThrow(/parent-directory/);
    expect(() =>
      parseLayoutInspectJson(
        JSON.stringify({
          ...singleAppInspect(),
          generatedPaths: [{ path: "/tmp/generated", reason: "escape" }],
        }),
      ),
    ).toThrow(/repository-relative/);
  });

  it("rejects inspect and affected JSON that describe different layout kinds", () => {
    const inspect = parseLayoutInspectJson(JSON.stringify(singleAppInspect()));
    const affected = parseLayoutAffectedJson(
      JSON.stringify({
        layout: { ...jsWorkspaceInspect() },
        changedPaths: ["src/index.ts"],
        affectedProjects: [],
        suggestedGates: [],
        warnings: [],
      }),
    );

    expect(() =>
      createLayoutConsumption({
        inspect,
        affected,
        source: "layout-affected-json",
      }),
    ).toThrow(/same layout kind/);
  });

  it("does not import layout detection from Executor", async () => {
    const source = await readFile(path.join(testDir, "../src/layout-consume.ts"), "utf8");
    expect(source).not.toContain("inspectRepoLayout");
    expect(source).not.toContain("detectJsWorkspace");
    expect(source).not.toContain("detectLayoutKind");
  });
});
