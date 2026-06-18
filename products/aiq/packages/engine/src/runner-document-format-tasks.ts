import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { Parser as SqlParserClass } from "node-sql-parser";
import * as prettier from "prettier";

import type { PlannedTask, StageResult } from "./contracts.js";
import * as parsers from "./parsers/index.js";
import { prettierDocumentExtensions, sqlExtensions } from "./runner-file-rules.js";
import {
  createExecutionFailureStage,
  createNoopStageResult,
  createToolRunResult,
} from "./runner-results.js";
import {
  createFormattingDiagnostic,
  createPrettierDiagnostic,
  deduplicateDiagnostics,
  ensureTrailingNewline,
} from "./runner-shared-task-utils.js";
import { filterFiles, measureOperation, normalizeLineEndings } from "./runner-toolbox.js";

type SqlFormatterModule = {
  format: (sql: string, options?: { language?: parsers.SqlDialect }) => string;
};

type SqlParserModule = {
  Parser: typeof SqlParserClass;
};

const require = createRequire(import.meta.url);
const { Parser: SqlParser } = require("node-sql-parser") as SqlParserModule;
const { format: formatSql } = require("sql-formatter") as SqlFormatterModule;

export async function runPrettierDocumentFormatTask(
  task: PlannedTask,
  cwd: string,
): Promise<StageResult> {
  const files = filterFiles(task.files, prettierDocumentExtensions);
  if (files.length === 0) {
    return createNoopStageResult(
      task.stageId,
      "No HTML, CSS, or YAML files were selected for format.",
    );
  }

  try {
    const timed = await measureOperation(async () => {
      const diagnostics = deduplicateDiagnostics(
        (
          await Promise.all(
            files.map(async (file) => {
              const source = await readFile(file, "utf8");
              const resolvedConfig = (await prettier.resolveConfig(file)) ?? {};

              try {
                const isFormatted = await prettier.check(source, {
                  ...resolvedConfig,
                  filepath: file,
                });
                return isFormatted ? [] : [createFormattingDiagnostic(file, "prettier")];
              } catch (error) {
                return [createPrettierDiagnostic(file, error)];
              }
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
          ? ["Prettier document format checks passed."]
          : [
              `Prettier reported ${timed.result.diagnostics.length} formatting diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "prettier",
          ["--check", ...files],
          timed.durationMs,
          timed.result.status === "passed" ? 0 : 1,
          timed.result.status,
          timed.finishedAt,
          timed.startedAt,
        ),
      ],
    };
  } catch (error) {
    return createExecutionFailureStage(task.stageId, "prettier", files[0] ?? cwd, error);
  }
}

export async function runSqlFormatTask(task: PlannedTask, cwd: string): Promise<StageResult> {
  const files = filterFiles(task.files, sqlExtensions);
  if (files.length === 0) {
    return createNoopStageResult(task.stageId, "No SQL files were selected for format.");
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
                "sql-formatter",
                file,
              );
              if ("diagnostic" in dialectResult) {
                return [dialectResult.diagnostic];
              }

              const formatted = ensureTrailingNewline(
                formatSql(source, { language: dialectResult.dialect }),
              );
              return normalizeLineEndings(source) === normalizeLineEndings(formatted)
                ? []
                : [createFormattingDiagnostic(file, "sql-formatter")];
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
          ? ["SQL formatter checks passed."]
          : [
              `SQL formatter reported ${timed.result.diagnostics.length} diagnostic${timed.result.diagnostics.length === 1 ? "" : "s"}.`,
            ],
      stageId: task.stageId,
      status: timed.result.status,
      toolRuns: [
        createToolRunResult(
          "sql-formatter",
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
    return createExecutionFailureStage(task.stageId, "sql-formatter", files[0] ?? cwd, error);
  }
}
