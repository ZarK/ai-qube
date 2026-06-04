import type { Diagnostic } from "./contracts.js";
import type { LizardMetricsFileMetrics } from "./parsers/lizard.js";
import type { PythonMetricsFileMetrics } from "./parsers/python.js";

export type SharedMetricsMode = "sloc" | "complexity" | "maintainability";

export const metricsDiagnosticCodes = {
  lizardComplexity: "metrics/complexity-limit",
  lizardMaintainabilityComplexity: "metrics/maintainability-complexity-limit",
  lizardMaintainabilityFunctionNloc: "metrics/function-nloc-limit",
  lizardMaintainabilityParameterCount: "metrics/parameter-count-limit",
  pythonComplexity: "metrics/python-complexity-rank",
  pythonMaintainability: "metrics/python-maintainability-limit",
  pythonReadability: "metrics/python-readability-limit",
  sloc: "metrics/sloc-limit",
} as const;

export interface MetricsThresholds {
  lizardComplexityLimit: number;
  lizardMaintainabilityComplexityLimit: number;
  lizardMaintainabilityFunctionNlocLimit: number;
  lizardMaintainabilityParameterLimit: number;
  pythonMaintainabilityLimit: number;
  pythonReadabilityLimit: number;
  slocLimit: number;
}

export const defaultMetricsThresholds: MetricsThresholds = {
  lizardComplexityLimit: 12,
  lizardMaintainabilityComplexityLimit: 10,
  lizardMaintainabilityFunctionNlocLimit: 200,
  lizardMaintainabilityParameterLimit: 6,
  pythonMaintainabilityLimit: 40,
  pythonReadabilityLimit: 85,
  slocLimit: 350,
};

export function readMetricsThresholds(env = process.env): MetricsThresholds {
  return {
    lizardComplexityLimit: readPositiveInteger(
      env.LIZARD_CCN_LIMIT,
      defaultMetricsThresholds.lizardComplexityLimit,
    ),
    lizardMaintainabilityComplexityLimit: readPositiveInteger(
      env.LIZARD_CCN_STRICT,
      defaultMetricsThresholds.lizardMaintainabilityComplexityLimit,
    ),
    lizardMaintainabilityFunctionNlocLimit: readPositiveInteger(
      env.LIZARD_FN_NLOC_LIMIT,
      defaultMetricsThresholds.lizardMaintainabilityFunctionNlocLimit,
    ),
    lizardMaintainabilityParameterLimit: readPositiveInteger(
      env.LIZARD_PARAM_LIMIT,
      defaultMetricsThresholds.lizardMaintainabilityParameterLimit,
    ),
    pythonMaintainabilityLimit: readPositiveInteger(
      env.AIQ_PYTHON_MI_LIMIT,
      defaultMetricsThresholds.pythonMaintainabilityLimit,
    ),
    pythonReadabilityLimit: readPositiveInteger(
      env.AIQ_PYTHON_READABILITY_LIMIT,
      defaultMetricsThresholds.pythonReadabilityLimit,
    ),
    slocLimit: readPositiveInteger(
      env.AIQ_SLOC_LIMIT ?? env.LIZARD_SLOC_LIMIT,
      defaultMetricsThresholds.slocLimit,
    ),
  };
}

export function createLizardMetricsDiagnostics(
  files: Record<string, LizardMetricsFileMetrics>,
  mode: SharedMetricsMode,
  source: string,
  thresholds = readMetricsThresholds(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [file, fileMetrics] of Object.entries(files)) {
    if (mode === "sloc" && fileMetrics.raw.sloc >= thresholds.slocLimit) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `SLOC ${fileMetrics.raw.sloc} is greater than or equal to ${thresholds.slocLimit}.`,
          metricsDiagnosticCodes.sloc,
        ),
      );
      continue;
    }

    for (const block of fileMetrics.blocks) {
      if (mode === "complexity" && block.complexity > thresholds.lizardComplexityLimit) {
        diagnostics.push(
          createMetricDiagnostic(
            file,
            source,
            `${block.name} complexity ${block.complexity} is greater than ${thresholds.lizardComplexityLimit}.`,
            metricsDiagnosticCodes.lizardComplexity,
            block.startLine,
          ),
        );
      }

      if (mode !== "maintainability") {
        continue;
      }

      if (block.complexity > thresholds.lizardMaintainabilityComplexityLimit) {
        diagnostics.push(
          createMetricDiagnostic(
            file,
            source,
            `${block.name} maintainability complexity ${block.complexity} is greater than ${thresholds.lizardMaintainabilityComplexityLimit}.`,
            metricsDiagnosticCodes.lizardMaintainabilityComplexity,
            block.startLine,
          ),
        );
      }

      if (block.nloc > thresholds.lizardMaintainabilityFunctionNlocLimit) {
        diagnostics.push(
          createMetricDiagnostic(
            file,
            source,
            `${block.name} function NLOC ${block.nloc} is greater than ${thresholds.lizardMaintainabilityFunctionNlocLimit}.`,
            metricsDiagnosticCodes.lizardMaintainabilityFunctionNloc,
            block.startLine,
          ),
        );
      }

      if (block.parameterCount > thresholds.lizardMaintainabilityParameterLimit) {
        diagnostics.push(
          createMetricDiagnostic(
            file,
            source,
            `${block.name} parameter count ${block.parameterCount} is greater than ${thresholds.lizardMaintainabilityParameterLimit}.`,
            metricsDiagnosticCodes.lizardMaintainabilityParameterCount,
            block.startLine,
          ),
        );
      }
    }
  }

  return diagnostics;
}

export function createPythonMetricsDiagnostics(
  files: Record<string, PythonMetricsFileMetrics>,
  mode: SharedMetricsMode,
  source: string,
  thresholds = readMetricsThresholds(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [file, fileMetrics] of Object.entries(files)) {
    if (mode === "sloc" && fileMetrics.raw.sloc >= thresholds.slocLimit) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `SLOC ${fileMetrics.raw.sloc} is greater than or equal to ${thresholds.slocLimit}.`,
          metricsDiagnosticCodes.sloc,
        ),
      );
      continue;
    }

    if (mode === "complexity") {
      for (const block of fileMetrics.cc) {
        if (["C", "D", "E", "F"].includes(block.rank)) {
          diagnostics.push(
            createMetricDiagnostic(
              file,
              source,
              `${block.name} complexity rank ${block.rank} is not allowed; only A/B complexity ranks pass.`,
              metricsDiagnosticCodes.pythonComplexity,
              block.lineno,
            ),
          );
        }
      }
      continue;
    }

    if (
      mode === "maintainability" &&
      fileMetrics.mi.score < thresholds.pythonMaintainabilityLimit
    ) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `Maintainability index ${fileMetrics.mi.score.toFixed(1)} is less than ${thresholds.pythonMaintainabilityLimit}.`,
          metricsDiagnosticCodes.pythonMaintainability,
        ),
      );
    }

    if (
      mode === "maintainability" &&
      fileMetrics.readability !== undefined &&
      fileMetrics.readability.score < thresholds.pythonReadabilityLimit
    ) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `Readability index ${fileMetrics.readability.score.toFixed(1)} is less than ${thresholds.pythonReadabilityLimit}.`,
          metricsDiagnosticCodes.pythonReadability,
        ),
      );
    }
  }

  return diagnostics;
}

export function createFileMetricDiagnostics(
  files: Record<
    string,
    { maintainability: { score: number }; maxComplexity: { score: number }; raw: { sloc: number } }
  >,
  mode: SharedMetricsMode,
  source: string,
  thresholds = readMetricsThresholds(),
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const [file, fileMetrics] of Object.entries(files)) {
    if (mode === "sloc" && fileMetrics.raw.sloc >= thresholds.slocLimit) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `SLOC ${fileMetrics.raw.sloc} is greater than or equal to ${thresholds.slocLimit}.`,
          metricsDiagnosticCodes.sloc,
        ),
      );
    }

    if (
      mode === "complexity" &&
      fileMetrics.maxComplexity.score > thresholds.lizardComplexityLimit
    ) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `Complexity ${fileMetrics.maxComplexity.score} is greater than ${thresholds.lizardComplexityLimit}.`,
          metricsDiagnosticCodes.lizardComplexity,
        ),
      );
    }

    if (
      mode === "maintainability" &&
      fileMetrics.maxComplexity.score > thresholds.lizardMaintainabilityComplexityLimit
    ) {
      diagnostics.push(
        createMetricDiagnostic(
          file,
          source,
          `Maintainability complexity ${fileMetrics.maxComplexity.score} is greater than ${thresholds.lizardMaintainabilityComplexityLimit}.`,
          metricsDiagnosticCodes.lizardMaintainabilityComplexity,
        ),
      );
    }
  }

  return diagnostics;
}

function createMetricDiagnostic(
  file: string,
  source: string,
  message: string,
  code: string,
  startLine = 1,
): Diagnostic {
  return {
    code,
    file,
    message,
    range: {
      startColumn: 1,
      startLine,
    },
    severity: "error",
    source,
  };
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
