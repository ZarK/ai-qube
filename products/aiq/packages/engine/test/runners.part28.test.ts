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
    "runs Rust lint and returns structured diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-lint-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String {",
            "    let unused_value = 42;",
            "    let trimmed_name = name.trim();",
            '    format!("Hello, {trimmed_name}!")',
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
            id: "test:1:lint-rust",
            stageId: "lint",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-clippy",
        });
        expect(result.diagnostics[0]?.message).toContain("unused variable");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-clippy",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "runs Rust format and reports formatting diagnostics",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-format-runner-");

        await writeFile(
          project.sourceFile,
          [
            "pub fn greet(name: &str) -> String{",
            "let trimmed_name = name.trim();",
            'format!("Hello, {trimmed_name}!")',
            "}",
            "",
            "pub fn sum(values: &[i32]) -> i32 {",
            "values.iter().sum()",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:format-rust",
            stageId: "format",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.sourceFile,
          severity: "error",
          source: "cargo-fmt",
        });
        expect(result.toolRuns[0]).toMatchObject({
          exitCode: 1,
          status: "failed",
          tool: "cargo-fmt",
        });
      });
    },
    20_000,
  );
});
