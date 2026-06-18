import { describe, expect, it, vi } from "vitest";
import {
  ToolRunner,
  buildEngineContext,
  chmod,
  createRustFixtureProject,
  hasRustCoverageToolchain,
  hasRustToolchain,
  mkdir,
  mkdtemp,
  os,
  path,
  resolveCommandPath,
  runPlannedTask,
  tempDirs,
  withExclusiveRust,
  withToolRunnerOverride,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasRustCoverageToolchain)(
    "runs Rust coverage for Rust projects",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-coverage-runner-");

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-rust",
            stageId: "coverage",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.notes[0]).toContain("cargo llvm-cov lines:");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 0,
          status: "passed",
          tool: "cargo-llvm-cov",
        });
      });
    },
    60_000,
  );

  it.skipIf(!hasRustToolchain)(
    "reports Rust coverage as failed setup when cargo llvm-cov is unavailable",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-coverage-missing-tool-runner-");
        const shimRoot = await mkdtemp(path.join(os.tmpdir(), "aiq-rust-coverage-shim-"));
        tempDirs.push(shimRoot);

        const shimBin = path.join(shimRoot, "bin");
        await mkdir(shimBin, { recursive: true });

        const cargoShim = path.join(shimBin, "cargo");
        const cargoDir = path.dirname(resolveCommandPath("cargo"));
        const rustcDir = path.dirname(resolveCommandPath("rustc"));
        await writeFile(
          cargoShim,
          [
            "#!/bin/sh",
            'if [ "$1" = "llvm-cov" ]; then',
            "  printf '%s\\n' 'error: no such command: `llvm-cov`' >&2",
            "  exit 101",
            "fi",
            `exec "${path.join(cargoDir, "cargo")}" "$@"`,
            "",
          ].join("\n"),
          "utf8",
        );
        await chmod(cargoShim, 0o755);

        const toolRunner = new ToolRunner();
        const rustEnv = {
          PATH: [shimBin, cargoDir, rustcDir].join(path.delimiter),
        };

        vi.spyOn(toolRunner, "createRustProcessEnv").mockResolvedValue(rustEnv);
        vi.spyOn(toolRunner, "resolveInstalledBinary").mockImplementation(async (commandName) => {
          if (commandName === "cargo") {
            return cargoShim;
          }

          if (commandName === "rustc") {
            return path.join(rustcDir, "rustc");
          }

          return undefined;
        });

        const engineContext = withToolRunnerOverride(
          await buildEngineContext({
            context: "cli",
            manifest: {
              files: [project.sourceFile],
              source: "direct",
            },
            mode: "check",
            outDir: project.root,
            stages: ["coverage"],
          }),
          toolRunner,
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:coverage-rust-missing-tool",
            stageId: "coverage",
          },
          engineContext,
        );

        expect(JSON.stringify(result)).not.toContain("not_implemented");
        expect(result.status).toBe("failed");
        expect(result.diagnostics).toEqual([
          expect.objectContaining({
            file: project.sourceFile,
            severity: "error",
            source: "cargo-llvm-cov",
          }),
        ]);
        expect(result.notes[0]).toContain("cargo-llvm-cov");
        expect(result.notes[0]).toContain("disable Rust coverage");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 101,
          status: "failed",
          tool: "cargo-llvm-cov",
        });
      });
    },
    60_000,
  );
});
