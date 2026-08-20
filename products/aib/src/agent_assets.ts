import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { AgentHostKind } from "./contracts.js";

export type AgentAssetKind = "instruction" | "command";

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

  const files: AgentAssetFile[] = [];
  const agentsHosts = selected.filter((host) => host === "codex" || host === "opencode" || host === "grok-build" || host === "cursor" || host === "other");
  if (agentsHosts.length > 0) {
    files.push(instruction(agentsHosts[0], "AGENTS.md", sharedBody(agentsHosts.map(displayName).join(", "))));
  }
  if (selected.includes("claude-code")) {
    files.push(instruction("claude-code", "CLAUDE.md", sharedBody("Claude Code")));
  }
  if (selected.includes("gemini")) {
    files.push(instruction("gemini", "GEMINI.md", sharedBody("Gemini CLI")));
  }
  if (selected.includes("opencode")) {
    files.push(command("opencode", ".opencode/commands/aib-bootstrap.md", opencodeCommandBody()));
  }
  return Object.freeze(files);
}

export function writeAgentAssetFiles(target: string, files: readonly AgentAssetFile[]): readonly { readonly path: string }[] {
  const baseDir = resolve(target);
  mkdirSync(baseDir, { recursive: true });
  const realBaseDir = realpathSync(baseDir);
  const written: { path: string }[] = [];
  for (const file of files) {
    const path = safeAssetPath(realBaseDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readAssetFile(path) : "";
    const next = file.kind === "instruction" ? mergeManagedInstruction(current, file.body) : file.body;
    if (current !== next) writeFileSync(path, next);
    written.push({ path });
  }
  return written;
}

function readAssetFile(path: string): string {
  if (lstatSync(path).isSymbolicLink()) {
    throw new TypeError(`refusing to write agent asset through a symlink: ${path}`);
  }
  return readFileSync(path, "utf8");
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
    if (!existsSync(next)) mkdirSync(next);
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

function command(host: AgentHostKind, path: string, body: string): AgentAssetFile {
  return {
    id: `${host}:aib-bootstrap-command`,
    host,
    path,
    kind: "command",
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

function displayName(host: AgentHostKind): string {
  if (host === "claude-code") return "Claude Code";
  if (host === "grok-build") return "Grok Build";
  if (host === "opencode") return "OpenCode";
  if (host === "codex") return "Codex";
  if (host === "cursor") return "Cursor";
  if (host === "gemini") return "Gemini CLI";
  return "Other agent harness";
}

function opencodeCommandBody(): string {
  return `---
description: Start or resume an aib bootstrap planning session.
---

Use \`aib\` as the planning state machine for this repository.

1. Run \`aib status --json\`; if state is missing, run \`aib init --agent opencode --json\`.
2. Run \`aib next --json\`.
3. Perform exactly the returned action: ask the human, inspect context, draft or validate specs, generate milestones, generate work-item drafts, render provider outputs, or stop.
4. Record human answers with \`aib answer --field <field> --value <answer> --json\`.
5. Keep implementation work out of Bootstrap planning until accepted work items exist.
6. For autoresearch requests, run \`qube autoresearch --help\`, translate natural language to \`<target>\` plus \`<goal>\`, and synthesize the arena before edits.

Do not install global commands or mutate providers unless the relevant \`aib\` command reports that mutation is planned and allowed.
`;
}
