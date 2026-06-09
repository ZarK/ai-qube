import { resolve } from "node:path";

import { createDryRunPlan, type DryRunPlan } from "@tjalve/qube-cli/mutation";

import type { AibConfig, LoadedAibConfig } from "./config.js";
import { createInitialSession, type BootstrapSession } from "./session.js";

export interface InitPlan {
  readonly target: string;
  readonly configPath?: string;
  readonly config: AibConfig;
  readonly sessionPath: string;
  readonly session: BootstrapSession;
  readonly plannedDocuments: readonly string[];
  readonly dryRunPlan: DryRunPlan;
}

export function createInitPlan(input: {
  readonly target: string | undefined;
  readonly loadedConfig: LoadedAibConfig;
  readonly idea: string | undefined;
}): InitPlan {
  const target = resolve(input.target && input.target.length > 0 ? input.target : ".");
  const config = input.loadedConfig.config;
  const stateDir = config.paths?.stateDir ?? ".bootstrap";
  const docsDir = config.paths?.docsDir ?? "docs";
  const specPath = config.paths?.specPath ?? `${docsDir}/spec.md`;
  const milestonesDir = config.paths?.milestonesDir ?? `${docsDir}/milestones`;
  const issuesDir = config.paths?.issuesDir ?? `${docsDir}/issues`;
  const sessionPath = `${target}/${stateDir}/session.json`;
  const session = createInitialSession(config, input.idea);
  const plannedDocuments = [
    `${target}/${stateDir}/session.json`,
    `${target}/${specPath}`,
    `${target}/${milestonesDir}/`,
    `${target}/${issuesDir}/`
  ];

  return {
    target,
    ...(input.loadedConfig.path ? { configPath: input.loadedConfig.path } : {}),
    config,
    sessionPath,
    session,
    plannedDocuments,
    dryRunPlan: createDryRunPlan({
      command: "aib init",
      summary: "Prepare a local bootstrap planning workspace for an AI agent without changing files.",
      mutationCategories: ["local-files", "local-config"],
      steps: [
        {
          action: "read",
          target: input.loadedConfig.path ?? `${target}/aib.config.json`,
          category: "local-config",
          description: "Load project bootstrap defaults when a config path is provided."
        },
        {
          action: "write",
          target: sessionPath,
          category: "local-files",
          description: "Create versioned bootstrap session state for agent-guided discovery."
        },
        {
          action: "write",
          target: `${target}/${specPath}`,
          category: "local-files",
          description: "Create the project specification document after high-level discovery."
        }
      ],
      rerunCommand: "aib init --dry-run"
    })
  };
}
