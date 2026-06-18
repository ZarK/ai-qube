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
    "reports Rust unit test failures",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-fail-runner-");

        await writeFile(
          project.testFile,
          [
            "use aiq_rust_fixture::{greet, sum};",
            "",
            "#[test]",
            "fn greets_from_integration_tests() {",
            '    assert_eq!(greet("Rust"), "Hello, Rust!");',
            "}",
            "",
            "#[test]",
            "fn sums_from_integration_tests() {",
            "    assert_eq!(sum(&[4, 5]), 10);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust-fail",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics[0]).toMatchObject({
          file: project.testFile,
          range: {
            startColumn: 5,
            startLine: 10,
          },
          severity: "error",
          source: "cargo-test",
        });
        expect(result.diagnostics[0]?.message).toContain("sums_from_integration_tests");
        expect(result.notes[0]).toBe("cargo test ran 4 tests: 3 passed, 1 failed.");
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );

  it.skipIf(!hasRustToolchain)(
    "parses Rust compiler diagnostics from cargo test JSON output",
    async () => {
      await withExclusiveRust(async () => {
        const project = await createRustFixtureProject("aiq-rust-unit-compile-fail-runner-");

        await writeFile(
          project.testFile,
          [
            "use aiq_rust_fixture::greet;",
            "",
            "#[test]",
            "fn integration_compile_failure() {",
            '    let message: i32 = greet("Rust");',
            "    assert_eq!(message, 1);",
            "}",
            "",
          ].join("\n"),
          "utf8",
        );

        const result = await runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:unit-rust-compile-fail",
            stageId: "unit",
          },
          process.cwd(),
        );

        expect(result.status).toBe("failed");
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            file: project.testFile,
            severity: "error",
            source: "cargo-test",
          }),
        );
        expect(
          result.diagnostics.some((diagnostic) => diagnostic.message.includes("mismatched types")),
        ).toBe(true);
        expect(result.toolRuns[0]).toMatchObject({
          status: "failed",
          tool: "cargo-test",
        });
      });
    },
    20_000,
  );
});
