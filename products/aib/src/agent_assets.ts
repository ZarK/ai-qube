import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { getAgentHostProfileSync } from "@tjalve/aie";
import { AGENT_HOST_IDS, type AgentHostProfile } from "@tjalve/qube-core";

import type { AgentHostKind } from "./contracts.js";

export type AgentAssetKind = "instruction";

export interface AgentAssetFile {
  readonly id: string;
  readonly host: AgentHostKind;
  readonly path: string;
  readonly kind: AgentAssetKind;
  readonly body: string;
}

const MANAGED_START = "<!-- BEGIN QUBE BOOTSTRAP MANAGED SECTION -->";
const MANAGED_END = "<!-- END QUBE BOOTSTRAP MANAGED SECTION -->";

export function createAgentAssetPlan(hosts: AgentHostKind | readonly AgentHostKind[] | undefined): readonly AgentAssetFile[] {
  const selected = typeof hosts === "string" ? [hosts] : [...(hosts ?? [])];
  if (selected.length === 0) return [];

  const selectedIds = new Set(selected);
  const profiles = AGENT_HOST_IDS
    .filter((host) => selectedIds.has(host))
    .map((host) => getAgentHostProfileSync(host));
  const profilesByPath = new Map<string, AgentHostProfile[]>();
  for (const profile of profiles) {
    const grouped = profilesByPath.get(profile.instructionTarget.path) ?? [];
    grouped.push(profile);
    profilesByPath.set(profile.instructionTarget.path, grouped);
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
  const baseDir = resolve(target);
  mkdirSync(baseDir, { recursive: true });
  const realBaseDir = realpathSync(baseDir);
  const written: { path: string }[] = [];
  for (const file of files) {
    const path = safeAssetPath(realBaseDir, file.path);
    const current = readAssetFile(path);
    const next = mergeManagedInstruction(current, file.body);
    if (current !== next) {
      assertSafeAssetFile(path);
      writeFileSync(path, next);
    }
    written.push({ path });
  }
  return written;
}

function readAssetFile(path: string): string {
  const status = assertSafeAssetFile(path);
  return status === undefined ? "" : readFileSync(path, "utf8");
}

function assertSafeAssetFile(path: string): ReturnType<typeof lstatSync> | undefined {
  const status = lstatSync(path, { throwIfNoEntry: false });
  if (status?.isSymbolicLink()) {
    throw new TypeError(`refusing to write agent asset through a symlink: ${path}`);
  }
  if (status !== undefined && !status.isFile()) {
    throw new TypeError(`refusing to replace a non-file agent asset: ${path}`);
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

function safeAssetPath(realBaseDir: string, assetPath: string): string {
  if (isAbsolute(assetPath)) {
    throw new TypeError(`refusing to write absolute agent asset path: ${assetPath}`);
  }
  const segments = assetPath.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    throw new TypeError(`refusing to write agent asset outside target: ${assetPath}`);
  }
  let current = realBaseDir;
  for (const segment of segments.slice(0, -1)) {
    const next = resolve(current, segment);
    if (!inside(realBaseDir, next)) {
      throw new TypeError(`refusing to write agent asset outside target: ${assetPath}`);
    }
    const status = lstatSync(next, { throwIfNoEntry: false });
    if (status?.isSymbolicLink()) {
      throw new TypeError(`refusing to follow an agent asset directory symlink: ${assetPath}`);
    }
    if (status !== undefined && !status.isDirectory()) {
      throw new TypeError(`refusing to use a non-directory agent asset path: ${assetPath}`);
    }
    if (status === undefined) mkdirSync(next);
    current = realpathSync(next);
    if (!inside(realBaseDir, current)) {
      throw new TypeError(`refusing to follow agent asset directory outside target: ${assetPath}`);
    }
  }
  const path = resolve(current, basename(assetPath));
  if (!inside(realBaseDir, path)) {
    throw new TypeError(`refusing to write agent asset outside target: ${assetPath}`);
  }
  return path;
}

function inside(realBaseDir: string, path: string): boolean {
  const relativePath = relative(realBaseDir, path);
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
