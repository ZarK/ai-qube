import { describe, expect, it } from "vitest";
import {
  createDotNetFixtureProject,
  hasDotNet10Toolchain,
  runPlannedTask,
  withExclusiveDotNet,
  writeFile,
} from "./runners-test-support.js";
describe("engine runners", () => {
  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet whitespace format and reports formatting diagnostics",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-format-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "public static string CreateGreeting(string name){",
          "    var trimmedName = name.Trim();",
          '    return $"Hello, {trimmedName}!";    ',
          "}",
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
            id: "test:1:format-dotnet",
            stageId: "format",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        code: "WHITESPACE",
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-format",
      });
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-format-whitespace",
      });
    },
    90_000,
  );

  it.skipIf(!hasDotNet10Toolchain)(
    "runs dotnet build typecheck and parses compiler diagnostics",
    async () => {
      const project = await createDotNetFixtureProject("aiq-dotnet-typecheck-runner-");

      await writeFile(
        project.sourceFile,
        [
          "namespace DotNetFixture;",
          "",
          "public static class Greeter",
          "{",
          "    public static string CreateGreeting(string name)",
          "    {",
          "        return 42;",
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
            id: "test:1:typecheck-dotnet",
            stageId: "typecheck",
          },
          process.cwd(),
        ),
      );

      expect(result.status).toBe("failed");
      expect(result.diagnostics[0]).toMatchObject({
        file: project.sourceFile,
        severity: "error",
        source: "dotnet-build",
      });
      expect(result.diagnostics[0]?.message).toContain("Cannot implicitly convert type");
      expect(result.toolRuns[0]).toMatchObject({
        status: "failed",
        tool: "dotnet-build",
      });
    },
    90_000,
  );
});
