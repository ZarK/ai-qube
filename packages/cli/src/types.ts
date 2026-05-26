import type { BenchmarkScenarioKind } from "@tjalve/aiq-benchmark";
import {
  type AiqProfileName,
  type AiqProgressStageIndex,
  aiqStageLadderIds,
} from "@tjalve/aiq-config-schema";
import type { StageId, ToolRunResult } from "@tjalve/aiq-model";

export type CommandName =
  | "bench"
  | "check"
  | "ci"
  | "config"
  | "doctor"
  | "evidence"
  | "first-run"
  | "hook"
  | "ignore"
  | "install-tools"
  | "plan"
  | "run"
  | "schema"
  | "serve"
  | "status"
  | "watch";
export type OutputFormat = "json" | "text";
export type SetupGuidanceCommand = "ci" | "hook" | "ignore" | "install-tools";

export const defaultServeHost = "127.0.0.1";
export const defaultServePort = 3000;
export const maxServeRequestBodyBytes = 1_048_576;
export const defaultWatchCadenceMs = 30_000;
export const defaultWatchDebounceMs = 75;

export interface CliIo {
  cwd: string;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdin: CliInput;
  stdout: Pick<NodeJS.WriteStream, "write">;
}

export interface CliInput {
  on(event: "data", handler: (chunk: string | Buffer) => void): unknown;
  on(event: "end", handler: () => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  resume(): unknown;
  setEncoding(encoding?: BufferEncoding): unknown;
}

export interface ParsedArgs {
  benchmarkKinds: BenchmarkScenarioKind[];
  benchmarkCorpusRoot?: string;
  benchmarkScenarioIds: string[];
  benchmarkTags: string[];
  command: CommandName;
  configPrint: boolean;
  configSetStage?: AiqProgressStageIndex;
  debounceMs: number;
  diffOnly: boolean;
  dryRun: boolean;
  files: string[];
  filesFrom?: string;
  format: OutputFormat;
  help: boolean;
  host: string;
  outDir?: string;
  port: number;
  profile?: AiqProfileName;
  setupSubcommand?: string;
  stages: StageId[];
  stdinFileList: boolean;
  verbose: boolean;
}

export const cliStageShortcutIds = aiqStageLadderIds;

export interface CliRunOptions {
  signal?: AbortSignal;
}

export interface VerboseToolRunDetail
  extends Pick<ToolRunResult, "args" | "exitCode" | "status" | "tool"> {
  stageId: StageId;
}

export const cliHelp = `AIQ CLI

Usage:
  aiq
  aiq <files...> [--files <files...>] [--files-from path] [--stdin-file-list]
  aiq run <files...> [--files <files...>] [--files-from path] [--stdin-file-list]
  aiq bench [--corpus-root <path>] [--scenario <id>] [--tag <tag>] [--kind <cold|warm|diff-only>]
  aiq check <files...> [--files <files...>] [--files-from path] [--stdin-file-list]
  aiq config [--print-config | --set-stage <0-9>]
  aiq doctor [--up-to <0-9> | --only <0-9> | --stage <stage>] [--profile <fast|standard|deep>] [--verbose]
  aiq evidence [--format json]
  aiq status [--format <json|text>]
  aiq schema [--format json]
  aiq install-tools
  aiq hook install
  aiq ci setup
  aiq ignore write
  aiq plan <files...> [--files <files...>] [--files-from path] [--stdin-file-list]
  aiq watch <files...> [--files <files...>] [--files-from path] [--stdin-file-list]
  aiq serve [--host <host>] [--port <port>]

Run is the primary command. With no arguments, aiq looks for a supported project in the current directory and runs cumulative stages up to the current stage when it is safe to infer one.
A leading file path is treated as aiq run.
Check is kept as a compatibility alias for existing automation.

Examples:
  aiq config --set-stage 3
  aiq run src
  aiq plan src
  aiq run src --up-to 3
  aiq run src --only 1
  aiq run src --stage typecheck
  aiq evidence --format json
  aiq status
  aiq schema --format json

Options:
  --diff-only
  --dry-run
  --format <json|text>
  --corpus-root <path>
  --out-dir <path>
  --only <0-9>
  --print-config
  --scenario <id>
  --set-stage <0-9>
  --stage <stage>
  --tag <tag>
  --up-to <0-9>
  --verbose, -v
  --kind <cold|warm|diff-only>
  --profile <fast|standard|deep>
  --debounce-ms <ms>
  --host <host>
  --files <files...>
  --files-from <path>
  --port <port>
  --stdin-file-list
  -h, --help

Stage ladder:
  0=e2e 1=lint 2=format 3=typecheck 4=unit 5=sloc 6=complexity 7=maintainability 8=coverage 9=security

Stage selection:
  By default aiq run and aiq plan use cumulative ladder stages 0 through .aiq/progress.json current_stage when present, otherwise the configured CLI profile stages.
  Set the current stage once with aiq config --set-stage N, then run aiq run <paths...> for the normal cumulative workflow.
  --only N runs one stage from the ladder.
  --up-to N runs every ladder stage from 0 through N.
  --stage <name> is the advanced named-stage form for scripts or focused diagnostics.
  --diff-only scopes safe file-local stages to the supplied changed-file manifest: lint, format, sloc, complexity, maintainability.
  Full-run stages stay selected without additional narrowing: e2e, typecheck, unit, coverage, security.

Operational checks:
  --dry-run prints the run plan without executing tools or writing artifacts.
  --verbose adds command/tool details to text run output.
  aiq doctor validates config/progress state, uses the same stage selection as run, and reports detected tech plus required, installed, optional, bundled, and project-managed tools.
  aiq evidence emits structured AIQ quality evidence that AIE can record and AIU can parse as trusted quality state.
  aiq status shows the current stage, default cumulative run range, latest artifact paths, last run status, and next suggested command.
  install-tools, hook install, ci setup, and ignore write are replaced by explicit guidance; use aiq doctor for diagnostics and aiq config for canonical project state.

Package surface:
  @tjalve/aiq exports the CLI; @tjalve/aiq/api exports the model, config, engine, reporter, and benchmark APIs used by adapters.
  @tjalve/aiq/schema and aiq schema --format json expose QUBE-compatible command metadata.

Config state:
  aiq config initializes .aiq/aiq.config.json and .aiq/progress.json.
  aiq config --print-config prints effective config plus progress/current-stage state.
  aiq config --set-stage N persists .aiq/progress.json current_stage.
`;
