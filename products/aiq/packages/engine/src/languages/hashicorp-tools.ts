import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic, StageResult, ToolRunResult } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import type { HashicorpRunnerRuntime } from "./contracts.js";
import type { HashicorpProject } from "./hashicorp.js";
import {
  createTerraformValidationCacheKey,
  createTerraformValidationManifestKey,
  joinOutputs,
  normalizeDiagnosticsToSelection,
  readProjectLabel,
  resolveTerraformValidationFiles,
  runTerraformProjectValidateTask,
  writeGenericHclTerraformFile,
} from "./hashicorp-validation.js";

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
