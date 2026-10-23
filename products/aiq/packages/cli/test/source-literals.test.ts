import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolRunner } from "../../engine/src/tool-runner.js";
import type { RunResult } from "../../model/src/index.js";
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

afterEach(() => vi.restoreAllMocks());

const literalFixtures = [
  {
    name: "Go raw strings ending in a backslash",
    extension: "go",
    source: ["package main", "const value = `C:\\`"],
    sloc: 2,
  },
  {
    name: "Go multiline raw strings containing comment markers",
    extension: "go",
    source: ["package main", "const value = `// text", '/* "text" */', "C:\\`"],
    sloc: 4,
  },
  {
    name: "Go interpreted strings with escaped quotes",
    extension: "go",
    source: ["package main", 'const value = "\\"// text"'],
    sloc: 2,
  },
  ...["r", "br", "cr"].flatMap((prefix) =>
    ["", "#", "###"].map((hashes) => ({
      name: `Rust ${prefix} raw strings with ${hashes.length} hashes`,
      extension: "rs",
      source: [
        `const VALUE: ${prefix === "br" ? "&[u8]" : prefix === "cr" ? "&std::ffi::CStr" : "&str"} = ${prefix}${hashes}"// text`,
        ...(hashes.length > 0 ? ['" // still literal text'] : []),
        `C:\\"${hashes};`,
      ],
      sloc: hashes.length > 0 ? 3 : 2,
    })),
  ),
  {
    name: "C# verbatim strings with doubled quotes and trailing backslashes",
    extension: "cs",
    source: ['var value = @"a ""// text', "/* literal text */", 'C:\\";'],
    sloc: 3,
  },
  {
    name: "C# verbatim strings starting with a doubled quote",
    extension: "cs",
    source: ['var value = @"""// text', "/* literal text */", 'C:\\";'],
    sloc: 3,
  },
  ...['$@"', '@$"'].map((prefix) => ({
    name: `C# ${prefix} verbatim strings`,
    extension: "cs",
    source: [`var value = ${prefix}a ""// text`, 'C:\\";'],
    sloc: 2,
  })),
  ...['"""', '""""'].map((quotes) => ({
    name: `C# raw strings with ${quotes.length} quotes`,
    extension: "cs",
    source: [
      `var value = ${quotes}`,
      '" // literal text',
      `${'"'.repeat(quotes.length - 1)} /* literal text */`,
      "C:\\",
      `${quotes};`,
    ],
    sloc: 5,
  })),
  {
    name: "C# single-line raw strings ending in a backslash",
    extension: "cs",
    source: ['var value = """C:\\""";'],
    sloc: 1,
  },
  {
    name: "Java text blocks with escaped quotes",
    extension: "java",
    source: [
      "class Main {",
      'static String value = """',
      '\\""" // literal text',
      "/* literal text */",
      '""";',
      "}",
    ],
    sloc: 6,
  },
  {
    name: "Kotlin raw strings ending in a backslash",
    extension: "kt",
    source: ['val value = """// literal text', '"" /* literal text */', 'C:\\"""'],
    sloc: 3,
  },
  ...["js", "ts"].map((extension) => ({
    name: `${extension} templates with nested interpolation and escaped backticks`,
    extension,
    source: [
      "const value = `// text \\`",
      "${",
      "  // interpolation comment",
      "  `nested ${",
      "    /* nested interpolation comment */",
      '    "value"',
      "  }`",
      "}",
      "/* literal text */`;",
    ],
    sloc: 7,
  })),
];

describe("CLI source literal metrics", () => {
  it.each(literalFixtures)("counts $name", async ({ extension, source, sloc }) => {
    const root = await createSourceProject(extension, [
      ...source,
      ...Array(800).fill("// comment"),
    ]);
    const run = vi.spyOn(ToolRunner.prototype, "run").mockImplementation(async (_command, args) => {
      expect(args.slice(0, 3)).toEqual(["--from", "lizard==1.24.1", "lizard"]);
      return {
        durationMs: 1,
        exitCode: 0,
        finishedAt: "2026-01-01T00:00:01.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        stderr: "",
        stdout: "",
      };
    });
    const result = await runSourceMetrics(root, extension);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.summary.status).toBe("passed");
    expect(result.stages[0]?.notes.join(" ")).toContain(`SLOC: ${sloc} across 1 file.`);
    expect(result.stages[0]?.toolRuns[0]?.args.slice(0, 3)).toEqual([
      "--from",
      "lizard==1.24.1",
      "lizard",
    ]);
  });

  it.each([
    {
      name: "triple double quotes",
      source: ['value = """// text', '" # literal text', "/* literal text */", '"""'],
      sloc: 4,
    },
    {
      name: "triple single quotes",
      source: ["value = '''// text", "' # literal text", "/* literal text */", "'''"],
      sloc: 4,
    },
    {
      name: "raw strings with escaped quotes",
      source: ['value = r"\\"# text"'],
      sloc: 1,
    },
    {
      name: "raw triple strings",
      source: ['value = r"""\\""" # literal text', "/* literal text */", '"""'],
      sloc: 3,
    },
  ])("counts Python $name through Radon", async ({ source, sloc }) => {
    const root = await createSourceProject("py", [...source, ...Array(800).fill("# comment")]);
    const result = await runSourceMetrics(root, "py");
    expect(result.summary.status).toBe("passed");
    expect(result.stages[0]?.notes.join(" ")).toContain(`Python SLOC: ${sloc} across 1 file.`);
    expect(result.stages[0]?.toolRuns[0]?.tool).toBe("radon");
  });
});

async function createSourceProject(extension: string, source: string[]): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "aiq-source-literals-"));
  tempDirs.push(root);
  await mkdir(path.join(root, ".qube", "aiq"), { recursive: true });
  await writeFile(
    path.join(root, ".qube", "aiq", "config.json"),
    JSON.stringify({ version: 1, stages: { sloc: { limit: 800 } } }),
  );
  await writeFile(path.join(root, `source.${extension}`), source.join("\n"));
  const projectFiles: Record<string, [string, string]> = {
    go: ["go.mod", "module example.com/literals\n\ngo 1.24\n"],
    rs: ["Cargo.toml", '[package]\nname = "literals"\nversion = "0.1.0"\nedition = "2024"\n'],
    cs: ["Literals.csproj", '<Project Sdk="Microsoft.NET.Sdk" />'],
    java: ["pom.xml", "<project><modelVersion>4.0.0</modelVersion></project>"],
    kt: ["build.gradle.kts", ""],
    js: ["package.json", '{"name":"literals","private":true}'],
    ts: ["package.json", '{"name":"literals","private":true}'],
    py: ["pyproject.toml", '[project]\nname = "literals"\nversion = "0.1.0"\n'],
  };
  const projectFile = projectFiles[extension];
  if (projectFile !== undefined) {
    await writeFile(path.join(root, projectFile[0]), projectFile[1]);
  }
  return root;
}

async function runSourceMetrics(root: string, extension: string): Promise<RunResult> {
  const stdout = new MemoryOutput();
  const stderr = new MemoryOutput();
  const exitCode = await runCli(
    ["node", "aiq", "run", `source.${extension}`, "--only", "5", "--format", "json"],
    { cwd: root, stdin: new MemoryInput(), stdout, stderr },
  );
  expect(stderr.value).toBe("");
  expect(exitCode, stdout.value).toBe(0);
  return JSON.parse(stdout.value) as RunResult;
}
