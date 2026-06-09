import type { AibConfig } from "./config.js";

export interface BootstrapSession {
  readonly version: 1;
  readonly createdBy: "@tjalve/aib";
  readonly stage: "spec-discovery";
  readonly project: {
    readonly name?: string;
    readonly intent?: string;
    readonly privacy?: string;
  };
  readonly agent: {
    readonly host?: string;
    readonly questionBudget: number;
  };
  readonly documents: {
    readonly specPath: string;
    readonly milestoneDir: string;
    readonly issueDir: string;
  };
  readonly safety: {
    readonly dryRunRequired: boolean;
    readonly allowNetwork: boolean;
  };
  readonly nextAction: {
    readonly actor: "agent";
    readonly prompt: string;
    readonly questionBudget: number;
  };
}

export function createInitialSession(config: AibConfig, idea: string | undefined): BootstrapSession {
  const docsDir = config.paths?.docsDir ?? "docs";
  const questionBudget = config.agent?.questionBudget ?? 3;
  const specPath = config.paths?.specPath ?? `${docsDir}/spec.md`;
  const milestoneDir = config.paths?.milestonesDir ?? `${docsDir}/milestones`;
  const issueDir = config.paths?.issuesDir ?? `${docsDir}/issues`;
  return {
    version: 1,
    createdBy: "@tjalve/aib",
    stage: "spec-discovery",
    project: {
      ...(config.project?.name ? { name: config.project.name } : {}),
      ...(idea ? { intent: idea } : {}),
      ...(config.project?.privacy ? { privacy: config.project.privacy } : {})
    },
    agent: {
      ...(config.agent?.host ? { host: config.agent.host } : {}),
      questionBudget
    },
    documents: {
      specPath,
      milestoneDir,
      issueDir
    },
    safety: {
      dryRunRequired: config.safety?.dryRunRequired ?? true,
      allowNetwork: config.safety?.allowNetwork ?? false
    },
    nextAction: {
      actor: "agent",
      prompt: "Ask the human for product intent and project shape before going deeper.",
      questionBudget
    }
  };
}
