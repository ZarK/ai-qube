import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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

export function createAgentAssetPlan(host: AgentHostKind | undefined): readonly AgentAssetFile[] {
  if (!host) return [];
  if (host === "codex") return [instruction("codex", "AGENTS.md", codexBody())];
  if (host === "opencode") {
    return [
      instruction("opencode", "AGENTS.md", opencodeBody()),
      command("opencode", ".opencode/commands/aib-bootstrap.md", opencodeCommandBody())
    ];
  }
  if (host === "claude-code") return [instruction("claude-code", "CLAUDE.md", claudeBody())];
  if (host === "gemini") return [instruction("gemini", "GEMINI.md", geminiBody())];
  return [instruction("other", "AGENTS.md", sharedBody("Generic agent host"))];
}

export function writeAgentAssetFiles(target: string, files: readonly AgentAssetFile[]): readonly { readonly path: string }[] {
  const baseDir = resolve(target);
  mkdirSync(baseDir, { recursive: true });
  const realBaseDir = realpathSync(baseDir);
  const written: { path: string }[] = [];
  for (const file of files) {
    const path = safeAssetPath(realBaseDir, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.body);
    written.push({ path });
  }
  return written;
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
- Do not install global commands, skills, hooks, or tools unless the human explicitly requests that separate action.

## ${hostName}

Use this file as the local host instruction surface. Host-specific todo or command tools are convenience surfaces; the durable workflow is the \`aib\` state machine.
`;
}

function codexBody(): string {
  return `${sharedBody("Codex")}
Codex should use its visible plan/todo support when useful, while keeping durable progress in \`aib\` state and provider records.
`;
}

function opencodeBody(): string {
  return `${sharedBody("OpenCode")}
OpenCode can use the local project command at \`.opencode/commands/aib-bootstrap.md\` to start or resume the bootstrap flow.
`;
}

function claudeBody(): string {
  return `${sharedBody("Claude Code")}
Claude Code should use its host todo tools when useful, while treating \`aib next --json\` as the source of truth for the next planning action.
`;
}

function geminiBody(): string {
  return `${sharedBody("Gemini CLI")}
Gemini CLI should keep conversation text concise and use the structured \`aib\` JSON output to decide when to ask, inspect, draft, generate, render, or stop.
`;
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

Do not install global commands or mutate providers unless the relevant \`aib\` command reports that mutation is planned and allowed.
`;
}
