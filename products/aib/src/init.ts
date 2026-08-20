import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { createDryRunPlan, type DryRunPlan } from "@tjalve/qube-cli/mutation";

import {
  applyAgentAssetActions,
  createAgentAssetPlan,
  planAgentAssetFiles,
  type AgentAssetAction,
  type AgentAssetFile,
  type AgentAssetOperation,
} from "./agent_assets.js";
import type { AibConfig, LoadedAibConfig } from "./config.js";
import {
  createBootstrapState,
  defaultStatePath,
  parseBootstrapState,
  writeBootstrapState,
  type BootstrapState,
} from "./state.js";

export type InitFileOperation = AgentAssetOperation;

export interface InitFileAction {
  readonly id: string;
  readonly path: string;
  readonly kind: "session" | "instruction";
  readonly operation: InitFileOperation;
  readonly reason: string;
  readonly suggestedNextAction?: string;
}

export interface InitPlan {
  readonly ok: boolean;
  readonly target: string;
  readonly configPath?: string;
  readonly config: AibConfig;
  readonly idea?: string;
  readonly sessionPath: string;
  readonly state: BootstrapState;
  readonly sessionAction: InitFileAction;
  readonly agentAssets: readonly AgentAssetFile[];
  readonly agentActions: readonly AgentAssetAction[];
  readonly actions: readonly InitFileAction[];
  readonly conflicts: readonly InitFileAction[];
  readonly dryRunPlan: DryRunPlan;
}

export interface AppliedInitPlan extends InitPlan {
  readonly mutated: boolean;
  readonly written: readonly { readonly path: string; readonly operation: "create" | "update" }[];
}

export function createInitPlan(input: {
  readonly target: string | undefined;
  readonly loadedConfig: LoadedAibConfig;
  readonly idea: string | undefined;
}): InitPlan {
  const target = resolve(input.target && input.target.length > 0 ? input.target : ".");
  const config = input.loadedConfig.config;
  const stateDir = config.paths?.stateDir ?? ".qube/aib";
  const docsDir = config.paths?.docsDir ?? "docs";
  const specPath = config.paths?.specPath ?? `${docsDir}/spec.md`;
  const sessionPath = defaultStatePath(target, stateDir);
  const initialState = createBootstrapState({
    intent: input.idea,
    agentHost: config.agent?.host,
    questionBudget: config.agent?.questionBudget,
    referencePaths: config.discovery?.referencePaths,
    inspectCurrentRepo: config.discovery?.inspectCurrentRepo,
    inspectDocs: config.discovery?.inspectDocs,
    inspectSiblingRepos: config.discovery?.inspectSiblingRepos,
    specPath,
  });
  const plannedSession = planSessionFile(target, sessionPath, initialState);
  const agentAssets = createAgentAssetPlan(config.agent?.surfaces ?? config.agent?.host);
  const agentActions = planAgentAssetFiles(target, agentAssets);
  const sessionAction = plannedSession.action;
  const actions = Object.freeze([
    sessionAction,
    ...agentActions.map(toInitAction),
  ]);
  const conflicts = Object.freeze(actions.filter((action) => action.operation === "conflict"));

  return Object.freeze({
    ok: conflicts.length === 0,
    target,
    ...(input.loadedConfig.path ? { configPath: input.loadedConfig.path } : {}),
    config,
    ...(input.idea ? { idea: input.idea } : {}),
    sessionPath,
    state: plannedSession.state,
    sessionAction,
    agentAssets,
    agentActions,
    actions,
    conflicts,
    dryRunPlan: createDryRunPlan({
      command: "aib init",
      summary: "Prepare Bootstrap session state and managed agent instructions.",
      mutationCategories: ["local-files", "local-config"],
      steps: actions.map((action) => ({
        action: action.operation,
        target: action.path,
        category: action.kind === "session" ? "local-config" as const : "local-files" as const,
        description: action.reason,
      })),
      rerunCommand: "aib init --dry-run",
    }),
  });
}

export function applyInitPlan(plan: InitPlan): AppliedInitPlan {
  const refreshed = createInitPlan({
    target: plan.target,
    loadedConfig: {
      ...(plan.configPath ? { path: plan.configPath } : {}),
      config: plan.config,
    },
    idea: plan.idea,
  });
  if (!refreshed.ok) {
    return Object.freeze({ ...refreshed, mutated: false, written: Object.freeze([]) });
  }

  const written: { path: string; operation: "create" | "update" }[] = [];
  if (refreshed.sessionAction.operation === "create") {
    writeBootstrapState(refreshed.sessionPath, refreshed.state);
    written.push({ path: refreshed.sessionPath, operation: "create" });
  }
  for (const action of applyAgentAssetActions(refreshed.agentActions)) {
    if (action.operation === "create" || action.operation === "update") {
      written.push({ path: action.path, operation: action.operation });
    }
  }

  return Object.freeze({
    ...refreshed,
    mutated: written.length > 0,
    written: Object.freeze(written),
  });
}

function planSessionFile(target: string, sessionPath: string, initialState: BootstrapState): { readonly action: InitFileAction; readonly state: BootstrapState } {
  let status: ReturnType<typeof lstatSync> | undefined;
  try {
    status = inspectSessionPath(target, sessionPath);
  } catch (error) {
    return sessionConflict(sessionPath, initialState, error instanceof Error ? error.message : String(error));
  }
  if (status === undefined) {
    return {
      action: Object.freeze({
        id: "bootstrap-session",
        path: sessionPath,
        kind: "session",
        operation: "create",
        reason: "Bootstrap session state does not exist.",
      }),
      state: initialState,
    };
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    return sessionConflict(sessionPath, initialState, status.isSymbolicLink()
      ? "Bootstrap session path is a symbolic link."
      : "Bootstrap session path is not a regular file.");
  }
  try {
    const state = parseBootstrapState(JSON.parse(readFileSync(sessionPath, "utf8")) as unknown);
    return {
      action: Object.freeze({
        id: "bootstrap-session",
        path: sessionPath,
        kind: "session",
        operation: "skip",
        reason: "Existing valid Bootstrap session state is preserved.",
      }),
      state,
    };
  } catch (error) {
    return sessionConflict(
      sessionPath,
      initialState,
      `Bootstrap session state is invalid or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function inspectSessionPath(target: string, sessionPath: string): ReturnType<typeof lstatSync> | undefined {
  const relativePath = relative(target, sessionPath);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new TypeError(`Bootstrap session path is outside the selected target: ${sessionPath}`);
  }

  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const status = lstatSync(current, { throwIfNoEntry: false });
    if (status?.isSymbolicLink()) {
      throw new TypeError(`Bootstrap session directory is a symbolic link: ${current}`);
    }
    if (status !== undefined && !status.isDirectory()) {
      throw new TypeError(`Bootstrap session parent is not a directory: ${current}`);
    }
    current = resolve(current, segment);
  }

  const parentStatus = lstatSync(current, { throwIfNoEntry: false });
  if (parentStatus?.isSymbolicLink()) {
    throw new TypeError(`Bootstrap session directory is a symbolic link: ${current}`);
  }
  if (parentStatus !== undefined && !parentStatus.isDirectory()) {
    throw new TypeError(`Bootstrap session parent is not a directory: ${current}`);
  }
  return lstatSync(sessionPath, { throwIfNoEntry: false });
}

function sessionConflict(sessionPath: string, state: BootstrapState, reason: string): { readonly action: InitFileAction; readonly state: BootstrapState } {
  return {
    action: Object.freeze({
      id: "bootstrap-session",
      path: sessionPath,
      kind: "session",
      operation: "conflict",
      reason,
      suggestedNextAction: `Fix or remove ${displayPath(sessionPath)}, then run aib init again. QUBE does not replace Bootstrap session state.`,
    }),
    state,
  };
}

function toInitAction(action: AgentAssetAction): InitFileAction {
  return Object.freeze({
    id: action.id,
    path: action.absolutePath,
    kind: "instruction",
    operation: action.operation,
    reason: action.reason,
    ...(action.operation === "conflict"
      ? { suggestedNextAction: `Fix ${displayPath(action.absolutePath)}, then run aib init again. QUBE preserves existing instruction content.` }
      : {}),
  });
}

function displayPath(filePath: string): string {
  const displayed = relative(process.cwd(), filePath);
  return displayed === "" || displayed.startsWith("..") ? filePath : displayed;
}
