import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { createDotNetFixtureProject } from "./runners-test-support.js";

export async function createDotNetCompetingSolutionProject(prefix: string): Promise<{
  noiseFile: string;
  root: string;
  solutionFile: string;
  sourceFile: string;
  testFile: string;
}> {
  const project = await createDotNetFixtureProject(prefix);
  const failingProjectDir = path.join(project.root, "other", "Failing.Tests");
  await mkdir(failingProjectDir, { recursive: true });

  await writeFile(
    path.join(failingProjectDir, "Failing.Tests.csproj"),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <TargetFramework>net10.0</TargetFramework>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <Nullable>enable</Nullable>",
      "    <IsPackable>false</IsPackable>",
      "  </PropertyGroup>",
      "",
      "  <ItemGroup>",
      '    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />',
      '    <PackageReference Include="xunit" Version="2.9.3" />',
      '    <PackageReference Include="xunit.runner.visualstudio" Version="3.1.4" />',
      "  </ItemGroup>",
      "",
      "  <ItemGroup>",
      '    <Using Include="Xunit" />',
      "  </ItemGroup>",
      "</Project>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(failingProjectDir, "FailingTests.cs"),
    [
      "namespace Failing.Tests;",
      "",
      "public class FailingTests",
      "{",
      "    [Fact]",
      "    public void Always_fails()",
      "    {",
      "        Assert.True(false);",
      "    }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(project.root, "AOther.slnx"),
    [
      "<Solution>",
      '  <Project Path="other/Failing.Tests/Failing.Tests.csproj" />',
      "</Solution>",
      "",
    ].join("\n"),
    "utf8",
  );

  const noiseDir = path.join(project.root, "unrelated");
  await mkdir(noiseDir, { recursive: true });
  const noiseFile = path.join(noiseDir, "Noise.cs");
  await writeFile(
    noiseFile,
    [
      "namespace Unrelated;",
      "",
      "public static class Noise",
      "{",
      "    public static string? Value => null;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const nestedProjectDir = path.join(project.root, "src", "DotNetFixture", "Nested", "Shadow");
  await mkdir(nestedProjectDir, { recursive: true });
  await writeFile(
    path.join(nestedProjectDir, "Shadow.csproj"),
    [
      '<Project Sdk="Microsoft.NET.Sdk">',
      "  <PropertyGroup>",
      "    <TargetFramework>net10.0</TargetFramework>",
      "    <ImplicitUsings>enable</ImplicitUsings>",
      "    <Nullable>enable</Nullable>",
      "  </PropertyGroup>",
      "</Project>",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(nestedProjectDir, "Shadow.cs"),
    [
      "namespace DotNetFixture.Nested;",
      "",
      "public static class Shadow",
      "{",
      '    public static string Describe() => "shadow";',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  return {
    ...project,
    noiseFile,
  };
}
