import type { RunPlan, RunResult, StageId, StageResult } from "@tjalve/aiq/model";

export {
  collectGitHubAnnotations,
  formatGitHubAnnotationCommand,
  formatRunResultAsGitHubAnnotations,
} from "./github-annotations.js";
export type {
  GitHubAnnotation,
  GitHubAnnotationOptions,
} from "./github-annotations.js";

export function formatPlanAsJson(plan: RunPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function formatRunResultAsJson(result: RunResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function formatPlanAsText(plan: RunPlan): string {
  const lines = [
    "Quality plan",
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
  color?: boolean;
  targets?: readonly string[];
}

export function formatRunResultAsText(
  result: RunResult,
  options: RunResultTextFormatOptions = {},
): string {
  const color =
    (options.color ?? process.stdout.isTTY === true) && process.env.NO_COLOR === undefined;
  let elapsed = 0;
  const lines = result.stages.map((stage) => {
    const start =
      stage.startedAt === undefined
        ? elapsed
        : Date.parse(stage.startedAt) - Date.parse(result.startedAt);
    elapsed = start + stage.durationMs;
    return formatStage(stage, start, color);
  });
  lines.push("", `Total execution time: ${formatDuration(result.durationMs)}`);
  appendDebugHints(lines, result.stages, options.targets ?? []);
  if (options.detail) appendDetails(lines, result);
  return `${lines.join("\n")}\n`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}m${String(seconds % 60).padStart(2, "0")}s`;
}

function formatStage(stage: StageResult, elapsed: number, color: boolean): string {
  const timestamp = `[${formatDuration(elapsed)}/${formatDuration(stage.durationMs)}]`;
  const status = stage.status === "not_implemented" ? "WARNING" : stage.status.toUpperCase();
  const statusColor = status === "PASSED" ? 32 : status === "FAILED" ? 31 : 33;
  const reason =
    stage.status === "passed" || (stage.status === "failed" && stage.toolRuns.length > 0)
      ? undefined
      : (stage.notes[0] ?? stage.diagnostics[0]?.message);
  return `${paint(timestamp, 2, color)} Stage ${stageNumbers[stage.stageId]} (${stage.stageId}): ${paint(status, statusColor, color)}${reason === undefined ? "" : ` (${reason.replace(/\s+/gu, " ")})`}`;
}

function paint(text: string, code: number, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function appendDebugHints(
  lines: string[],
  stages: readonly StageResult[],
  targets: readonly string[],
): void {
  const failed = stages.filter((stage) => stage.status === "failed");
  if (failed.length === 0) return;
  lines.push("", "To debug failed stages:");
  const targetArgs = targets.map(quoteArgument).join(" ");
  for (const stage of failed) {
    const number = stageNumbers[stage.stageId];
    lines.push(
      `  aiq run${targetArgs.length === 0 ? "" : ` ${targetArgs}`} --only ${number} --verbose  # Debug stage ${number} (${stage.stageId})`,
    );
  }
}

function quoteArgument(value: string): string {
  return /^[A-Za-z0-9_./\\:-]+$/u.test(value) ? value : JSON.stringify(value);
}

function appendDetails(lines: string[], result: RunResult): void {
  lines.push("", `Run: ${result.runId}`, `Context: ${result.context}`);
  lines.push(
    `Artifacts: plan=${result.artifacts.planPath ?? "not written"}, report=${result.artifacts.reportPath ?? "not written"}`,
  );
  for (const stage of result.stages) {
    lines.push(`- ${stage.stageId}: ${stage.status}`);
    for (const note of stage.notes) lines.push(`  ${note}`);
    for (const diagnostic of stage.diagnostics) {
      lines.push(
        `  ${diagnostic.source}: ${diagnostic.file || "workspace"}: ${diagnostic.message}`,
      );
    }
    for (const tool of stage.toolRuns) {
      lines.push(
        `  ${tool.tool} ${tool.args.join(" ")} (${tool.status}, exit ${tool.exitCode ?? "unknown"})`,
      );
      if (tool.stdoutRef) lines.push(`    stdout: ${tool.stdoutRef}`);
      if (tool.stderrRef) lines.push(`    stderr: ${tool.stderrRef}`);
    }
  }
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
