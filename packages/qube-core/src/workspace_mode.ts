import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type WorkspaceMode = "local" | "shipping";

export interface WorkspaceModeState {
  readonly mode: WorkspaceMode;
  readonly workspaceRoot: string;
  readonly configPath: string;
  readonly configured: boolean;
}

export interface WorkspaceModeChange extends WorkspaceModeState {
  readonly changed: boolean;
  readonly writes: readonly string[];
}

const START = "<!-- BEGIN QUBE WORKSPACE MODE -->";
const END = "<!-- END QUBE WORKSPACE MODE -->";

export const workspaceModeInstructions = [
  "Read the workspace mode at the start of each session, before issue, branch, or provider checks. `qube mode --json` reports it from this folder or a parent workspace. The setting is stored in `.qube/mode.json`; absence means shipping mode.",
  "In local mode, work directly on the user's requested task. Use the current agent, relevant project materials, and appropriate local checks. Do not enter the issue, branch, commit, pull request, or shipping cycle. Do not initialize Git or require GitHub. Let the user test the result and give feedback. These local workflow rules take precedence over the Executor shipping procedure while local mode is active; other project requirements still apply.",
  "In shipping mode, follow the project's normal workflow. Changing mode does not itself start work or publish changes. If the mode cannot be read, report the error before starting issue or shipping operations. The user's latest instruction remains authoritative.",
].join("\n\n");

export function renderLocalDevelopmentPrompt(request?: string): string {
  return [
    "Work locally in this workspace using the current agent.",
    "Implement the user's requested result. Read the relevant project instructions and existing code first. Let the task determine the language, tools, inputs, and validation. Make the supporting changes needed for working behavior, and keep the implementation focused.",
    "Do not select issues, create branches, commit, push, open pull requests, or enter the shipping cycle. Git and GitHub are not prerequisites. Preserve existing files and unrelated work. Local mode stays active across sessions until the user explicitly changes it.",
    "Run checks appropriate to the changes and exercise the result where practical. Do not run the full shipping workflow for each iteration. Report what works, what you verified, any concrete limitations, and how the user can test it. Allow the user to give feedback before starting unrelated work. Do not claim that unrun checks passed.",
    ...(request?.trim() ? ["Requested work:", request.trim()] : ["Use the user's current request as the task. Ask for the task if none was supplied."]),
  ].join("\n\n") + "\n";
}

function entry(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readFile(path: string): string | null {
  const info = entry(path);
  if (!info) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file at ${path}.`);
  return readFileSync(path, "utf8");
}

function state(workspaceRoot: string, mode: WorkspaceMode, configured: boolean): WorkspaceModeState {
  return { mode, workspaceRoot, configPath: join(workspaceRoot, ".qube", "mode.json"), configured };
}

export function readWorkspaceMode(cwd: string): WorkspaceModeState {
  const start = resolve(cwd);
  for (let directory = start; ; directory = dirname(directory)) {
    const configDirectory = join(directory, ".qube");
    const configPath = join(configDirectory, "mode.json");
    try {
      const configEntry = entry(configDirectory);
      if (configEntry?.isSymbolicLink()) throw new Error(`Workspace configuration must not be a symbolic link: ${configDirectory}.`);
      const source = readFile(configPath);
      if (source !== null) {
        const value: unknown = JSON.parse(source);
        if (!value || typeof value !== "object" || Array.isArray(value)
          || Object.keys(value).some(key => key !== "version" && key !== "mode")
          || !("version" in value) || value.version !== 1
          || !("mode" in value) || (value.mode !== "local" && value.mode !== "shipping")) {
          throw new Error("Expected version 1 and mode local or shipping.");
        }
        return state(directory, value.mode, true);
      }
      if (entry(join(configDirectory, "init.json")) || entry(join(directory, ".git"))) return state(directory, "shipping", false);
    } catch (error) {
      throw new Error(`Cannot read workspace mode at ${configPath}: ${error instanceof Error ? error.message : String(error)} Correct the mode file before continuing.`);
    }
    if (dirname(directory) === directory) return state(start, "shipping", false);
  }
}

function updateInstructions(source: string): string {
  const block = `${START}\n${workspaceModeInstructions}\n${END}`;
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  if (start === -1 && end === -1) return `${source}${source && !source.endsWith("\n") ? "\n" : ""}${source ? "\n" : ""}${block}\n`;
  if (start === -1 || end < start || source.indexOf(START, start + START.length) !== -1 || source.indexOf(END, end + END.length) !== -1) {
    throw new Error("Cannot update an incomplete or duplicate QUBE workspace mode instruction section in AGENTS.md.");
  }
  return source.slice(0, start) + block + source.slice(end + END.length);
}

export function configureWorkspaceMode(cwd: string, mode: WorkspaceMode, options: { readonly dryRun?: boolean } = {}): WorkspaceModeChange {
  if (mode !== "local" && mode !== "shipping") throw new Error("Workspace mode must be local or shipping.");
  const current = readWorkspaceMode(cwd);
  const instructionsPath = join(current.workspaceRoot, "AGENTS.md");
  const originalInstructions = readFile(instructionsPath) ?? "";
  const instructions = updateInstructions(originalInstructions);
  const config = `${JSON.stringify({ version: 1, mode }, null, 2)}\n`;
  const writes = [
    ...(instructions !== originalInstructions ? [instructionsPath] : []),
    ...(readFile(current.configPath) !== config ? [current.configPath] : []),
  ];
  if (!options.dryRun && writes.length > 0) {
    if (writes.includes(instructionsPath)) writeFileSync(instructionsPath, instructions, "utf8");
    if (writes.includes(current.configPath)) {
      mkdirSync(dirname(current.configPath), { recursive: true });
      writeFileSync(current.configPath, config, "utf8");
    }
  }
  return { ...state(current.workspaceRoot, mode, true), changed: writes.length > 0, writes };
}
