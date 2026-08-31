import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { AGENT_HOST_CAPABILITY_PROFILES, AGENT_HOST_IDS, type AgentHostCapabilityProfile } from "@tjalve/qube-core";

import type { AgentHostKind } from "./contracts.js";

export type AgentAssetKind = "instruction";

export interface AgentAssetFile {
  readonly id: string;
  readonly host: AgentHostKind;
  readonly path: string;
  readonly kind: AgentAssetKind;
  readonly body: string;
}

export type AgentAssetOperation = "create" | "update" | "skip" | "conflict";

export interface AgentAssetAction extends AgentAssetFile {
  readonly absolutePath: string;
  readonly operation: AgentAssetOperation;
  readonly reason: string;
  readonly content: string;
}

const MANAGED_START = "<!-- BEGIN QUBE BOOTSTRAP MANAGED SECTION -->";
const MANAGED_END = "<!-- END QUBE BOOTSTRAP MANAGED SECTION -->";

export function createAgentAssetPlan(hosts: AgentHostKind | readonly AgentHostKind[] | undefined): readonly AgentAssetFile[] {
  const selected = typeof hosts === "string" ? [hosts] : [...(hosts ?? [])];
  if (selected.length === 0) return [];

  const selectedIds = new Set(selected);
  const profiles = AGENT_HOST_IDS
    .filter((host) => selectedIds.has(host))
    .map((host) => AGENT_HOST_CAPABILITY_PROFILES[host]);
  const profilesByPath = new Map<string, AgentHostCapabilityProfile[]>();
  for (const profile of profiles) {
    const grouped = profilesByPath.get(profile.instructionPath) ?? [];
    grouped.push(profile);
    profilesByPath.set(profile.instructionPath, grouped);
  }
  const files = [...profilesByPath.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, grouped]) => instruction(
      grouped[0]!.id,
      path,
      sharedBody(grouped.map((profile) => profile.displayName).join(", "))
    ));
  return Object.freeze(files);
}

export function writeAgentAssetFiles(target: string, files: readonly AgentAssetFile[]): readonly { readonly path: string }[] {
  const actions = planAgentAssetFiles(target, files);
  const conflict = actions.find((action) => action.operation === "conflict");
  if (conflict) throw new TypeError(conflict.reason);
  applyAgentAssetActions(actions);
  return actions.map((action) => ({ path: action.absolutePath }));
}

export function planAgentAssetFiles(target: string, files: readonly AgentAssetFile[]): readonly AgentAssetAction[] {
  const baseDir = resolve(target);
  return Object.freeze(files.map((file) => planAgentAssetFile(baseDir, file)));
}

export function applyAgentAssetActions(actions: readonly AgentAssetAction[]): readonly { readonly path: string; readonly operation: AgentAssetOperation }[] {
  const conflict = actions.find((action) => action.operation === "conflict");
  if (conflict) throw new TypeError(conflict.reason);
  for (const action of actions) {
    if (action.operation !== "create" && action.operation !== "update") continue;
    mkdirSync(dirname(action.absolutePath), { recursive: true });
    const status = lstatSync(action.absolutePath, { throwIfNoEntry: false });
    if (status?.isSymbolicLink()) {
      throw new TypeError(`refusing to write agent asset through a symlink: ${action.absolutePath}`);
    }
    if (status !== undefined && !status.isFile()) {
      throw new TypeError(`refusing to replace a non-file agent asset: ${action.absolutePath}`);
    }
    writeFileSync(action.absolutePath, action.content, "utf8");
  }
  return Object.freeze(actions.map((action) => ({ path: action.absolutePath, operation: action.operation })));
}

function planAgentAssetFile(baseDir: string, file: AgentAssetFile): AgentAssetAction {
  let absolutePath = resolve(baseDir, file.path);
  try {
    absolutePath = safeAssetPath(baseDir, file.path);
    const status = inspectAssetPath(baseDir, absolutePath);
    const current = status === undefined ? "" : readFileSync(absolutePath, "utf8");
    const content = mergeManagedInstruction(current, file.body);
    const operation: AgentAssetOperation = status === undefined ? "create" : current === content ? "skip" : "update";
    return Object.freeze({
      ...file,
      absolutePath,
      operation,
      reason: operation === "create"
        ? "Managed instruction file does not exist."
        : operation === "skip"
          ? "The managed Bootstrap instruction section already matches."
          : "The managed Bootstrap instruction section will be updated; other content will be preserved.",
      content,
    });
  } catch (error) {
    return Object.freeze({
      ...file,
      absolutePath,
      operation: "conflict",
      reason: error instanceof Error ? error.message : String(error),
      content: "",
    });
  }
}

function inspectAssetPath(baseDir: string, absolutePath: string): ReturnType<typeof lstatSync> | undefined {
  const relativePath = relative(baseDir, absolutePath);
  const segments = relativePath.split(/[\\/]+/u).filter((segment) => segment.length > 0);
  let current = baseDir;
  for (const segment of segments.slice(0, -1)) {
    const status = lstatSync(current, { throwIfNoEntry: false });
    if (status?.isSymbolicLink()) {
      throw new TypeError(`refusing to follow an agent asset directory symlink: ${current}`);
    }
    if (status !== undefined && !status.isDirectory()) {
      throw new TypeError(`refusing to use a non-directory agent asset path: ${current}`);
    }
    current = resolve(current, segment);
  }
  const parentStatus = lstatSync(current, { throwIfNoEntry: false });
  if (parentStatus?.isSymbolicLink()) {
    throw new TypeError(`refusing to follow an agent asset directory symlink: ${current}`);
  }
  if (parentStatus !== undefined && !parentStatus.isDirectory()) {
    throw new TypeError(`refusing to use a non-directory agent asset path: ${current}`);
  }
  const status = lstatSync(absolutePath, { throwIfNoEntry: false });
  if (status?.isSymbolicLink()) {
    throw new TypeError(`refusing to write agent asset through a symlink: ${absolutePath}`);
  }
  if (status !== undefined && !status.isFile()) {
    throw new TypeError(`refusing to replace a non-file agent asset: ${absolutePath}`);
  }
  return status;
}

function mergeManagedInstruction(current: string, body: string): string {
  const block = `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}`;
  const start = current.indexOf(MANAGED_START);
  const end = current.indexOf(MANAGED_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && end < start)) {
    throw new TypeError("refusing to replace an incomplete QUBE Bootstrap managed section");
  }
  if (start !== -1 && end !== -1) {
    return `${current.slice(0, start)}${block}${current.slice(end + MANAGED_END.length)}`;
  }
  const prefix = current.trimEnd();
  return prefix === "" ? `${block}\n` : `${prefix}\n\n${block}\n`;
}

function safeAssetPath(baseDir: string, assetPath: string): string {
  if (isAbsolute(assetPath)) {
    throw new TypeError(`refusing to write absolute agent asset path: ${assetPath}`);
  }
  const segments = assetPath.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new TypeError(`refusing to write agent asset outside target: ${assetPath}`);
  }
  const path = resolve(baseDir, ...segments);
  if (!inside(baseDir, path)) {
    throw new TypeError(`refusing to write agent asset outside target: ${assetPath}`);
  }
  return path;
}

function inside(baseDir: string, path: string): boolean {
  const relativePath = relative(baseDir, path);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function instruction(host: AgentHostKind, path: string, body: string): AgentAssetFile {
  return {
    id: `${host}:instructions`,
    host,
    path,
    kind: "instruction",
    body
  };
}

function sharedBody(hostName: string): string {
  return `# AIB Bootstrap Workflow

This repository uses \`aib\` as an agent-operated planning engine. The human talks to the agent; the agent operates the CLI and records durable state.

## Operator Contract

- Start with \`aib init --json\` when no bootstrap state exists.
- Use \`aib next --json\` to decide the next action.
- Ask the human only the questions returned by \`aib next --json\`, then record answers with \`aib answer --field <field> --value <answer> --json\`.
- Draft, validate, accept, and reopen specs with the structured \`aib spec ... --json\` commands.
- Generate milestones before work items, then render work items only after the canonical drafts are reviewable.
- Keep product requirements provider-neutral; provider IDs and URLs belong in state or provider metadata.
- If the human asks for autoresearch, run \`qube autoresearch --help\`, translate natural language to \`<target>\` plus \`<goal>\`, and synthesize the arena before edits.
- Do not install global commands, skills, hooks, or tools unless the human explicitly requests that separate action.

## ${hostName}

Use this file as the local host instruction surface. Host-specific todo or command tools are convenience surfaces; the durable workflow is the \`aib\` state machine.
`;
}
