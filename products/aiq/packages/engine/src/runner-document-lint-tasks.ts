import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { Parser as SqlParserClass } from "node-sql-parser";
import stylelint from "stylelint";
import { parseAllDocuments } from "yaml";

import type { PlannedTask, StageResult } from "./contracts.js";
import * as parsers from "./parsers/index.js";
import {
  cssExtensions,
  htmlExtensions,
  sqlExtensions,
  yamlExtensions,
} from "./runner-file-rules.js";
import {
  createExecutionFailureStage,
  createNoopStageResult,
  createToolRunResult,
} from "./runner-results.js";
import {
  createMissingStylelintConfigDiagnostics,
  createMissingStylelintConfigNote,
  deduplicateDiagnostics,
  isMissingStylelintConfigError,
  normalizeDiagnosticsToSelection,
  parseStylelintDiagnostics,
} from "./runner-shared-task-utils.js";
import { filterFiles, measureOperation } from "./runner-toolbox.js";

type HtmlHintIssue = {
  col: number;
  line: number;
  message: string;
  rule?: { id?: string };
  type?: string;
};

type HtmlHintModule = {
  HTMLHint: {
    defaultRuleset: Record<string, unknown>;
    verify: (html: string, ruleset?: Record<string, unknown>) => HtmlHintIssue[];
  };
};

type SqlParserModule = {
  Parser: typeof SqlParserClass;
};

const require = createRequire(import.meta.url);
const { HTMLHint } = require("htmlhint") as HtmlHintModule;
const { Parser: SqlParser } = require("node-sql-parser") as SqlParserModule;

export async function runHtmlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, htmlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No HTML files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              return HTMLHint.verify(source, HTMLHint.defaultRuleset).map((issue) =>
                parsers.createHtmlHintDiagnostic(file, issue),
              );
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["HTMLHint passed."]
          : [
              `HTMLHint reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "htmlhint",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "htmlhint", files[0] ?? cwd, error);
  }
}

export async function runCssLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, cssExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No CSS files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const missingConfigFiles: string[] = [];
      const rawDiagnostics = (
        await Promise.all(
          files.map(async (file) => {
            const source = await readFile(file, "utf8");
            let resolvedConfig: Awaited<ReturnType<typeof stylelint.resolveConfig>>;

            try {
              resolvedConfig = await stylelint.resolveConfig(file, { cwd });
            } catch (error) {
              if (isMissingStylelintConfigError(error)) {
                missingConfigFiles.push(file);
                return [];
              }

              throw error;
            }

            if (resolvedConfig === null || resolvedConfig === undefined) {
              missingConfigFiles.push(file);
              return [];
            }

            const result = await stylelint.lint({
              code: source,
              codeFilename: file,
              config: resolvedConfig,
              cwd,
              formatter: "json",
            });
            return parseStylelintDiagnostics(result.report, cwd);
          }),
        )
      ).flat();
      const diagnostics = normalizeDiagnosticsToSelection(
        deduplicateDiagnostics([
          ...rawDiagnostics,
          ...createMissingStylelintConfigDiagnostics(task.stageId, missingConfigFiles),
        ]),
        files,
      );
      const status: StageResult["status"] = diagnostics.length > 0 ? "failed" : "passed";
      return {
        diagnostics,
        missingConfigFiles,
        status,
      };
    });

    const notes =
      timed.result.status === "passed"
        ? ["Stylelint passed."]
        : timed.result.status === "failed"
          ? [
              `Stylelint reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
              ...(timed.result.missingConfigFiles.length === 0
                ? []
                : [
                    createMissingStylelintConfigNote(task.stageId, timed.result.missingConfigFiles),
                  ]),
            ]
          : [createMissingStylelintConfigNote(task.stageId, timed.result.missingConfigFiles)];

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes,
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "stylelint",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "stylelint", files[0] ?? cwd, error);
  }
}

export async function runYamlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, yamlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No YAML files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              return parseAllDocuments(source).flatMap((document) => [
                ...document.errors.map((error) =>
                  parsers.createYamlDiagnostic(file, error.message, error.linePos, "error"),
                ),
                ...document.warnings.map((warning) =>
                  parsers.createYamlDiagnostic(file, warning.message, warning.linePos, "warning"),
                ),
              ]);
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["YAML parse checks passed."]
          : [
              `YAML parse checks reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "yaml",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "yaml", files[0] ?? cwd, error);
  }
}

export async function runSqlLintTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, sqlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No SQL files were selected for lint.");
  }

  try {
    const timed = await measureOperation(async () => {
      const parser = new SqlParser();
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              const dialectResult = parsers.resolveSqlDialect(
                parser,
                source,
                "node-sql-parser",
                file,
              );
              return "diagnostic" in dialectResult ? [dialectResult.diagnostic] : [];
            }),
          )
        ).flat(),
      );
      const status: StageResult["status"] = diagnostics.length === 0 ? "passed" : "failed";
      return {
        diagnostics,
        status,
      };
    });

    return {
      diagnostics: timed.result.diagnostics,
      durationMs: timed.durationMs,
      notes:
        timed.result.status === "passed"
          ? ["SQL parse checks passed."]
          : [
              `SQL parse checks reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "node-sql-parser",
          files,
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "node-sql-parser", files[0] ?? cwd, error);
  }
}
