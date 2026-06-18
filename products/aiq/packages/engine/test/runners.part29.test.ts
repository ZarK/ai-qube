import { describe, expect, it } from "vitest";
import {
  createRustFixtureProject,
  hasRustToolchain,
  runPlannedTask,
  withExclusiveRust,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasRustToolchain)(
    "runs Rust typecheck and parses compiler diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-typecheck-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String {",
            "    let trimmed_name = name.trim();",
            "    42 + trimmed_name.len()",
            "}",
            "",
            "pub fn sum(values: &[i32]) -> i32 {",
            "    values.iter().sum()",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:typecheck-rust",
            stageId: "typecheck",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-check",
        });
        expect(result.diagnostics[0]?.message).toContain("mismatched types");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-check",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "runs Rust unit tests for Rust projects",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-runner-");

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("passed");
        expect(result.diagnostics).toEqual([]);
        expect(result.notes[0]).toContain("cargo test ran");
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 0,
          status: "passed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );
});
