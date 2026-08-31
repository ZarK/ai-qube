import { posix as pathPosix } from "node:path";

import { defineAgentHostProfile } from "@tjalve/qube-core";
import type {
  AgentHostProfile,
  AgentHostReviewAgentTarget,
  InstructionTarget,
  MakeItSoSurface,
} from "@tjalve/qube-core";

const CLAUDE_CODE_INSTRUCTION_PATH = "CLAUDE.md";
const CLAUDE_CODE_PROJECT_SETTINGS_PATH = ".claude/settings.json";
const CLAUDE_CODE_TODO_TOOLS = ["TodoWrite", "TodoRead"] as const;

const CLAUDE_INSTRUCTIONS: InstructionTarget = Object.freeze({
  id: "claude-instructions",
  path: CLAUDE_CODE_INSTRUCTION_PATH,
  description: "Always-loaded Executor instructions for Claude Code.",
});

const CLAUDE_MAKE_IT_SO_COMMAND: MakeItSoSurface = Object.freeze({
  id: "claude-make-it-so",
  path: pathPosix.join(".claude", "commands", "make-it-so.md"),
  description: "Claude Code project command that starts or resumes the autonomous Executor workflow.",
  kind: "command",
  invocation: "/make-it-so",
});

const CLAUDE_REVIEW_FOCUS_AGENT: AgentHostReviewAgentTarget = Object.freeze({
  id: "claude-review-focus-agent",
  path: ".claude/agents/qube-review-focus.md",
  description: "Claude Code read-only subagent for one focused local PR review lane.",
  renderer: "claude-review-focus-agent",
});

const CLAUDE_REVIEW_EXPLORER_AGENT: AgentHostReviewAgentTarget = Object.freeze({
  id: "claude-review-explorer-agent",
  path: ".claude/agents/qube-review-explorer.md",
  description: "Claude Code read-only economy subagent that reads and summarizes large texts for a review lane.",
  renderer: "claude-review-explorer-agent",
});

const CLAUDE_REVIEW_DIGEST_AGENT: AgentHostReviewAgentTarget = Object.freeze({
  id: "claude-review-digest-agent",
  path: ".claude/agents/qube-review-digest.md",
  description: "Claude Code read-only economy subagent that condenses diffs and test output for a review lane.",
  renderer: "claude-review-digest-agent",
});

const CLAUDE_REVIEW_LIBRARIAN_AGENT: AgentHostReviewAgentTarget = Object.freeze({
  id: "claude-review-librarian-agent",
  path: ".claude/agents/qube-review-librarian.md",
  description: "Claude Code read-only economy subagent that locates files, symbols, and prior review evidence for a review lane.",
  renderer: "claude-review-librarian-agent",
});

const CLAUDE_TASK_LIST = Object.freeze({
  support: "supported" as const,
  description: "Claude Code provides task-list tools in the main agent session.",
  tools: CLAUDE_CODE_TODO_TOOLS,
  fallback: "Use an explicit visible checklist if the host task-list tools are unavailable.",
  instruction: "For Claude Code, use `TodoWrite` and `TodoRead` or their current host-exposed equivalents directly from the main Claude Code agent. Do not delegate task-list operations to subagents.",
});

export const claudeCodeHostProfile = defineAgentHostProfile({
  id: "claude-code",
  displayName: "Claude Code",
  executables: Object.freeze({
    names: Object.freeze(["claude"]),
    windowsNames: Object.freeze(["claude.exe"]),
  }),
  instructionTarget: CLAUDE_INSTRUCTIONS,
  makeItSo: CLAUDE_MAKE_IT_SO_COMMAND,
  taskList: CLAUDE_TASK_LIST,
  review: Object.freeze({
    local: Object.freeze({
      support: "supported",
      description: "Claude Code can run a fresh read-only review subagent that returns one candidate lane result to the main session. The main session validates the result, writes evidence and provenance, and publishes provider feedback.",
      freshContext: true,
      readOnly: true,
      agents: Object.freeze([CLAUDE_REVIEW_FOCUS_AGENT, CLAUDE_REVIEW_EXPLORER_AGENT, CLAUDE_REVIEW_DIGEST_AGENT, CLAUDE_REVIEW_LIBRARIAN_AGENT]),
    }),
    isolated: Object.freeze({
      support: "unsupported",
      description: "QUBE has no tested Claude Code CLI invocation that combines fresh non-interactive execution, read-only isolation, and structured review output.",
      nextAction: "Use Claude Code native review subagents or select a host with a tested isolated review adapter.",
      freshContext: false,
      readOnly: false,
      agents: Object.freeze([]),
    }),
  }),
  modelDiscovery: Object.freeze({
    support: "unsupported",
    description: "Claude Code does not expose a non-interactive list of models available to the signed-in account.",
    nextAction: "Use Claude Code `/model` to inspect account choices. QUBE leaves the native review model unpinned.",
  }),
  umpire: Object.freeze({
    continuation: Object.freeze({
      support: "experimental",
      description: "A managed Claude Code Stop hook can emit a continuation prompt for current-issue recovery while Continuous Shipping is enabled.",
      nextAction: "Run `qube aiu init --tool claude-code`, review the settings change, and enable the Stop hook.",
      delivery: "stdout",
      currentIssueRecovery: true,
    }),
    probe: Object.freeze({
      support: "experimental",
      description: "QUBE can inspect Claude Code Umpire setup through AIU doctor.",
      nextAction: "Run `qube aiu doctor --json` and address any reported setup problems.",
      command: Object.freeze(["qube", "aiu", "doctor", "--json"] as const),
    }),
  }),
  trust: Object.freeze({
    required: true,
    description: "Claude Code must trust the project Stop hook before Umpire continuation can run.",
    actions: Object.freeze([
      Object.freeze({
        id: "review-claude-settings",
        kind: "review-files",
        description: "Review the managed Claude Code Stop hook before enabling it.",
        paths: Object.freeze([CLAUDE_CODE_PROJECT_SETTINGS_PATH]),
      }),
      Object.freeze({
        id: "enable-claude-hook",
        kind: "approve",
        description: "Enable or approve the Claude Code project Stop hook.",
      }),
    ]),
  }),
  subagents: Object.freeze({
    support: "supported",
    description: "Claude Code supports bounded native subagents with separate task context.",
    instruction: "Use Claude Code subagents only for bounded support work; keep issue workflow todos in the main session.",
  }),
} satisfies AgentHostProfile);

export { claudeCodeContinuationAdapter, claudeCodeContinuationDeclaration } from "./continuation.js";
