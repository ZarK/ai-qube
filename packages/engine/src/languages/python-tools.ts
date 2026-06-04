import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import type { Diagnostic, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import type { PythonMetricsFileMetrics } from "../parsers/python.js";
import * as binaries from "../tools/binary-resolver.js";
import * as commands from "../tools/command-builders.js";
import { pathExists } from "../utils/path-utils.js";
import type { PythonRunnerRuntime } from "./contracts.js";

type PythonProject = {
  files: string[];
  projectRoot: string;
};

type ResolvedTyExecution = {
  argsPrefix: string[];
  command: string;
};

export type PythonToolProjectResult = {
  diagnostics: Diagnostic[];
  durationMs: number;
  toolRun: ToolRunResult;
};

export type PythonProjectExecution = {
  coverageSummary: Record<string, unknown> | undefined;
  coverageSummaryError: string | undefined;
  diagnostics: Diagnostic[];
  summary: { failed: number; passed: number; total: number };
  toolRun: ToolRunResult;
};

export type PythonMetricsProjectMetrics = {
  args: string[];
  durationMs: number;
  exitCode: number | undefined;
  files: Record<string, PythonMetricsFileMetrics>;
  finishedAt: string;
  startedAt: string;
};

export async function runRuffCheckProject(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<PythonToolProjectResult> {
  const args = commands.createRuffCheckArgs({ files: project.files });
  const outcome = await runtime.runExecutable(
    binaries.resolvePythonCommand(),
    args,
    project.projectRoot,
    runtime.signal,
  );
  const parsedDiagnostics = parsers.parseRuffDiagnostics(outcome.stdout, project.projectRoot);

  if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
    parsedDiagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.projectRoot,
        "ruff",
        runtime.readProcessFailureMessage("Ruff", outcome.stderr, outcome.stdout, outcome.exitCode),
      ),
    );
  }

  return {
    diagnostics: parsedDiagnostics,
    durationMs: outcome.durationMs,
    toolRun: runtime.createToolRunResult(
      "ruff",
      args,
      outcome.durationMs,
      outcome.exitCode,
      outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

export async function runRuffFormatProject(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<PythonToolProjectResult> {
  const args = commands.createRuffFormatArgs({ files: project.files });
  const outcome = await runtime.runExecutable(
    binaries.resolvePythonCommand(),
    args,
    project.projectRoot,
    runtime.signal,
  );
  const parsedDiagnostics = parsers.parseRuffFormatDiagnostics(outcome.stdout, project.projectRoot);

  if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
    parsedDiagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.projectRoot,
        "ruff",
        runtime.readProcessFailureMessage(
          "Ruff format",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      ),
    );
  }

  return {
    diagnostics: parsedDiagnostics,
    durationMs: outcome.durationMs,
    toolRun: runtime.createToolRunResult(
      "ruff",
      args,
      outcome.durationMs,
      outcome.exitCode,
      outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

export async function runTyCheckProject(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<PythonToolProjectResult> {
  const tyExecution = await resolveTyExecution(runtime);
  const pythonCommand = await runtime.resolveRequiredBinary(
    [binaries.resolvePythonCommand()],
    "python3",
    "Install Python 3 to run Python typecheck.",
  );
  const args = [
    ...tyExecution.argsPrefix,
    ...commands.createTyCheckArgs({
      files: project.files,
      pythonPath: pythonCommand,
    }),
  ];
  const outcome = await runtime.runExecutable(
    tyExecution.command,
    args,
    project.projectRoot,
    runtime.signal,
  );
  const parsedDiagnostics = parsers.parseTyGitlabDiagnostics(outcome.stdout, project.projectRoot);

  if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
    parsedDiagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.projectRoot,
        "ty",
        runtime.readProcessFailureMessage("ty", outcome.stderr, outcome.stdout, outcome.exitCode),
      ),
    );
  }

  return {
    diagnostics: parsedDiagnostics,
    durationMs: outcome.durationMs,
    toolRun: runtime.createToolRunResult(
      "ty",
      args,
      outcome.durationMs,
      outcome.exitCode,
      outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed",
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

export async function executePytestProjectTask(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
  mode: "coverage" | "unit",
  stageTempDir: string,
  projectIndex: number,
): Promise<PythonProjectExecution> {
  const tempDir = await preparePythonProjectTempDir(stageTempDir, projectIndex, mode);

  const junitPath = path.join(tempDir, "junit.xml");
  const coveragePath = path.join(tempDir, "coverage.json");
  const args = commands.createPythonTestArgs({ coveragePath, junitPath, mode });
  const outcome = await runtime.runExecutable(
    binaries.resolvePythonCommand(),
    args,
    project.projectRoot,
    runtime.signal,
    {
      PYTEST_DISABLE_PLUGIN_AUTOLOAD: "1",
      ...(mode === "coverage"
        ? {
            COVERAGE_FILE: path.join(tempDir, ".coverage"),
          }
        : {}),
    },
  );
  const reportXml = await readOptionalTextFile(junitPath);
  const report = parsers.parsePytestReport(reportXml, project.projectRoot);
  const coverageSummary = mode === "coverage" ? await readJsonFile(coveragePath) : undefined;
  const status =
    (outcome.exitCode === 0 || outcome.exitCode === 5) && report.diagnostics.length === 0
      ? "passed"
      : "failed";

  if (status === "failed" && report.diagnostics.length === 0) {
    report.diagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.files[0] ?? project.projectRoot,
        mode === "coverage" ? "pytest-cov" : "pytest",
        runtime.readProcessFailureMessage(
          "pytest",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      ),
    );
  }

  return {
    coverageSummary,
    coverageSummaryError:
      mode === "coverage" &&
      outcome.exitCode === 0 &&
      readCoverageMetric(coverageSummary, "totals", "percent_covered") === undefined
        ? `Expected coverage summary at "${coveragePath}" for pytest coverage with total line coverage.`
        : undefined,
    diagnostics: report.diagnostics,
    summary: report.summary,
    toolRun: runtime.createToolRunResult(
      mode === "coverage" ? "pytest-cov" : "pytest",
      args,
      outcome.durationMs,
      outcome.exitCode,
      status,
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

async function preparePythonProjectTempDir(
  stageTempDir: string,
  projectIndex: number,
  mode: "coverage" | "unit",
): Promise<string> {
  const tempDir = path.join(stageTempDir, `project-${projectIndex}-${mode}`);
  await rm(tempDir, { force: true, recursive: true });
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}

export async function getPythonMetricsProjectMetrics(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<{ cacheHit: boolean; metrics: PythonMetricsProjectMetrics }> {
  const manifestKey = createPythonMetricsManifestKey(project);
  const cacheKey = await createPythonMetricsCacheKey(project, manifestKey);
  const cached = await runtime.getCachedValue("metrics:python", manifestKey, cacheKey, () =>
    runPythonMetricsProjectTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    metrics: cached.value,
  };
}

async function resolveTyExecution(runtime: PythonRunnerRuntime): Promise<ResolvedTyExecution> {
  const tyCommand = await runtime.resolveBinaryIfAvailable([binaries.resolveTyCommand()]);
  if (tyCommand !== undefined) {
    return { argsPrefix: [], command: tyCommand };
  }

  const uvCommand = await runtime.resolveBinaryIfAvailable([binaries.resolveUvCommand()]);
  if (uvCommand !== undefined) {
    const argsPrefix = ["tool", "run", "ty"];
    const outcome = await runtime.runExecutable(
      uvCommand,
      [...argsPrefix, "--version"],
      runtime.cwd,
      runtime.signal,
    );
    if (outcome.exitCode === 0) {
      return { argsPrefix, command: uvCommand };
    }
  }

  throw new Error("ty was not detected. Install Astral ty to run Python typecheck.");
}

function createPythonMetricsManifestKey(project: PythonProject): string {
  return `${project.projectRoot}:${[...project.files].sort().join("|")}`;
}

async function createPythonMetricsCacheKey(
  project: PythonProject,
  manifestKey = createPythonMetricsManifestKey(project),
): Promise<string> {
  const fileEntries = await Promise.all(
    [...project.files]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileStats = await stat(file);
        return `${file}@${fileStats.size}:${fileStats.mtimeMs}`;
      }),
  );

  return `${manifestKey}:${fileEntries.join("|")}`;
}

async function runPythonMetricsProjectTask(
  project: PythonProject,
  runtime: PythonRunnerRuntime,
): Promise<PythonMetricsProjectMetrics> {
  const script = [
    "import json, math, pathlib, re, sys",
    "from radon.complexity import cc_rank, cc_visit",
    "from radon.metrics import h_visit, mi_rank, mi_visit",
    "from radon.raw import analyze",
    "files = [str(pathlib.Path(value).resolve()) for value in sys.argv[1:]]",
    "result = {}",
    "for file_path in files:",
    "    source = pathlib.Path(file_path).read_text(encoding='utf8')",
    "    raw = analyze(source)",
    "    blocks = cc_visit(source)",
    "    mi_score = float(mi_visit(source, True))",
    "    halstead = h_visit(source).total",
    "    complexities = [block.complexity for block in blocks]",
    "    avg_cc = sum(complexities) / len(complexities) if complexities else 0",
    "    comment_ratio = raw.comments / raw.sloc if raw.sloc else 0",
    "    long_names = len([name for name in re.findall(r'\\b[_a-zA-Z]\\w*\\b', source) if len(name) > 20])",
    "    vague_names = len(re.findall(r'\\b(data|info|item|obj|temp|tmp|val|var|thing|stuff|helper|util|manager|handler|service|processor|controller)\\b', source, re.IGNORECASE))",
    "    redundant_prefixes = len(re.findall(r'\\b(current_|new_|old_|temp_|tmp_|get_|set_|do_|make_|create_|build_)\\w+\\b', source))",
    "    vocabulary_density = (halstead.h1 + halstead.h2) / max(raw.sloc, 1)",
    "    readability_score = (",
    "        100",
    "        - 1.5 * math.log10(max(halstead.volume, 1))",
    "        - 1.2 * halstead.difficulty",
    "        - 0.6 * avg_cc",
    "        - 0.05 * raw.sloc",
    "        - 30 * max(comment_ratio - 0.25, 0)",
    "        - 2 * long_names",
    "        - 3 * vague_names",
    "        - 2 * redundant_prefixes",
    "        - 10 * max(vocabulary_density - 2, 0)",
    "    )",
    "    result[file_path] = {",
    "        'raw': {",
    "            'blank': raw.blank,",
    "            'comments': raw.comments,",
    "            'lloc': raw.lloc,",
    "            'loc': raw.loc,",
    "            'multi': raw.multi,",
    "            'singleComments': raw.single_comments,",
    "            'sloc': raw.sloc,",
    "        },",
    "        'cc': [",
    "            {",
    "                'complexity': block.complexity,",
    "                'endline': block.endline,",
    "                'lineno': block.lineno,",
    "                'name': block.name,",
    "                'rank': cc_rank(block.complexity),",
    "                'type': block.__class__.__name__,",
    "            }",
    "            for block in blocks",
    "        ],",
    "        'mi': {",
    "            'rank': mi_rank(mi_score),",
    "            'score': mi_score,",
    "        },",
    "        'readability': {",
    "            'score': readability_score,",
    "        },",
    "    }",
    "print(json.dumps(result))",
  ].join("\n");
  const args = ["-c", script, ...project.files];
  const outcome = await runtime.runExecutable(
    binaries.resolvePythonCommand(),
    args,
    project.projectRoot,
    runtime.signal,
  );

  if (outcome.exitCode !== 0) {
    throw new Error(
      runtime.readProcessFailureMessage("radon", outcome.stderr, outcome.stdout, outcome.exitCode),
    );
  }

  return {
    args,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    files: parsePythonMetricsReport(outcome.stdout),
    finishedAt: outcome.finishedAt,
    startedAt: outcome.startedAt,
  };
}

function parsePythonMetricsReport(report: string): Record<string, PythonMetricsFileMetrics> {
  try {
    return parsers.parsePythonMetrics(report);
  } catch (error) {
    throw new Error(
      `Failed to parse Python metrics output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readCoverageMetric(
  summary: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (summary === undefined) {
    return undefined;
  }

  const value = parsers.readNestedValue(summary, keys);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function readJsonValue(filePath: string): Promise<unknown> {
  if (!(await pathExists(filePath))) {
    return undefined;
  }

  const contents = await readFile(filePath, "utf8");

  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(
      `Failed to parse JSON file "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  const parsed = await readJsonValue(filePath);
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  return parsed as Record<string, unknown>;
}

async function readOptionalTextFile(filePath: string | undefined): Promise<string | undefined> {
  if (filePath === undefined || !(await pathExists(filePath))) {
    return undefined;
  }

  return readFile(filePath, "utf8");
}
