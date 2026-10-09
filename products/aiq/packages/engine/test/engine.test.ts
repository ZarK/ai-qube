import { describe, expect, it } from "vitest";
import {
  os,
  path,
  createRunPlan,
  fixtureFile,
  mkdir,
  mkdtemp,
  normalizeFileManifest,
  resolveRunRequest,
  runEngine,
  tempDirs,
  writeFile,
} from "./engine-test-support.js";
describe("engine foundation", () => {
  it("normalizes and de-duplicates manifest paths", async () => {
    const manifest = await normalizeFileManifest(
      {
        files: ["test-projects/typescript/src/index.ts", fixtureFile],
        source: "mixed",
      },
      process.cwd(),
    );

    expect(manifest.entries).toEqual([
      {
        extension: ".ts",
        path: fixtureFile,
      },
    ]);
    expect(manifest.files).toEqual([fixtureFile]);
    expect(manifest.source).toBe("mixed");
    expect(manifest.summary.fileCount).toBe(1);
  });

  it("resolves adapter-agnostic run requests", async () => {
    const request = await resolveRunRequest({
      context: "cli",
      cwd: ".",
      manifest: {
        files: [fixtureFile],
        source: "direct",
      },
      mode: "check",
      stages: ["lint"],
      profile: "fast",
    });

    expect(request.context).toBe("cli");
    expect(request.cwd).toBe(process.cwd());
    expect(request.manifest.root).toBe(process.cwd());
    expect(request.manifest.summary.fileCount).toBe(1);
    expect(request.outDir).toBe(path.resolve(process.cwd(), ".qube/aiq/out"));
    expect(request.selection).toEqual({
      stages: ["lint"],
      profile: "fast",
    });
  });
  it("expands directories and applies nested ignore globs to every input source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-inputs-"));
    tempDirs.push(root);
    await mkdir(path.join(root, "packages", "app", "dist"), { recursive: true });
    await writeFile(path.join(root, "packages", "app", "main.ts"), "export const value = 1;\n");
    await writeFile(path.join(root, "packages", "app", "dist", "main.mjs"), "export {};\n");
    for (const source of ["direct", "file-list", "stream"] as const) {
      const result = await normalizeFileManifest(
        {
          files: ["packages", "packages/app/dist/main.mjs"],
          source,
          ignore: ["dist/**"],
        },
        root,
      );
      expect(result.files).toEqual([path.join(root, "packages", "app", "main.ts")]);
    }
  });

  it("fails selected stages when an explicit directory contains no supported files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-empty-inputs-"));
    tempDirs.push(root);
    await mkdir(path.join(root, "empty"));
    const result = await runEngine({
      cwd: root,
      manifest: { files: ["empty"], source: "direct" },
      mode: "check",
      stages: ["lint", "sloc"],
      writeArtifacts: false,
    });
    expect(result.ok).toBe(false);
    expect(result.summary.status).toBe("failed");
    expect(result.stages.every((stage) => stage.status === "failed")).toBe(true);
    expect(result.stages[0]?.notes).toEqual(["Explicit target selected no files."]);
  });
  it("does not reintroduce ignored diff-only files into a stage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "aiq-ignored-diff-"));
    tempDirs.push(root);
    await mkdir(path.join(root, "dist"));
    await writeFile(path.join(root, "main.ts"), "export {};\n");
    await writeFile(path.join(root, "dist", "main.ts"), "export {};\n");
    const plan = await createRunPlan({
      cwd: root,
      mode: "check",
      stages: ["lint"],
      diffOnly: true,
      diffOnlyFiles: ["dist/main.ts"],
      manifest: { files: ["main.ts"], source: "direct", ignore: ["dist/**"] },
    });
    expect(plan.tasks[0]?.files).toEqual([]);
  });
});
