import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Diagnostic } from "../contracts.js";
import * as parsers from "../parsers/index.js";
import * as commands from "../tools/command-builders.js";
import { pathExists } from "../utils/path-utils.js";
import type { HashicorpRunnerRuntime } from "./contracts.js";
import type { HashicorpProject } from "./hashicorp.js";
import type { TerraformValidationProjectResult } from "./hashicorp-tools.js";

export async function runTerraformProjectValidateTask(
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

export async function resolveTerraformValidationFiles(projectRoot: string): Promise<string[]> {
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

export function createTerraformValidationManifestKey(
  projectRoot: string,
  validationFiles: readonly string[],
): string {
  return `${projectRoot}:${[...validationFiles].sort().join("|")}`;
}

export async function createTerraformValidationCacheKey(
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

export function joinOutputs(...values: string[]): string {
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

export function normalizeDiagnosticsToSelection(
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

export function readProjectLabel(projectRoot: string): string {
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

export async function writeGenericHclTerraformFile(file: string, directory: string): Promise<string> {
  const tempFile = path.join(
    directory,
    `${path.basename(file, path.extname(file)) || "config"}.tf`,
  );
  await writeFile(tempFile, await readFile(file, "utf8"), "utf8");
  return tempFile;
}
