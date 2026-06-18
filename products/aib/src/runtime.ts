import { createCliError } from "@tjalve/qube-cli/errors";
import { createDryRunPlanFields, renderDryRunPlan } from "@tjalve/qube-cli/mutation";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "@tjalve/qube-cli/runtime";
import { dirname } from "node:path";

import { loadAibConfig } from "./config.js";
import { createInitPlan } from "./init.js";
import {
  answerCommand,
  bootstrapRegistry,
  initCommand,
  milestonesGenerateCommand,
  nextCommand,
  planningTopic,
  specAcceptCommand,
  specDraftCommand,
  specReopenCommand,
  specValidateCommand,
  statusCommand,
  workItemsGenerateCommand
} from "./metadata.js";
import { createMilestoneDrafts, milestoneDocsExist, writeMilestoneDrafts } from "./milestones.js";
import type { MilestoneDraftResult } from "./milestones.js";
import { packageJson } from "./package.js";
import {
  AnswerError,
  applyAnswer,
  computeNextAction,
  computeSpecStatus,
  isAgentHost,
  readBootstrapState,
  writeBootstrapState,
  type BootstrapState
} from "./state.js";
import { createSpecDraft, requiredSpecSectionIds, specFileExists, validateSpecFile, writeSpecDraft } from "./spec.js";
import type { SpecChapterId } from "./spec_chapters.js";

let runtimeRegistry = bootstrapRegistry;

export const aibCli = createCli({
  bin: "aib",
  packageName: packageJson.name,
  packageVersion: packageJson.version,
  description: packageJson.description,
  registry: bootstrapRegistry,
  topics: [createTopicCommand(planningTopic)],
  commands: [
    createCommand(initCommand, ({ args, flags }) => {
      let loadedConfig;
      try {
        loadedConfig = loadAibConfig(typeof flags.config === "string" ? flags.config : undefined);
      } catch (error) {
        throw createCliError({
          command: "init",
          kind: "init-config-invalid",
          operation: "load bootstrap config",
          likelyCause: error instanceof Error ? error.message : "The bootstrap config could not be parsed.",
          suggestedNextAction: "Provide a valid aib.config.json with version 1 or omit --config to use defaults.",
          category: "validation",
          exitCode: 3
        });
      }

      const agentHost = typeof flags.agent === "string" && isAgentHost(flags.agent) ? flags.agent : undefined;
      const config = agentHost
        ? { ...loadedConfig.config, agent: { ...loadedConfig.config.agent, host: agentHost } }
        : loadedConfig.config;
      const plan = createInitPlan({
        target: typeof args.target === "string" ? args.target : undefined,
        loadedConfig: { ...loadedConfig, config },
        idea: typeof flags.idea === "string" ? flags.idea : undefined
      });

      try {
        if (flags["dry-run"] !== true) {
          const written = writeBootstrapState(plan.sessionPath, plan.state);
          const nextAction = computeNextAction(written.state);
          return {
            json: {
              mutated: true,
              statePath: written.statePath,
              state: written.state,
              phase: written.state.phase,
              nextAction,
              nextCommand: "aib next --json"
            },
            human: `Initialized bootstrap state at ${written.statePath}.\nNext action: ${nextAction.summary}\n`
          };
        }

        return {
          json: {
            ...createDryRunPlanFields(plan.dryRunPlan),
            mutated: false,
            target: plan.target,
            configPath: plan.configPath,
            config: plan.config,
            sessionPath: plan.sessionPath,
            plannedDocuments: plan.plannedDocuments,
            session: plan.session,
            state: plan.state,
            nextAction: computeNextAction(plan.state)
          },
          human: `${renderDryRunPlan(plan.dryRunPlan)}State file not changed.\nAgent next action: ${plan.session.nextAction.prompt}\n`
        };
      } catch (error) {
        throw createCliError({
          command: "init",
          kind: "init-write-failed",
          operation: "write bootstrap state",
          likelyCause: error instanceof Error ? error.message : "The bootstrap state file could not be written.",
          suggestedNextAction: "Check filesystem permissions and the target path, then rerun aib init --json.",
          category: "runtime",
          exitCode: 3
        });
      }
    }),
    createCommand(statusCommand, ({ flags }) => {
      try {
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".bootstrap/session.json");
        const nextAction = computeNextAction(envelope.state);
        const spec = computeSpecStatus(envelope.state);
        const projectRoot = projectRootForState(envelope.statePath);
        const validation = specFileExists(envelope.state, projectRoot) ? validateSpecFile(envelope.state, projectRoot) : undefined;
        return {
          json: {
            statePath: envelope.statePath,
            phase: envelope.state.phase,
            missingDecisions: nextAction.missingDecisions,
            artifacts: envelope.state.artifacts,
            spec,
            specValidation: validation,
            nextCommand: nextAction.nextCommand,
            nextAction
          },
          human: `Phase: ${envelope.state.phase}\nMissing decisions: ${nextAction.missingDecisions.length}\nNext command: ${nextAction.nextCommand ?? "none"}\n`
        };
      } catch (error) {
        throw stateError("status", error);
      }
    }),
    createCommand(nextCommand, ({ flags }) => {
      try {
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".bootstrap/session.json");
        const nextAction = computeNextAction(envelope.state);
        return {
          json: {
            statePath: envelope.statePath,
            phase: envelope.state.phase,
            nextAction
          },
          human: `${nextAction.summary}\n${nextAction.nextCommand ? `Next command: ${nextAction.nextCommand}\n` : ""}`
        };
      } catch (error) {
        throw stateError("next", error);
      }
    }),
    createCommand(answerCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const envelope = readBootstrapState(statePath);
        const updated = applyAnswer(
          envelope.state,
          typeof flags.field === "string" ? flags.field : "",
          typeof flags.value === "string" ? flags.value : "",
          flags.assumption === true
        );
        if (flags["dry-run"] === true) {
          const nextAction = computeNextAction(updated);
          return {
            json: {
              mutated: false,
              dryRun: true,
              statePath: envelope.statePath,
              phase: updated.phase,
              state: updated,
              nextAction
            },
            human: `Dry run: would record answer in ${envelope.statePath}.\nNext action: ${nextAction.summary}\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        const nextAction = computeNextAction(written.state);
        return {
          json: {
            mutated: true,
            statePath: written.statePath,
            phase: written.state.phase,
            state: written.state,
            nextAction
          },
          human: `Recorded answer in ${written.statePath}.\nNext action: ${nextAction.summary}\n`
        };
      } catch (error) {
        if (error instanceof AnswerError) throw answerError(error);
        throw stateError("answer", error);
      }
    }),
    createCommand(specDraftCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const envelope = readBootstrapState(statePath);
        const projectRoot = projectRootForState(envelope.statePath);
        const draft = flags["dry-run"] === true ? createSpecDraft(envelope.state, projectRoot) : writeSpecDraft(envelope.state, projectRoot);
        const updated = withSpecDraftState(envelope.state, draft.unresolvedGaps);
        if (flags["dry-run"] === true) {
          const nextAction = computeNextAction(updated);
          return {
            json: {
              mutated: false,
              dryRun: true,
              statePath: envelope.statePath,
              specPath: draft.specPath,
              content: draft.content,
              chapters: draft.chapters,
              unresolvedGaps: draft.unresolvedGaps,
              state: updated,
              nextAction
            },
            human: `Dry run: would draft spec at ${draft.specPath}.\nNext action: ${computeNextAction(updated).summary}\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        const nextAction = computeNextAction(written.state);
        return {
          json: {
            mutated: true,
            statePath: written.statePath,
            specPath: draft.specPath,
            chapters: draft.chapters,
            unresolvedGaps: draft.unresolvedGaps,
            state: written.state,
            nextAction
          },
          human: `Drafted spec at ${draft.specPath}.\nNext action: ${nextAction.summary}\n`
        };
      } catch (error) {
        throw stateError("spec draft", error);
      }
    }),
    createCommand(specValidateCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const envelope = readBootstrapState(statePath);
        const validation = validateSpecFile(envelope.state, projectRootForState(envelope.statePath));
        const updated = withSpecValidationState(envelope.state, validation);
        if (flags["dry-run"] === true) {
          return {
            json: {
              mutated: false,
              dryRun: true,
              statePath: envelope.statePath,
              validation,
              state: updated,
              nextAction: computeNextAction(updated)
            },
            human: `Dry run: spec validation ${validation.ok ? "passed" : "failed"}.\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            mutated: true,
            statePath: written.statePath,
            validation,
            state: written.state,
            nextAction: computeNextAction(written.state)
          },
          human: `Spec validation ${validation.ok ? "passed" : "failed"}.\n`
        };
      } catch (error) {
        throw stateError("spec validate", error);
      }
    }),
    createCommand(specAcceptCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const section = typeof flags.section === "string" ? flags.section : "";
        const envelope = readBootstrapState(statePath);
        const validation = validateSpecFile(envelope.state, projectRootForState(envelope.statePath));
        if (!validation.ok) {
          throw specValidationError(validation);
        }
        const updated = withAcceptedSpecState(envelope.state, section, validation);
        if (flags["dry-run"] === true) {
          return {
            json: {
              mutated: false,
              dryRun: true,
              statePath: envelope.statePath,
              section,
              state: updated,
              spec: computeSpecStatus(updated),
              nextAction: computeNextAction(updated)
            },
            human: `Dry run: would accept spec section ${section}.\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            mutated: true,
            statePath: written.statePath,
            section,
            state: written.state,
            spec: computeSpecStatus(written.state),
            nextAction: computeNextAction(written.state)
          },
          human: `Accepted spec section ${section}.\n`
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("spec accept", error);
      }
    }),
    createCommand(specReopenCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const section = typeof flags.section === "string" ? flags.section : "";
        const envelope = readBootstrapState(statePath);
        const updated = withReopenedSpecState(envelope.state, section);
        if (flags["dry-run"] === true) {
          return {
            json: {
              mutated: false,
              dryRun: true,
              statePath: envelope.statePath,
              section,
              state: updated,
              spec: computeSpecStatus(updated),
              nextAction: computeNextAction(updated)
            },
            human: `Dry run: would reopen spec section ${section}.\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            mutated: true,
            statePath: written.statePath,
            section,
            state: written.state,
            spec: computeSpecStatus(written.state),
            nextAction: computeNextAction(written.state)
          },
          human: `Reopened spec section ${section}.\n`
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("spec reopen", error);
      }
    }),
    createCommand(milestonesGenerateCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".bootstrap/session.json";
        const envelope = readBootstrapState(statePath);
        const projectRoot = projectRootForState(envelope.statePath);
        const validation = validateSpecFile(envelope.state, projectRoot);
        const spec = computeSpecStatus(envelope.state);
        if (!validation.ok || !spec.canGenerateMilestones || envelope.state.artifacts.spec.status !== "accepted") {
          throw createCliError({
            command: "milestones generate",
            kind: "spec-not-accepted",
            operation: "guard milestone generation",
            likelyCause: `Spec validation ok: ${validation.ok}. Missing accepted sections: ${spec.missingRequiredAcceptance.join(", ") || "none"}.`,
            suggestedNextAction: "Run aib spec validate --json, then accept each required section with aib spec accept --section <id> --json.",
            category: "validation",
            exitCode: 3
          });
        }
        const result = flags["dry-run"] === true
          ? createMilestoneDrafts(envelope.state, projectRoot)
          : writeMilestoneDrafts(envelope.state, projectRoot);
        const updated = withMilestoneDraftState(envelope.state, result);
        if (flags["dry-run"] === true) {
          return {
            json: {
              mutated: false,
              dryRun: true,
              allowed: true,
              statePath: envelope.statePath,
              spec,
              validation,
              milestoneDir: result.milestoneDir,
              milestones: result.milestones,
              recommendation: result.recommendation,
              state: updated,
              nextAction: computeNextAction(updated)
            },
            human: `Dry run: would draft ${result.milestones.length} milestone docs.\n${result.recommendation}\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            mutated: true,
            allowed: true,
            statePath: written.statePath,
            spec,
            validation,
            milestoneDir: result.milestoneDir,
            milestones: result.milestones,
            recommendation: result.recommendation,
            state: written.state,
            nextAction: computeNextAction(written.state)
          },
          human: `Drafted ${result.milestones.length} milestone docs.\n${result.recommendation}\n`
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("milestones generate", error);
      }
    }),
    createCommand(workItemsGenerateCommand, ({ flags }) => {
      try {
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".bootstrap/session.json");
        const projectRoot = projectRootForState(envelope.statePath);
        if (!milestoneDocsExist(envelope.state, projectRoot)) {
          throw createCliError({
            command: "work-items generate",
            kind: "milestone-required",
            operation: "guard work-item generation",
            likelyCause: "No generated milestone docs are recorded and readable in bootstrap state.",
            suggestedNextAction: "Run aib milestones generate --json after accepting the spec, then rerun work-item generation.",
            category: "validation",
            exitCode: 3
          });
        }
        return {
          json: {
            allowed: true,
            statePath: envelope.statePath,
            milestone: typeof flags.milestone === "string" ? flags.milestone : undefined,
            milestones: envelope.state.planning.milestoneDrafts,
            nextAction: {
              kind: "generate_artifacts",
              actor: "agent",
              summary: "Milestone docs exist. Work-item drafting can proceed from a selected milestone."
            }
          },
          human: "Milestone docs exist. Work-item generation may proceed.\n"
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("work-items generate", error);
      }
    }),
    createSchemaCommand({
      registry: () => runtimeRegistry,
      bin: "aib",
      packageName: packageJson.name,
      packageVersion: packageJson.version
    })
  ]
});

runtimeRegistry = aibCli.registry;

export async function runAibCli(input: readonly string[]): Promise<number> {
  const result = await runCli(aibCli, input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode === 0 ? process.exitCode : result.exitCode;
  return result.exitCode;
}

function stateError(command: string, error: unknown): ReturnType<typeof createCliError> {
  return createCliError({
    command,
    kind: "state-invalid",
    operation: `load bootstrap state for ${command}`,
    likelyCause: error instanceof Error ? error.message : "The bootstrap state could not be read or validated.",
    suggestedNextAction: "Run aib init --idea \"...\" --json to create fresh state, or fix the state file path passed with --state.",
    category: "validation",
    exitCode: 3
  });
}

function answerError(error: AnswerError): ReturnType<typeof createCliError> {
  return createCliError({
    command: "answer",
    kind: error.kind,
    operation: "record bootstrap answer",
    likelyCause: error.message,
    suggestedNextAction: error.kind === "answer-transition-invalid"
      ? "Run aib status --json and follow the next action for the current phase instead of recording an answer."
      : "Use a field returned by aib next --json and provide a non-empty answer value.",
    category: "validation",
    exitCode: 3
  });
}

function withSpecDraftState(state: BootstrapState, unresolvedGaps: readonly string[]): BootstrapState {
  const updated: BootstrapState = {
    ...state,
    phase: "spec_acceptance",
    spec: {
      ...state.spec,
      acceptedSectionIds: [],
      reopenedSectionIds: [],
      unresolvedGaps,
      revision: state.spec.revision + 1,
      validation: undefined
    },
    artifacts: {
      ...state.artifacts,
      spec: {
        ...state.artifacts.spec,
        status: "draft"
      }
    }
  };
  return withPlanningNext(updated);
}

function withSpecValidationState(
  state: BootstrapState,
  validation: { ok: boolean; missingRequiredSections: readonly string[]; placeholderSections: readonly string[] }
): BootstrapState {
  const updated: BootstrapState = {
    ...state,
    phase: "spec_acceptance",
    spec: {
      ...state.spec,
      validation: {
        ok: validation.ok,
        missingRequiredSections: validation.missingRequiredSections,
        placeholderSections: validation.placeholderSections
      }
    },
    artifacts: {
      ...state.artifacts,
      spec: {
        ...state.artifacts.spec,
        status: validation.ok ? "ready" : "blocked"
      }
    }
  };
  return withPlanningNext(updated);
}

function withAcceptedSpecState(
  state: BootstrapState,
  section: string,
  validation: { ok: boolean; missingRequiredSections: readonly string[]; placeholderSections: readonly string[] }
): BootstrapState {
  const required = requiredSpecSectionIds(state);
  const acceptedSectionIds = section === "all" ? required : acceptOneSection(state, required, section);
  const acceptedSet = new Set(acceptedSectionIds);
  const reopenedSectionIds = state.spec.reopenedSectionIds.filter((id) => !acceptedSet.has(id));
  const allRequiredAccepted = required.every((id) => acceptedSet.has(id));
  const updated: BootstrapState = {
    ...state,
    phase: allRequiredAccepted ? "milestone_generation" : "spec_acceptance",
    spec: {
      ...state.spec,
      acceptedSectionIds,
      reopenedSectionIds,
      validation: {
        ok: validation.ok,
        missingRequiredSections: validation.missingRequiredSections,
        placeholderSections: validation.placeholderSections
      }
    },
    artifacts: {
      ...state.artifacts,
      spec: {
        ...state.artifacts.spec,
        status: allRequiredAccepted ? "accepted" : "ready"
      }
    }
  };
  return withPlanningNext(updated);
}

function withReopenedSpecState(state: BootstrapState, section: string): BootstrapState {
  const selected = new Set(requiredSpecSectionIds(state));
  if (!selected.has(section as SpecChapterId)) {
    throw createCliError({
      command: "spec reopen",
      kind: "spec-section-invalid",
      operation: "reopen spec section",
      likelyCause: `Spec section "${section}" is not a selected required section.`,
      suggestedNextAction: "Run aib status --json and choose one of spec.chapters where required is true.",
      category: "validation",
      exitCode: 3
    });
  }
  if (!state.spec.acceptedSectionIds.includes(section)) {
    throw createCliError({
      command: "spec reopen",
      kind: "spec-section-invalid",
      operation: "reopen spec section",
      likelyCause: `Spec section "${section}" is not currently accepted.`,
      suggestedNextAction: "Accept the section first with aib spec accept --section <id> --json.",
      category: "validation",
      exitCode: 3
    });
  }
  const updated: BootstrapState = {
    ...state,
    phase: "spec_acceptance",
    spec: {
      ...state.spec,
      acceptedSectionIds: state.spec.acceptedSectionIds.filter((id) => id !== section),
      reopenedSectionIds: state.spec.reopenedSectionIds.includes(section)
        ? state.spec.reopenedSectionIds
        : [...state.spec.reopenedSectionIds, section],
      revision: state.spec.revision + 1
    },
    artifacts: {
      ...state.artifacts,
      spec: {
        ...state.artifacts.spec,
        status: "draft"
      }
    }
  };
  return withPlanningNext(updated);
}

function withMilestoneDraftState(state: BootstrapState, result: MilestoneDraftResult): BootstrapState {
  const updated: BootstrapState = {
    ...state,
    phase: "work_item_generation",
    artifacts: {
      ...state.artifacts,
      milestones: result.artifacts,
      workItems: state.artifacts.workItems.length > 0 ? state.artifacts.workItems : []
    },
    planning: {
      ...state.planning,
      milestoneDrafts: result.milestones
    }
  };
  return withPlanningNext(updated);
}

function acceptOneSection(
  state: BootstrapState,
  required: readonly SpecChapterId[],
  section: string
): readonly string[] {
  if (!required.includes(section as SpecChapterId)) {
    throw createCliError({
      command: "spec accept",
      kind: "spec-section-invalid",
      operation: "accept spec section",
      likelyCause: `Spec section "${section}" is not a selected required section.`,
      suggestedNextAction: "Run aib status --json and choose one of spec.chapters where required is true, or pass --section all.",
      category: "validation",
      exitCode: 3
    });
  }
  return state.spec.acceptedSectionIds.includes(section)
    ? state.spec.acceptedSectionIds
    : [...state.spec.acceptedSectionIds, section];
}

function withPlanningNext(state: BootstrapState): BootstrapState {
  return {
    ...state,
    planning: {
      ...state.planning,
      artifacts: state.artifacts,
      nextAction: computeNextAction(state)
    }
  };
}

function specValidationError(validation: {
  readonly missingRequiredSections: readonly string[];
  readonly placeholderSections: readonly string[];
}): ReturnType<typeof createCliError> {
  return createCliError({
    command: "spec accept",
    kind: "spec-validation-failed",
    operation: "accept spec section",
    likelyCause: `Missing sections: ${validation.missingRequiredSections.join(", ") || "none"}. Placeholder sections: ${validation.placeholderSections.join(", ") || "none"}.`,
    suggestedNextAction: "Revise docs/spec.md, run aib spec validate --json, then accept reviewed sections.",
    category: "validation",
    exitCode: 3
  });
}

function isCliSpecError(error: unknown): error is ReturnType<typeof createCliError> {
  return typeof error === "object" && error !== null && "kind" in error && "exitCode" in error;
}

function projectRootForState(statePath: string): string {
  return dirname(dirname(statePath));
}
