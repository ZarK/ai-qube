import { describe, expect, it } from "vitest";
import { createDotNetFixtureProject, runPlannedTask, writeFile } from "./runners-test-support.js";
describe("engine runners", () => {
  it("counts compact ternaries without surrounding whitespace", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-compact-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag)",
        "    {",
        "        return flag?1:0;",
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
        id: "test:1:complexity-dotnet-compact-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("counts ternaries with object initializer branches", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-object-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public sealed class GreetingResult",
        "{",
        "    public string Message { get; init; } = string.Empty;",
        "}",
        "",
        "public static class Greeter",
        "{",
        "    public static GreetingResult Create(bool flag, GreetingResult fallback)",
        "    {",
        '        return flag ? new GreetingResult { Message = "hello" } : fallback;',
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
        id: "test:1:complexity-dotnet-object-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });

  it("counts ternaries with switch-expression branches", async () => {
    const project = await createDotNetFixtureProject("aiq-dotnet-switch-ternary-runner-");

    await writeFile(
      project.sourceFile,
      [
        "namespace DotNetFixture;",
        "",
        "public static class Greeter",
        "{",
        "    public static int Score(bool flag, int value)",
        "    {",
        "        return flag ? value switch",
        "        {",
        "            > 0 => 1,",
        "            _ => 0,",
        "        } : 0;",
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
        id: "test:1:complexity-dotnet-switch-ternary",
        stageId: "complexity",
      },
      process.cwd(),
    );

    expect(result.status).toBe("passed");
    expect(result.notes[0]).toContain("C# complexity max: 2");
  });
});
