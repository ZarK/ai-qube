import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import type { HashicorpRunnerRuntime } from "./contracts.js";
import type { HashicorpProject } from "./hashicorp.js";

export type TerraformValidationProjectResult = {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRuns: ToolRunResult[];
};

export type HashicorpProjectToolResult = {
  diagnostics: Diagnostic[];
  durationMs: number;
  note: string;
  status: StageResult["status"];
  toolRun: ToolRunResult;
};

export async function getTerraformValidationProjectResult(
  project: HashicorpProject,
  runtime: HashicorpRunnerRuntime,
): Promise<{ cacheHit: boolean; result: TerraformValidationProjectResult }> {
  const validationFiles = await resolveTerraformValidationFiles(project.projectRoot);
  const manifestKey = createTerraformValidationManifestKey(project.projectRoot, validationFiles);
  const cacheKey = await createTerraformValidationCacheKey(validationFiles, manifestKey);
  const cached = await runtime.getCachedValue("terraform:validate", manifestKey, cacheKey, () =>
    runTerraformProjectValidateTask(project, runtime),
  );

  return {
    cacheHit: cached.cacheHit,
    result: cached.value,
  };
}

export async function runGenericHclFormatFile(
  file: string,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<HashicorpProjectToolResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-hcl-format-"));

  try {
    const tempFile = await writeGenericHclTerraformFile(file, tempDir);
    const args = ["fmt", "-check", path.basename(tempFile)];
    const outcome = await runtime.runExecutable(terraformBinary, args, tempDir, runtime.signal);
    const diagnostics: Diagnostic[] = [];

    if (outcome.exitCode === 3) {
      diagnostics.push({
        file,
        message: "File requires formatting.",
        severity: "error",
        source: "terraform-hcl-format",
      });
    } else if (outcome.exitCode !== 0) {
      diagnostics.push(
        ...parsers.parseTerraformSyntaxDiagnostics(
          joinOutputs(outcome.stderr, outcome.stdout),
          file,
          "terraform-hcl-format",
        ),
      );
    }

    if (outcome.exitCode !== 0 && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          file,
          "terraform-hcl-format",
          runtime.readProcessFailureMessage(
            "terraform fmt",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      note:
        status === "passed"
          ? `Generic HCL format passed for ${path.basename(file)}.`
          : `Generic HCL format reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} for ${path.basename(file)}.`,
      status,
      toolRun: runtime.createToolRunResult(
        "terraform-hcl-format",
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runGenericHclLintFile(
  file: string,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<HashicorpProjectToolResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-hcl-lint-"));

  try {
    const tempFile = await writeGenericHclTerraformFile(file, tempDir);
    const args = ["fmt", path.basename(tempFile)];
    const outcome = await runtime.runExecutable(terraformBinary, args, tempDir, runtime.signal);
    const diagnostics =
      outcome.exitCode === 0
        ? []
        : parsers.parseTerraformSyntaxDiagnostics(
            joinOutputs(outcome.stderr, outcome.stdout),
            file,
            "terraform-hcl-lint",
          );

    if (outcome.exitCode !== 0 && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          file,
          "terraform-hcl-lint",
          runtime.readProcessFailureMessage(
            "terraform fmt",
            outcome.stderr,
            outcome.stdout,
            outcome.exitCode,
          ),
        ),
      );
    }

    const status = outcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";

    return {
      diagnostics,
      durationMs: outcome.durationMs,
      note:
        status === "passed"
          ? `Generic HCL syntax check passed for ${path.basename(file)}.`
          : `Generic HCL syntax check reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} for ${path.basename(file)}.`,
      status,
      toolRun: runtime.createToolRunResult(
        "terraform-hcl-lint",
        args,
        outcome.durationMs,
        outcome.exitCode,
        status,
        outcome.finishedAt,
        outcome.startedAt,
      ),
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

export async function runTerraformFormatProject(
  project: HashicorpProject,
  terraformBinary: string,
  runtime: HashicorpRunnerRuntime,
): Promise<HashicorpProjectToolResult> {
  const args = commands.createTerraformFmtArgs({
    files: project.terraformFiles.map((file) => path.relative(project.projectRoot, file)),
  });
  const outcome = await runtime.runExecutable(
    terraformBinary,
    args,
    project.projectRoot,
    runtime.signal,
  );
  const parsedDiagnostics = normalizeDiagnosticsToSelection(
    parsers.parseTerraformFormatDiagnostics(outcome.stdout, project.projectRoot),
    project.terraformFiles,
  );

  if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
    parsedDiagnostics.push(
      ...parsers.parseTerraformSyntaxDiagnostics(
        joinOutputs(outcome.stderr, outcome.stdout),
        project.terraformFiles[0] ?? project.projectRoot,
        "terraform-fmt",
      ),
    );
  }

  if (outcome.exitCode !== 0 && parsedDiagnostics.length === 0) {
    parsedDiagnostics.push(
      runtime.createProcessFailureDiagnostic(
        project.terraformFiles[0] ?? project.projectRoot,
        "terraform-fmt",
        runtime.readProcessFailureMessage(
          "terraform fmt",
          outcome.stderr,
          outcome.stdout,
          outcome.exitCode,
        ),
      ),
    );
  }

  const status = outcome.exitCode === 0 && parsedDiagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics: parsedDiagnostics,
    durationMs: outcome.durationMs,
    note:
      status === "passed"
        ? `terraform fmt passed for ${readProjectLabel(project.projectRoot)}.`
        : `terraform fmt reported ${parsedDiagnostics.length} formatting diagnostic${parsedDiagnostics.length === 1 ? "" : "s"} for ${readProjectLabel(project.projectRoot)}.`,
    status,
    toolRun: runtime.createToolRunResult(
      "terraform-fmt",
      args,
      outcome.durationMs,
      outcome.exitCode,
      status,
      outcome.finishedAt,
      outcome.startedAt,
    ),
  };
}

async function runTerraformProjectValidateTask(
  project: HashicorpProject,
  runtime: HashicorpRunnerRuntime,
): Promise<TerraformValidationProjectResult> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aiq-terraform-validate-"));

  try {
    const tempProjectRoot = path.join(tempDir, "project");
    await cp(project.projectRoot, tempProjectRoot, { recursive: true });

    const terraformBinary = await runtime.resolveRequiredBinary(
      ["terraform"],
      "Terraform",
      "Install 'terraform' to enable Terraform validation.",
    );
    const env = {
      CHECKPOINT_DISABLE: "1",
      TF_DATA_DIR: path.join(tempDir, ".terraform-data"),
      TF_IN_AUTOMATION: "1",
    };
    const initArgs = commands.createTerraformInitArgs({ disableBackend: true, disableInput: true });
    const initOutcome = await runtime.runExecutable(
      terraformBinary,
      initArgs,
      tempProjectRoot,
      runtime.signal,
      env,
    );
    const initStatus = initOutcome.exitCode === 0 ? "passed" : "failed";
    const toolRuns = [
      runtime.createToolRunResult(
        "terraform-init",
        initArgs,
        initOutcome.durationMs,
        initOutcome.exitCode,
        initStatus,
        initOutcome.finishedAt,
        initOutcome.startedAt,
      ),
    ];

    if (initOutcome.exitCode !== 0) {
      return {
        diagnostics: [
          runtime.createProcessFailureDiagnostic(
            project.terraformFiles[0] ?? project.projectRoot,
            "terraform-init",
            runtime.readProcessFailureMessage(
              "terraform init",
              initOutcome.stderr,
              initOutcome.stdout,
              initOutcome.exitCode,
            ),
          ),
        ],
        durationMs: initOutcome.durationMs,
        note: `terraform init failed for ${readProjectLabel(project.projectRoot)}.`,
        status: "failed",
        toolRuns,
      };
    }

    const validateArgs = commands.createTerraformValidateArgs();
    const validateOutcome = await runtime.runExecutable(
      terraformBinary,
      validateArgs,
      tempProjectRoot,
      runtime.signal,
      env,
    );
    const diagnostics = normalizeDiagnosticsToSelection(
      parsers.parseTerraformValidateDiagnostics(
        validateOutcome.stdout,
        project.projectRoot,
        project.terraformFiles[0] ?? project.projectRoot,
      ),
      project.terraformFiles,
    );

    if (validateOutcome.exitCode !== 0 && diagnostics.length === 0) {
      diagnostics.push(
        runtime.createProcessFailureDiagnostic(
          project.terraformFiles[0] ?? project.projectRoot,
          "terraform-validate",
          runtime.readProcessFailureMessage(
            "terraform validate",
            validateOutcome.stderr,
            validateOutcome.stdout,
            validateOutcome.exitCode,
          ),
        ),
      );
    }

    const status = validateOutcome.exitCode === 0 && diagnostics.length === 0 ? "passed" : "failed";
    toolRuns.push(
      runtime.createToolRunResult(
        "terraform-validate",
        validateArgs,
        validateOutcome.durationMs,
        validateOutcome.exitCode,
        status,
        validateOutcome.finishedAt,
        validateOutcome.startedAt,
      ),
    );

    return {
      diagnostics: deduplicateDiagnostics(diagnostics),
      durationMs: initOutcome.durationMs + validateOutcome.durationMs,
      note:
        status === "passed"
          ? `terraform validate passed for ${readProjectLabel(project.projectRoot)}.`
          : `terraform validate reported ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"} for ${readProjectLabel(project.projectRoot)}.`,
      status,
      toolRuns,
    };
  } finally {
    await rm(tempDir, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function resolveTerraformValidationFiles(projectRoot: string): Promise<string[]> {
  const matches = await findMatchingFiles(projectRoot, (filePath) =>
    isTerraformValidationInputFile(path.basename(filePath)),
  );

  return matches.sort((left, right) => left.localeCompare(right));
}

function isTerraformValidationInputFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();

  return (
    lowerName === ".terraform.lock.hcl" ||
    lowerName.endsWith(".tf.json") ||
    lowerName.endsWith(".tfvars.json") ||
    lowerName.endsWith(".tf") ||
    lowerName.endsWith(".tfvars")
  );
}

function createTerraformValidationManifestKey(
  projectRoot: string,
  validationFiles: readonly string[],
): string {
  return `${projectRoot}:${[...validationFiles].sort().join("|")}`;
}

async function createTerraformValidationCacheKey(
  validationFiles: readonly string[],
  manifestKey: string,
): Promise<string> {
  const fileEntries = await Promise.all(
    [...validationFiles]
      .sort((left, right) => left.localeCompare(right))
      .map(async (file) => {
        const fileContent = await readFile(file);
        const fileDigest = createHash("sha256").update(fileContent).digest("hex");
        return `${file}@${fileDigest}`;
      }),
  );

  return `${manifestKey}:${fileEntries.join("|")}`;
}

function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const uniqueDiagnostics: Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.source,
      diagnostic.code ?? "",
      diagnostic.file,
      diagnostic.range?.startLine ?? "",
      diagnostic.range?.startColumn ?? "",
      diagnostic.message,
    ].join("|");
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    uniqueDiagnostics.push(diagnostic);
  }

  return uniqueDiagnostics;
}

function joinOutputs(...values: string[]): string {
  return values.filter((value) => value.length > 0).join("\n");
}

function matchDiagnosticFile(
  file: string,
  selectedPaths: ReadonlyArray<{ file: string; normalized: string; realPath: string | undefined }>,
): string | undefined {
  const normalized = path.normalize(file);
  const directMatch = selectedPaths.find((entry) => entry.normalized === normalized);
  if (directMatch !== undefined) {
    return directMatch.file;
  }

  const realPath = tryRealpath(file);
  if (realPath === undefined) {
    return undefined;
  }

  return selectedPaths.find((entry) => entry.realPath === realPath)?.file;
}

function normalizeDiagnosticsToSelection(
  diagnostics: readonly Diagnostic[],
  selectedFiles: readonly string[],
): Diagnostic[] {
  if (diagnostics.length === 0 || selectedFiles.length === 0) {
    return [...diagnostics];
  }

  const selectedPaths = selectedFiles.map((file) => ({
    file,
    normalized: path.normalize(file),
    realPath: tryRealpath(file),
  }));

  return diagnostics.map((diagnostic) => {
    const matchedFile = matchDiagnosticFile(diagnostic.file, selectedPaths);
    if (matchedFile === undefined || matchedFile === diagnostic.file) {
      return diagnostic;
    }

    return {
      ...diagnostic,
      file: matchedFile,
    };
  });
}

function readProjectLabel(projectRoot: string): string {
  const baseName = path.basename(projectRoot);
  return baseName.length > 0 ? baseName : projectRoot;
}

function tryRealpath(filePath: string): string | undefined {
  try {
    return realpathSync.native(filePath);
  } catch {
    return undefined;
  }
}

async function findMatchingFiles(
  directory: string,
  predicate: (filePath: string) => boolean,
): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const matches: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (shouldSkipTerraformValidationDirectory(entryPath)) {
        continue;
      }

      matches.push(...(await findMatchingFiles(entryPath, predicate)));
      continue;
    }

    if (entry.isFile() && predicate(entryPath)) {
      matches.push(entryPath);
    }
  }

  return matches;
}

function shouldSkipTerraformValidationDirectory(directoryPath: string): boolean {
  return [".git", ".hg", ".svn", ".terraform", "node_modules"].includes(
    path.basename(directoryPath).toLowerCase(),
  );
}

async function writeGenericHclTerraformFile(file: string, directory: string): Promise<string> {
  const tempFile = path.join(
    directory,
    `${path.basename(file, path.extname(file)) || "config"}.tf`,
  );
  await writeFile(tempFile, await readFile(file, "utf8"), "utf8");
  return tempFile;
}
