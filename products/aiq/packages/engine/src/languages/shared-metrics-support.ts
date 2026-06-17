import type { Diagnostic, StageId } from "../contracts.js";

type CreateProcessFailureDiagnostic = (file: string, source: string, message: string) => Diagnostic;

export function createUnsupportedSharedMetricsDiagnostics(
  files: readonly string[],
  stageId: StageId,
  languageLabel: string,
  supportedFileDescription: string,
  createProcessFailureDiagnostic: CreateProcessFailureDiagnostic,
): Diagnostic[] {
  return [...files]
    .sort((left, right) => left.localeCompare(right))
    .map((file) =>
      createProcessFailureDiagnostic(
        file,
        "aiq-shared-metrics",
        `Stage '${stageId}' shared metrics do not support this selected file in the ${languageLabel} metrics runner. Select ${supportedFileDescription}, configure another supported metrics language, or remove this file from the ${stageId} stage selection.`,
      ),
    );
}

export function readUnsupportedSharedMetricsNotes(
  files: readonly string[],
  stageId: StageId,
  languageLabel: string,
): string[] {
  if (files.length === 0) {
    return [];
  }

  const sortedFiles = [...files].sort((left, right) => left.localeCompare(right));
  return [
    `Unsupported shared metrics files for ${stageId} in the ${languageLabel} metrics runner: ${sortedFiles.join(", ")}.`,
  ];
}
