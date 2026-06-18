import path from "node:path";

import type { Diagnostic, RunResult } from "@tjalve/aiq/model";

export interface GitHubAnnotation {
  endColumn?: number;
  endLine?: number;
  file?: string;
  level: "error" | "notice" | "warning";
  message: string;
  startColumn?: number;
  startLine?: number;
  title: string;
}

export interface GitHubAnnotationOptions {
  maxAnnotations?: number;
  workspaceRoot?: string;
}

export function collectGitHubAnnotations(
  result: RunResult,
  options: GitHubAnnotationOptions = {},
): GitHubAnnotation[] {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? result.request.cwd);
  const annotations = result.stages.flatMap((stage) =>
    stage.diagnostics.map((diagnostic) =>
      mapDiagnosticToGitHubAnnotation(diagnostic, workspaceRoot),
    ),
  );
  const maxAnnotations = options.maxAnnotations;

  if (maxAnnotations === undefined || !Number.isFinite(maxAnnotations) || maxAnnotations < 0) {
    return annotations;
  }

  return annotations.slice(0, maxAnnotations);
}

export function formatGitHubAnnotationCommand(annotation: GitHubAnnotation): string {
  const properties: string[] = [];

  if (annotation.file !== undefined) {
    properties.push(`file=${escapeGitHubCommandProperty(annotation.file)}`);
  }
  if (annotation.startLine !== undefined) {
    properties.push(`line=${annotation.startLine}`);
  }
  if (annotation.endLine !== undefined) {
    properties.push(`endLine=${annotation.endLine}`);
  }
  if (annotation.startColumn !== undefined) {
    properties.push(`col=${annotation.startColumn}`);
  }
  if (annotation.endColumn !== undefined) {
    properties.push(`endColumn=${annotation.endColumn}`);
  }
  properties.push(`title=${escapeGitHubCommandProperty(annotation.title)}`);

  const prefix =
    properties.length === 0
      ? `::${annotation.level}`
      : `::${annotation.level} ${properties.join(",")}`;
  return `${prefix}::${escapeGitHubCommandMessage(annotation.message)}`;
}

export function formatRunResultAsGitHubAnnotations(
  result: RunResult,
  options: GitHubAnnotationOptions = {},
): string {
  const lines = collectGitHubAnnotations(result, options).map(formatGitHubAnnotationCommand);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function mapDiagnosticToGitHubAnnotation(
  diagnostic: Diagnostic,
  workspaceRoot: string,
): GitHubAnnotation {
  const annotation: GitHubAnnotation = {
    level: mapGitHubAnnotationLevel(diagnostic.severity),
    message: diagnostic.message,
    title:
      diagnostic.code === undefined
        ? `AIQ/${diagnostic.source}`
        : `AIQ/${diagnostic.source} ${diagnostic.code}`,
  };

  if (diagnostic.file.length > 0) {
    annotation.file = normalizeGitHubAnnotationFile(diagnostic.file, workspaceRoot);
  }

  if (diagnostic.range !== undefined) {
    annotation.startLine = diagnostic.range.startLine;
    annotation.startColumn = diagnostic.range.startColumn;

    if (diagnostic.range.endLine !== undefined) {
      annotation.endLine = diagnostic.range.endLine;
    }
    if (diagnostic.range.endColumn !== undefined) {
      annotation.endColumn = diagnostic.range.endColumn;
    }
  }

  return annotation;
}

function mapGitHubAnnotationLevel(severity: Diagnostic["severity"]): GitHubAnnotation["level"] {
  if (severity === "error") {
    return "error";
  }

  if (severity === "warning") {
    return "warning";
  }

  return "notice";
}

function normalizeGitHubAnnotationFile(filePath: string, workspaceRoot: string): string {
  const relativePath = path.relative(workspaceRoot, filePath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === ".."
  ) {
    return normalizeGitHubPath(filePath);
  }

  return normalizeGitHubPath(relativePath);
}

function normalizeGitHubPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

function escapeGitHubCommandMessage(value: string): string {
  return value.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

function escapeGitHubCommandProperty(value: string): string {
  return escapeGitHubCommandMessage(value).replace(/:/gu, "%3A").replace(/,/gu, "%2C");
}
