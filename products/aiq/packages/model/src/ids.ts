export const stageIds = [
  "lint",
  "format",
  "typecheck",
  "unit",
  "e2e",
  "sloc",
  "complexity",
  "maintainability",
  "coverage",
  "security",
] as const;

export type StageId = (typeof stageIds)[number];

export const surfaceIds = [
  "cli",
  "hook",
  "github",
  "opencode",
  "lsp",
  "mcp",
  "watch",
  "serve",
] as const;

export type SurfaceId = (typeof surfaceIds)[number];

export const runContexts = surfaceIds;

export type RunContext = SurfaceId;

export const languageIds = [
  "javascript",
  "typescript",
  "python",
  "terraform",
  "hcl",
  "go",
  "rust",
  "dotnet",
  "java",
  "kotlin",
  "bash",
  "powershell",
  "html",
  "css",
  "yaml",
  "sql",
  "documents",
] as const;

export type LanguageId = (typeof languageIds)[number];

export const manifestSources = ["direct", "file-list", "stream", "mixed"] as const;

export type ManifestSource = (typeof manifestSources)[number];

export const runModes = ["check", "plan"] as const;

export type RunMode = (typeof runModes)[number];

export const runTelemetryEventTypes = [
  "artifact.written",
  "cache.hit",
  "cache.miss",
  "stage.finished",
  "stage.started",
  "plan.generated",
  "run.finished",
  "run.started",
  "tool.finished",
] as const;

export type RunTelemetryEventType = (typeof runTelemetryEventTypes)[number];
