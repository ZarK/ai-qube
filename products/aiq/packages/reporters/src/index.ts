import type { Diagnostic, RunPlan, RunResult, StageId, StageResult } from "@tjalve/aiq/model";

export {
  collectGitHubAnnotations,
  formatGitHubAnnotationCommand,
  formatRunResultAsGitHubAnnotations,
} from "./github-annotations.js";
export type { GitHubAnnotation, GitHubAnnotationOptions } from "./github-annotations.js";

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

export interface RunResultTextFormatOptions {
  detail?: boolean;
}

export function formatRunResultAsText(
  result: RunResult,
  options: RunResultTextFormatOptions = {},
): string {
  return options.detail
    ? formatDetailedRunResultAsText(result)
    : formatCompactRunResultAsText(result);
}

function formatCompactRunResultAsText(result: RunResult): string {
  const lines = [
    `AIQ ${result.mode}`,
    `Status: ${result.summary.status}`,
    `Stages: ${formatCompactStageList(result.stages)}`,
    `Files: ${result.summary.fileCount}; diagnostics: ${result.summary.diagnosticCount}`,
  ];

  const problemGroups = collectProblemGroups(result);
  if (problemGroups.length > 0) {
    lines.push("");
    lines.push("Problems:");
    for (const group of problemGroups) {
      for (const item of group.items) {
        lines.push(`- ${group.heading}: ${formatCompactProblemItem(group.heading, item)}`);
      }
    }
  }

  lines.push(`Next: ${formatCompactNextAction(result, problemGroups)}`);

  return `${lines.join("\n")}\n`;
}

function formatCompactProblemItem(heading: ProblemCategory, item: string): string {
  if (
    heading === missingToolsCategory ||
    heading === setupIssuesCategory ||
    heading === "Unsupported projects"
  ) {
    return item.replace(/\s+Fix: .+$/u, "");
  }

  return item;
}

function formatDetailedRunResultAsText(result: RunResult): string {
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

function formatCompactStageList(stages: readonly StageResult[]): string {
  if (stages.length === 0) {
    return "none";
  }

  return stages
    .map((stage) => `${stageNumbers[stage.stageId]} ${stage.stageId} ${stage.status}`)
    .join("; ");
}

function formatCompactNextAction(
  result: RunResult,
  problemGroups: readonly ProblemGroup[],
): string {
  if (result.summary.status === "passed") {
    return "no action required.";
  }

  if (
    problemGroups.some(
      (group) => group.heading === missingToolsCategory || group.heading === setupIssuesCategory,
    )
  ) {
    return "aiq setup";
  }

  const failedStage = result.stages.find((stage) => stage.status !== "passed");
  const stageNumber =
    failedStage === undefined ? "<stage-number>" : String(stageNumbers[failedStage.stageId]);
  return `aiq run <paths...> --only ${stageNumber} --verbose`;
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

  if (isMetricRemediationStage(stage)) {
    return [
      {
        category: "Quality failures",
        item: formatMetricRemediationSummary(stage, firstMessage),
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

function isMetricRemediationStage(stage: StageResult): boolean {
  if (
    stage.stageId !== "sloc" &&
    stage.stageId !== "complexity" &&
    stage.stageId !== "maintainability"
  ) {
    return false;
  }

  return stage.diagnostics.some((diagnostic) => diagnostic.code?.startsWith("metrics/"));
}

function formatMetricRemediationSummary(stage: StageResult, firstMessage: string): string {
  return `${formatStageLabel(stage.stageId)} ${stage.diagnostics.length} metric diagnostic${stage.diagnostics.length === 1 ? "" : "s"} from ${formatDiagnosticSources(stage.diagnostics)}. First: ${firstMessage} Fix: ${formatMetricRemediationGuidance(stage.stageId)}`;
}

function formatMetricRemediationGuidance(stageId: StageId): string {
  const common =
    "Metric remediation is behavior-preserving: preserve public APIs, command behavior, tool selection, execution order, existing pathways, and repository conventions. Do not use metric failures as authorization for feature changes, command semantic changes, stage/language/tool boundary changes, or architecture rewrites.";
  const naming =
    "Use direct purpose-revealing names: active verbs for functions, direct nouns for values, plural nouns for collections, short scoped file/module names, and no vague helper/manager/processor names unless local convention requires them.";

  switch (stageId) {
    case "sloc":
      return `${common} Split oversized source and test files into cohesive modules or focused specs, keeping each slice behavior-preserving.`;
    case "complexity":
      return `${common} Reduce branching in the reported function, extract named decisions, prefer clear guard clauses or tables where they fit, and keep behavior covered by existing tests. ${naming}`;
    case "maintainability":
      return `${common} Shorten large functions, reduce parameter lists, separate unrelated decisions, and improve readability without changing behavior. ${naming}`;
    default:
      return `${common} Make small behavior-preserving refactors and rerun the failing metric stage. ${naming}`;
  }
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
