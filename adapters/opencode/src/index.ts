import { posix as pathPosix } from "node:path";

import { defineAgentHostProfile } from "@tjalve/qube-core";
import type {
  AgentHostModelDiscoveryContext,
  AgentHostProfile,
  AgentHostReviewAgentTarget,
  InstructionTarget,
  MakeItSoSurface,
} from "@tjalve/qube-core";

const OPENCODE_TODO_TOOLS = ["todowrite", "todoread"] as const;

const OPENCODE_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "agents-instructions",
  path: "AGENTS.md",
  description: "Always-loaded Executor instructions for OpenCode.",
});

const OPENCODE_MAKE_IT_SO: MakeItSoSurface = Object.freeze({
  id: "opencode-make-it-so",
  path: pathPosix.join(".opencode", "commands", "make-it-so.md"),
  description: "OpenCode project command that starts or resumes the autonomous Executor workflow.",
  kind: "command",
  invocation: "/make-it-so",
});

const OPENCODE_REVIEW_TARGETS: readonly AgentHostReviewAgentTarget[] = Object.freeze([
  Object.freeze({
    id: "opencode-review-focus-agent",
    path: pathPosix.join(".opencode", "agent", "qube-review-focus.md"),
    description: "OpenCode read-only subagent for one focused local PR review lane.",
    renderer: "opencode-review-focus-agent",
  }),
  Object.freeze({
    id: "opencode-review-explorer-agent",
    path: pathPosix.join(".opencode", "agent", "qube-review-explorer.md"),
    description: "OpenCode read-only economy subagent that reads and summarizes large texts for a review lane.",
    renderer: "opencode-review-explorer-agent",
  }),
  Object.freeze({
    id: "opencode-review-digest-agent",
    path: pathPosix.join(".opencode", "agent", "qube-review-digest.md"),
    description: "OpenCode read-only economy subagent that condenses diffs and test output for a review lane.",
    renderer: "opencode-review-digest-agent",
  }),
  Object.freeze({
    id: "opencode-review-librarian-agent",
    path: pathPosix.join(".opencode", "agent", "qube-review-librarian.md"),
    description: "OpenCode read-only economy subagent that locates files, symbols, and prior review evidence for a review lane.",
    renderer: "opencode-review-librarian-agent",
  }),
]);

const OPENCODE_TASK_LIST = Object.freeze({
  support: "supported" as const,
  description: "OpenCode provides task-list tools in the main agent session.",
  tools: OPENCODE_TODO_TOOLS,
  fallback: "Use a visible checklist only if the host task-list tools are unavailable.",
  instruction: "For OpenCode, use `todowrite` and `todoread` directly from the main agent for local issue tasks. Never ask a Task or subagent to create, read, or complete tasks.",
});

export function parseOpenCodeModelCatalog(output: string): string[] | null {
  const models: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const candidate = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:@+/-]*$/.test(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    models.push(candidate);
  }
  return models.length > 0 ? models : null;
}

export const opencodeHostProfile = defineAgentHostProfile({
  id: "opencode",
  displayName: "OpenCode",
  executables: Object.freeze({
    names: Object.freeze(["opencode"]),
    windowsNames: Object.freeze(["opencode.exe"]),
  }),
  instructionTarget: OPENCODE_INSTRUCTIONS,
  makeItSo: OPENCODE_MAKE_IT_SO,
  taskList: OPENCODE_TASK_LIST,
  review: Object.freeze({
    local: Object.freeze({
      support: "supported",
      description: "OpenCode can run a fresh source-read-only review subagent that writes only named review evidence and invokes QUBE's configured publisher.",
      freshContext: true,
      readOnly: false,
      agents: OPENCODE_REVIEW_TARGETS,
    }),
    isolated: Object.freeze({
      support: "unsupported",
      description: "QUBE has no tested OpenCode CLI invocation that combines fresh non-interactive execution, read-only isolation, and structured review output.",
      nextAction: "Use an OpenCode native review subagent or select a host with a tested isolated review adapter.",
      freshContext: false,
      readOnly: false,
      agents: Object.freeze([]),
    }),
  }),
  modelDiscovery: Object.freeze({
    support: "supported",
    description: "OpenCode lists the models available to the signed-in user through its live CLI catalog.",
    listModels({ executable, prefixArgs, runCommand }: AgentHostModelDiscoveryContext) {
      return parseOpenCodeModelCatalog(runCommand(executable, [...prefixArgs, "models"]));
    },
  }),
  umpire: Object.freeze({
    continuation: Object.freeze({
      support: "supported",
      description: "The managed OpenCode plugin can deliver a continuation prompt for current-issue recovery while Continuous Shipping is enabled.",
      nextAction: "Run `qube aiu init --tool opencode`, review the plugin wrapper, and trust the project plugin.",
      delivery: "host",
      currentIssueRecovery: true,
    }),
    probe: Object.freeze({
      support: "supported",
      description: "QUBE can inspect OpenCode Umpire setup through AIU doctor.",
      nextAction: "Run `qube aiu doctor --json` and address any reported setup problems.",
      command: Object.freeze(["qube", "aiu", "doctor", "--json"] as const),
    }),
  }),
  trust: Object.freeze({
    required: true,
    description: "OpenCode must trust the managed project plugin before Umpire continuation can run.",
    actions: Object.freeze([
      Object.freeze({
        id: "review-opencode-plugin",
        kind: "review-files",
        description: "Review the managed OpenCode Umpire plugin wrapper.",
        paths: Object.freeze([".opencode/plugins/ai-umpire-continuation.ts"]),
      }),
      Object.freeze({
        id: "trust-opencode-plugin",
        kind: "approve",
        description: "Enable or trust the OpenCode project plugin.",
      }),
    ]),
  }),
  subagents: Object.freeze({
    support: "supported",
    description: "OpenCode supports bounded native subagents, including user-started local review subagents.",
    instruction: "Use OpenCode subagents for bounded support work. Keep issue workflow tasks in the main session.",
  }),
} satisfies AgentHostProfile);
