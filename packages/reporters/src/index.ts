import path from "node:path";

import type { Diagnostic, RunPlan, RunResult, StageId, StageResult } from "@tjalve/aiq/model";

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

export function formatPlanAsJson(plan: RunPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function formatRunResultAsJson(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function formatPlanAsText(plan: RunPlan): string {
  const lines = [
    "AIQ plan",
    `Run: ${plan.runId}`,
    `Context: ${plan.context}`,
    `Schema: v${plan.artifactVersion}`,
    `Profile: ${plan.profile}`,
    `Files: ${plan.input.summary.fileCount}`,
    `Source: ${plan.input.source}`,
    `Stages: ${plan.stages.length === 0 ? "none configured yet" : plan.stages.join(", ")}`,
    `Tasks: ${plan.summary.taskCount}`,
    `Artifact target: ${plan.artifacts.outDir}`,
  ];

  return `${lines.join("\n")}\n`;
}

export function formatRunResultAsText(result: RunResult): string {
  const lines = [
    `AIQ ${result.mode}`,
    `Run: ${result.runId}`,
    `Context: ${result.context}`,
    `Schema: v${result.artifactVersion}`,
    `Files: ${result.summary.fileCount}`,
    `Stages: ${result.summary.stageCount}`,
    `Tasks: ${result.summary.taskCount}`,
    `Not implemented: ${result.summary.notImplementedStageCount}`,
    `Status: ${result.summary.status}`,
    `Artifacts: plan=${result.artifacts.planPath ?? "not written"}, report=${result.artifacts.reportPath ?? "not written"}`,
  ];

  if (result.summary.stageCount === 0) {
    lines.push(
      "Foundation slice only: manifests and canonical artifacts are active; tool runners follow next.",
    );
  }

  for (const stage of result.stages) {
    lines.push(`- ${stage.stageId}: ${stage.status}`);
    for (const note of stage.notes) {
      lines.push(`  ${note}`);
    }
  }

  const problemGroups = collectProblemGroups(result);
  if (problemGroups.length > 0) {
    lines.push("");
    lines.push("Problem summary:");
    for (const group of problemGroups) {
      lines.push(`${group.heading}:`);
      lines.push(...group.items.map((item) => `  - ${item}`));
    }
    lines.push("Suggested next commands:");
    if (
      problemGroups.some(
        (group) => group.heading === missingToolsCategory || group.heading === setupIssuesCategory,
      )
    ) {
      lines.push("  - aiq setup");
    }
    lines.push("  - aiq doctor");
    lines.push("  - aiq run <paths...> --only <stage-number> --verbose");
    lines.push("  - aiq config --set-stage <0-9>");
  }

  return `${lines.join("\n")}\n`;
}

const missingToolsCategory = "Missing tools";
const setupIssuesCategory = "Setup issues";

type ProblemCategory =
  | "Internal errors"
  | typeof missingToolsCategory
  | "Quality failures"
  | typeof setupIssuesCategory
  | "Unsupported projects";

interface ProblemGroup {
  heading: ProblemCategory;
  items: string[];
}

interface ProblemSummary {
  category: ProblemCategory;
  item: string;
}

const stageNumbers: Record<StageId, number> = {
  e2e: 0,
  lint: 1,
  format: 2,
  typecheck: 3,
  unit: 4,
  sloc: 5,
  complexity: 6,
  maintainability: 7,
  coverage: 8,
  security: 9,
};

const toolLanguageLabels = new Map<string, string>([
  ["biome", "JavaScript/TypeScript"],
  ["cargo", "Rust"],
  ["cargo-check", "Rust"],
  ["cargo-clippy", "Rust"],
  ["cargo-fmt", "Rust"],
  ["dotnet", ".NET"],
  ["go", "Go"],
  ["go test", "Go"],
  ["go vet", "Go"],
  ["gofmt", "Go"],
  ["lizard", "shared metrics"],
  ["pytest", "Python"],
  ["pytest-cov", "Python"],
  ["ruff", "Python"],
  ["shellcheck", "Bash"],
  ["shfmt", "Bash"],
  ["stylelint", "CSS"],
  ["terraform", "Terraform/HCL"],
  ["ty", "Python"],
  ["typescript", "TypeScript"],
]);

function collectProblemGroups(result: RunResult): ProblemGroup[] {
  const summaries = result.stages.flatMap((stage) => summarizeStageProblems(stage));
  const groups: ProblemGroup[] = [];

  for (const heading of [
    setupIssuesCategory,
    missingToolsCategory,
    "Unsupported projects",
    "Quality failures",
    "Internal errors",
  ] as const) {
    const items = summaries
      .filter((summary) => summary.category === heading)
      .map((summary) => summary.item);
    if (items.length > 0) {
      groups.push({ heading, items });
    }
  }

  return groups;
}

function summarizeStageProblems(stage: StageResult): ProblemSummary[] {
  if (stage.status === "passed") {
    return [];
  }

  const messages = [
    ...stage.notes,
    ...stage.diagnostics.map((diagnostic) => diagnostic.message),
  ].filter((message) => message.trim().length > 0);
  const text = messages.join("\n");
  const firstMessage = messages[0] ?? `${stage.stageId} did not pass.`;

  if (isMissingToolStage(stage, text)) {
    return [
      {
        category: missingToolsCategory,
        item: `${formatStageLabel(stage.stageId)} ${formatToolContext(stage)}${firstMessage} Fix: run aiq setup for required setup steps, then install the reported tool through the project or language toolchain.`,
      },
    ];
  }

  if (stage.status === "not_implemented" || isUnsupportedProjectMessage(text)) {
    return [
      {
        category: "Unsupported projects",
        item: `${formatStageLabel(stage.stageId)} ${firstMessage} Fix: add the expected project config/tooling or select a supported stage.`,
      },
    ];
  }

  if (isSetupIssueMessage(text)) {
    return [
      {
        category: setupIssuesCategory,
        item: `${formatStageLabel(stage.stageId)} ${firstMessage} Fix: run aiq setup for prerequisite steps or inspect config with aiq config --print-config.`,
      },
    ];
  }

  if (stage.diagnostics.length > 0) {
    return [
      {
        category: "Quality failures",
        item: `${formatStageLabel(stage.stageId)} ${stage.diagnostics.length} diagnostic${stage.diagnostics.length === 1 ? "" : "s"} from ${formatDiagnosticSources(stage.diagnostics)}. First: ${firstMessage}`,
      },
    ];
  }

  return [
    {
      category: "Internal errors",
      item: `${formatStageLabel(stage.stageId)} ${firstMessage} Re-run with --verbose; if it persists, inspect the generated artifacts.`,
    },
  ];
}

function formatStageLabel(stageId: StageId): string {
  return `[stage ${stageNumbers[stageId]} ${stageId}]`;
}

function formatToolContext(stage: StageResult): string {
  const source = stage.diagnostics[0]?.source ?? readToolFromMessage(stage.notes[0] ?? "");
  if (source === undefined) {
    return "";
  }

  const language = toolLanguageLabels.get(source);
  return language === undefined ? `${source}: ` : `${language}/${source}: `;
}

function formatDiagnosticSources(diagnostics: readonly Diagnostic[]): string {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.source))]
    .sort((left, right) => left.localeCompare(right))
    .join(", ");
}

function readToolFromMessage(message: string): string | undefined {
  const match = /^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*) was not detected\./u.exec(message);
  return match?.[1];
}

function isMissingToolMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes(" was not detected") ||
    lower.includes("command not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("not recognized as the name of a cmdlet") ||
    lower.includes("cannot find the file specified")
  );
}

function isMissingToolStage(stage: StageResult, message: string): boolean {
  if (isMissingToolMessage(message)) {
    return true;
  }

  const missingExternalToolSources = new Set(["lizard", "shellcheck", "shfmt", "terraform"]);
  return stage.diagnostics.some(
    (diagnostic) =>
      missingExternalToolSources.has(diagnostic.source) &&
      diagnostic.message.toLowerCase().includes("exited with code unknown"),
  );
}

function isUnsupportedProjectMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("no supported") ||
    lower.includes("unsupported") ||
    lower.includes("no javascript or typescript project roots") ||
    lower.includes("no cargo manifest") ||
    lower.includes("no go module")
  );
}

function isSetupIssueMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("config") || lower.includes("setup") || lower.includes("project");
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
