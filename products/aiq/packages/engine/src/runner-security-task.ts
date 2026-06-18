import { readFile } from "node:fs/promises";

import type { Diagnostic, PlannedTask, StageResult } from "./contracts.js";
import { securityExtensions } from "./runner-file-rules.js";
import { createExecutionFailureStage, createNoopStageResult, createToolRunResult } from "./runner-results.js";
import { filterFiles, throwIfAbortError } from "./runner-toolbox.js";

const sharedSecurityPatterns: Array<{ message: string; pattern: RegExp }> = [
  {
    message: "Potential GitHub token detected.",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u,
  },
  {
    message: "Potential AWS access key detected.",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  },
  {
    message: "Potential npm token detected.",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/u,
  },
  {
    message: "Private key material detected.",
    pattern: /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/u,
  },
];

export async function runSharedSecurityTask(task: PlannedTask): Promise<StageResult> {
  const files = filterFiles(task.files, securityExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      "No JavaScript, TypeScript, JSON, Bash, PowerShell, Python, HTML, CSS, YAML, SQL, Terraform, HCL, .NET, Go, Rust, or JVM files were selected for security scanning.",
    );
  }

  const startedAt = new Date();
  const diagnostics: Diagnostic[] = [];
  let currentFile = files[0] ?? task.files[0] ?? process.cwd();

  try {
    for (const file of files) {
      currentFile = file;
      diagnostics.push(...(await scanSecurityFile(file)));
    }
  } catch (error) {
    throwIfAbortError(error);
    return createExecutionFailureStage(
      task.stageId,
      "aiq-security",
      currentFile,
      error,
      Date.now() - startedAt.getTime(),
      diagnostics,
    );
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const status = diagnostics.length === 0 ? "passed" : "failed";

  return {
    diagnostics,
    durationMs,
    notes: readSharedSecurityNotes(status, diagnostics.length),
    stageId: task.stageId,
    status,
    toolRuns: [
      createToolRunResult(
        "aiq-security",
        ["scan", ...files],
        durationMs,
        status === "passed" ? 0 : 1,
        status,
        finishedAt.toISOString(),
        startedAt.toISOString(),
      ),
    ],
  };
}

async function scanSecurityFile(file: string): Promise<Diagnostic[]> {
  const source = await readFile(file, "utf8");
  return sharedSecurityPatterns.flatMap((rule) => readSecurityRuleDiagnostic(file, source, rule));
}

function readSecurityRuleDiagnostic(
  file: string,
  source: string,
  rule: { message: string; pattern: RegExp },
): Diagnostic[] {
  rule.pattern.lastIndex = 0;
  return rule.pattern.test(source)
    ? [{ file, message: rule.message, severity: "error", source: "aiq-security" }]
    : [];
}

function readSharedSecurityNotes(status: StageResult["status"], diagnosticCount: number): string[] {
  return status === "passed"
    ? ["Shared security scan passed."]
    : [`Shared security scan reported ${diagnosticCount} finding${diagnosticCount === 1 ? "" : "s"}.`];
}
