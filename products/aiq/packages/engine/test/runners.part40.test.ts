import { describe, expect, it } from "vitest";
import { createDotNetFixtureProject, runPlannedTask, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("invalidates cached C# metrics when the file contents change", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-metrics-refresh-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag)",
        "    {",
        "        return flag ? 1 : 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const firstComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-invalidate:first",
        stageId: "complexity",
      },
      process.cwd(),
    );

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag, int value)",
        "    {",
        "        if (flag)",
        "        {",
        "            return value > 1 ? value : 1;",
        "        }",
        "",
        "        return 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const secondComplexity = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-invalidate:second",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(firstComplexity.status).toBe("passed");
    expect(firstComplexity.notes[0]).toContain("C# complexity max: 2");
    expect(firstComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
    expect(secondComplexity.status).toBe("passed");
    expect(secondComplexity.notes[0]).toContain("C# complexity max: 3");
    expect(secondComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "aiq-csharp-metrics",
    });
  }, 20_000);

  it("does not count nullable annotations as ternary complexity", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-nullable-metrics-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static string CreateGreeting(string? name, int? count)",
        "    {",
        '        var resolved = name is null ? "unknown" : name.Trim();',
        "        return resolved + count?.ToString();",
        "    }",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "test:1:complexity-dotnet-nullable-types",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });
});
