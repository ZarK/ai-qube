import { describe, expect, it } from "vitest";
import { createDotNetFixtureProject, runPlannedTask, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("reports the highest method complexity without averaging simple methods", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-method-maximum-");
    await writeFile(
      project.sourceFile,
      [
        "public static class Scores {",
        "  public static int Complex(int value) {",
        ...Array.from({ length: 13 }, (_, index) => `    if (value == ${index}) return ${index};`),
        "    return -1;",
        "  }",
        ...Array.from(
          { length: 10 },
          (_, index) => `  public static int Simple${index}() { return ${index}; }`,
        ),
        "}",
      ].join("\n"),
    );
    const result = await runPlannedTask(
      {
        fileCount: 1,
        files: [project.sourceFile],
        id: "complexity-method-maximum",
        stageId: "complexity",
      },
      process.cwd(),
    );
    expect(result.status).toBe("failed");
    expect(result.notes.join(" ")).toContain("C# complexity max: 14");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("Complex complexity 14"),
      }),
    );
  });

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
      tool: "lizard",
    });
    expect(secondComplexity.status).toBe("passed");
    expect(secondComplexity.notes[0]).toContain("C# complexity max: 3");
    expect(secondComplexity.toolRuns[0]).toMatchObject({
      cacheHit: false,
      exitCode: 0,
      status: "passed",
      tool: "lizard",
    });
  }, 20_000);

  it("measures conditional access and ternary branches with Lizard", async () => {
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
    expect(result.notes[0]).toContain("C# complexity max: 3");
  });
});
