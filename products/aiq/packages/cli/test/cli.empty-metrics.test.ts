import { describe, expect, it } from "vitest";

import {
  os,
  path,
  MemoryInput,
  MemoryOutput,
  mkdir,
  mkdtemp,
  runCli,
  tempDirs,
  writeFile,
} from "./cli-test-support.js";

const projects = [
  {
    language: "C#",
    file: "Empty.csproj",
    contents:
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>',
  },
  { language: "Go", file: "go.mod", contents: "module example.com/empty\n\ngo 1.24\n" },
  {
    language: "Rust",
    file: "Cargo.toml",
    contents: '[package]\nname = "empty"\nversion = "0.1.0"\nedition = "2024"\n',
  },
  {
    language: "JVM",
    file: "pom.xml",
    contents:
      "<project><modelVersion>4.0.0</modelVersion><groupId>example</groupId><artifactId>empty</artifactId><version>1.0.0</version></project>",
  },
  {
    language: "JavaScript/TypeScript",
    file: "package.json",
    contents: '{"name":"empty","private":true}',
  },
  {
    language: "Python",
    file: "pyproject.toml",
    contents: '[project]\nname = "empty"\nversion = "0.1.0"\n',
  },
];
const metricStages = [
  { stageId: "sloc", index: "5" },
  { stageId: "complexity", index: "6" },
  { stageId: "maintainability", index: "7" },
];

describe("CLI metrics for projects without source files", () => {
  it.each(projects.flatMap((project) => metricStages.map((stage) => ({ ...project, ...stage }))))(
    "reports $language $stageId as warning with a reason",
    async ({ language, file, contents, stageId, index }) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "aiq-empty-metrics-"));
      tempDirs.push(root);
      const projectRoot = path.join(root, "project");
      await mkdir(projectRoot);
      await writeFile(path.join(projectRoot, file), contents);
      const stdout = new MemoryOutput();
      const stderr = new MemoryOutput();

      const exitCode = await runCli(
        ["node", "aiq", "run", "project", "--only", index, "--format", "json"],
        { cwd: root, stdin: new MemoryInput(), stdout, stderr },
      );

      expect(stderr.value).toBe("");
      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout.value);
      const reason = `No ${language} source files were measured for ${stageId}.`;
      expect(report.plan.input.files).toEqual([path.join(projectRoot, file)]);
      expect(report.summary.status).toBe("warning");
      expect(report.stages).toEqual([
        expect.objectContaining({
          stageId,
          status: "warning",
          diagnostics: [expect.objectContaining({ message: reason, severity: "warning" })],
          notes: expect.arrayContaining([reason]),
          toolRuns: [],
        }),
      ]);
    },
  );
});
