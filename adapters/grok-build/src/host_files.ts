import { posix as pathPosix } from "node:path";

import { grokBuildStopHookFile } from "./stop_hook.js";

export interface GrokBuildHostFile {
  readonly id: string;
  readonly kind: "instruction" | "command" | "skill" | "subagent" | "hook";
  readonly source: "aie" | "aiu";
  readonly description: string;
  readonly path: string;
  readonly required: boolean;
}

export const grokBuildHostFiles: readonly GrokBuildHostFile[] = Object.freeze([
  Object.freeze({
    id: "grok-instructions",
    kind: "instruction",
    source: "aie",
    description: "Always-loaded Grok Build instructions.",
    path: "AGENTS.md",
    required: true,
  }),
  Object.freeze({
    id: "grok-make-it-so",
    kind: "command",
    source: "aie",
    description: "Grok Build make-it-so project command.",
    path: pathPosix.join(".grok", "commands", "make-it-so.md"),
    required: true,
  }),
  Object.freeze({
    id: "grok-make-it-so-skill",
    kind: "skill",
    source: "aie",
    description: "Grok Build make-it-so skill.",
    path: pathPosix.join(".grok", "skills", "make-it-so", "SKILL.md"),
    required: true,
  }),
  Object.freeze({
    id: "grok-review-focus",
    kind: "subagent",
    source: "aie",
    description: "Grok Build review-focus subagent.",
    path: pathPosix.join(".grok", "agents", "qube-review-focus.md"),
    required: false,
  }),
  Object.freeze({
    id: "grok-review-explorer",
    kind: "subagent",
    source: "aie",
    description: "Grok Build review-explorer subagent.",
    path: pathPosix.join(".grok", "agents", "qube-review-explorer.md"),
    required: false,
  }),
  Object.freeze({
    id: "grok-review-digest",
    kind: "subagent",
    source: "aie",
    description: "Grok Build review-digest subagent.",
    path: pathPosix.join(".grok", "agents", "qube-review-digest.md"),
    required: false,
  }),
  Object.freeze({
    id: "grok-review-librarian",
    kind: "subagent",
    source: "aie",
    description: "Grok Build review-librarian subagent.",
    path: pathPosix.join(".grok", "agents", "qube-review-librarian.md"),
    required: false,
  }),
  Object.freeze({
    id: "grok-stop-hook",
    kind: "hook",
    source: "aiu",
    description: "Grok Build AI Umpire Stop hook.",
    path: grokBuildStopHookFile.relativePath,
    required: true,
  }),
]);
