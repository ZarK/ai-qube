import { describe, expect, it } from "vitest";
import {
  createDotNetFixtureProject,
  createRustFixtureProject,
  hasDotNet10Toolchain,
  runPlannedTask,
  withExclusiveDotNet,
  writeFile,
} from "./runners-test-support.js";

const fakeGitHubToken = ["ghp", "123456789012345678901234567890123456"].join("_");

describe("engine runners", () => {
  it("runs the shared security scan for Rust inputs", async () => {
    const project = await createRustFixtureProject("aiq-rust-security-runner-");

    await writeFile(
      project.sourceFile,
      [`pub const TOKEN: &str = "${fakeGitHubToken}";`, ""].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:security-rust",
        stageId: "security",
      },
      process.cwd(),
    );

    expect(result.status).toBe("failed");
    expect(result.diagnostics[0]).toMatchObject({
      file: project.sourceFile,
      severity: "error",
      source: "aiq-security",
    });
    expect(result.toolRuns[0]).toMatchObject({
      exitCode: 1,
      status: "failed",
      tool: "aiq-security",
    });
  });

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet style lint and returns structured diagnostics for C# files",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-lint-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "    public static string CreateGreeting(string name)",
          "    {",
          "        string trimmedName = name.Trim();",
          '        return $"Hello, {trimmedName}!";',
          "    }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await withExclusiveDotNet(async () =>
        runPlannedTask(
          {
            fileCount: 1,
            files: [project.sourceFile],
            id: "test:1:lint-dotnet",
            stageId: "lint",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "IDE0007",
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-format",
      });
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-format-style",
      });
    },
    90_000,
  );
});
