import { createCliError } from "@tjalve/qube-cli/errors";
import { createDryRunPlanFields, renderDryRunPlan } from "@tjalve/qube-cli/mutation";
import { createJsonErrorEnvelope, renderJsonLine } from "@tjalve/qube-cli/output";
import { redactStructuredValue } from "@tjalve/qube-cli/redaction";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "@tjalve/qube-cli/runtime";
import { basename, dirname } from "node:path";

import { synthesizeAutoresearchArena } from "./arena.js";
import { loadAibConfig } from "./config.js";
import { applyInitPlan, createInitPlan, type InitPlan } from "./init.js";
import {
  answerCommand,
  arenaSynthesizeCommand,
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
  workItemsGenerateCommand,
  workItemsRenderCommand
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
import { WorkItemLintError } from "./work_item_lint.js";
import { createWorkItemDrafts, renderWorkItemDrafts, WorkItemQueueOrderError, writeRenderedMarkdownWorkItems, writeWorkItemDrafts } from "./work_items.js";
import type { RenderedMarkdownWorkItem, WorkItemDraftResult, WorkItemRenderProvider, WorkItemRenderResult } from "./work_items.js";

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
        loadedConfig = loadAibConfig(typeof flags.config === "string" ? flags.config : undefined, {
          startDir: typeof args.target === "string" ? args.target : ".",
        });
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
      const agentSurfaces = parseAgentSurfaces(flags.surfaces);
      const config = agentHost || agentSurfaces
        ? {
            ...loadedConfig.config,
            agent: {
              ...loadedConfig.config.agent,
              ...(agentHost ? { host: agentHost } : {}),
              ...(agentSurfaces ? { surfaces: agentSurfaces } : {})
            }
          }
        : loadedConfig.config;
      const fieldSources = {
        ...loadedConfig.fieldSources,
        ...(agentHost ? { "agent.host": "explicit" as const } : {}),
        ...(agentSurfaces ? { "agent.surfaces": "explicit" as const } : {}),
      };
      const plan = createInitPlan({
        target: typeof args.target === "string" ? args.target : undefined,
        loadedConfig: { ...loadedConfig, config, fieldSources },
        idea: typeof flags.idea === "string" ? flags.idea : undefined
      });

      try {
        const result = flags["dry-run"] === true
          ? { ...plan, mutated: false, written: [] as const }
          : applyInitPlan(plan);
        if (!result.ok) {
          const error = initConflictError(result);
          return {
            exitCode: error.exitCode,
            human: `Bootstrap init found conflicts.\n${result.conflicts.map((conflict) => `- ${conflict.path}: ${conflict.reason}`).join("\n")}\n`,
            jsonStdout: renderJsonLine({
              ...createJsonErrorEnvelope(error),
              init: redactStructuredValue(result as unknown as Readonly<Record<string, unknown>>),
            }),
          };
        }
        const nextAction = computeNextAction(result.state);
        const json = {
          ...(flags["dry-run"] === true ? createDryRunPlanFields(result.dryRunPlan) : {}),
          mutated: result.mutated,
          dryRun: flags["dry-run"] === true,
          target: result.target,
          configPath: result.configPath,
          config: result.config,
          configuration: {
            fieldSources: result.configFieldSources,
            layers: result.configLayerPaths,
          },
          statePath: result.sessionPath,
          sessionPath: result.sessionPath,
          actions: result.actions,
          conflicts: result.conflicts,
          written: result.written,
          plannedAgentFiles: result.agentActions.map((action) => ({
            id: action.id,
            host: action.host,
            path: action.absolutePath,
            kind: action.kind,
            operation: action.operation,
          })),
          agentAssets: result.agentActions.map((action) => ({ path: action.absolutePath, operation: action.operation })),
          state: result.state,
          phase: result.state.phase,
          nextAction,
          nextCommand: "aib next --json"
        };
        return flags["dry-run"] === true
          ? {
              json,
              human: `${renderDryRunPlan(result.dryRunPlan)}No files changed.\nAgent next action: ${nextAction.summary}\n`
            }
          : {
              json,
              human: result.mutated
                ? `Initialized Bootstrap state and instructions.\nNext action: ${nextAction.summary}\n`
                : `Bootstrap state and instructions already match. No files changed.\nNext action: ${nextAction.summary}\n`
            };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
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
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".qube/aib/session.json");
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
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".qube/aib/session.json");
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
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
    createCommand(arenaSynthesizeCommand, ({ args }) => {
      const target = typeof args.target === "string" ? args.target : undefined;
      const goal = typeof args.goal === "string" ? args.goal : undefined;
      const plan = synthesizeAutoresearchArena({ target, goal, cwd: process.cwd() });
      return {
        json: {
          ...plan,
          arenaPlan: plan
        },
        human: renderArenaSynthesis(plan)
      };
    }),
    createCommand(specDraftCommand, ({ flags }) => {
      try {
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
        const statePath = typeof flags.state === "string" ? flags.state : ".qube/aib/session.json";
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
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".qube/aib/session.json");
        const projectRoot = projectRootForState(envelope.statePath);
        const validation = validateSpecFile(envelope.state, projectRoot);
        const spec = computeSpecStatus(envelope.state);
        if (!validation.ok || !spec.canGenerateMilestones || envelope.state.artifacts.spec.status !== "accepted") {
          throw createCliError({
            command: "work-items generate",
            kind: "spec-not-accepted",
            operation: "guard work-item generation",
            likelyCause: `Spec validation ok: ${validation.ok}. Missing accepted sections: ${spec.missingRequiredAcceptance.join(", ") || "none"}.`,
            suggestedNextAction: "Run aib spec validate --json, accept required sections, then generate milestone docs.",
            category: "validation",
            exitCode: 3
          });
        }
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
        const milestone = typeof flags.milestone === "string" ? flags.milestone : undefined;
        let result: WorkItemDraftResult;
        try {
          result = flags["dry-run"] === true
            ? createWorkItemDrafts(envelope.state, milestone, projectRoot)
            : writeWorkItemDrafts(envelope.state, milestone, projectRoot);
        } catch (error) {
          if (error instanceof WorkItemLintError) {
            throw createCliError({
              command: "work-items generate",
              kind: "work-item-lint-failed",
              operation: "lint generated work-item drafts",
              likelyCause: error.message,
              suggestedNextAction: "Fix the milestone acceptance criteria or themes so every draft carries owned, observable, verification-tagged criteria, then rerun aib work-items generate --json.",
              category: "validation",
              exitCode: 3
            });
          }
          if (error instanceof WorkItemQueueOrderError) {
            throw createCliError({
              command: "work-items generate",
              kind: "work-item-order-invalid",
              operation: "validate work-item queue ordering",
              likelyCause: error.message,
              suggestedNextAction: "Regenerate milestone/work-item drafts so Sequence and Blocked by ordering are consistent.",
              category: "validation",
              exitCode: 3
            });
          }
          const errno = typeof error === "object" && error !== null && "code" in error
            ? String((error as { code?: unknown }).code ?? "")
            : "";
          const isMilestoneSelectionError = error instanceof TypeError || errno === "ENOENT";
          if (!isMilestoneSelectionError) {
            throw createCliError({
              command: "work-items generate",
              kind: "work-item-write-failed",
              operation: "write work-item draft artifacts",
              likelyCause: error instanceof Error ? error.message : "The work-item draft artifacts could not be written.",
              suggestedNextAction: "Check filesystem permissions and output paths, then rerun aib work-items generate --json.",
              category: "runtime",
              exitCode: 3
            });
          }
          throw createCliError({
            command: "work-items generate",
            kind: "milestone-required",
            operation: "select milestone for work-item generation",
            likelyCause: error instanceof Error ? error.message : "The requested milestone could not be selected.",
            suggestedNextAction: "Run aib status --json and choose one of planning.milestoneDrafts by id or path.",
            category: "validation",
            exitCode: 3
          });
        }
        const updated = withWorkItemDraftState(envelope.state, result);
        if (flags["dry-run"] === true) {
          return {
            json: {
              mutated: false,
              dryRun: true,
              allowed: true,
              statePath: envelope.statePath,
              milestone: result.milestone,
              drafts: result.drafts,
              queueOrder: result.queueOrder,
              plannedWrites: result.rendered.map((item) => ({ path: item.path })),
              state: updated,
              nextAction: computeNextAction(updated)
            },
            human: `Dry run: would draft ${result.drafts.length} work items from ${result.milestone.id}.\n`
          };
        }
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            mutated: true,
            allowed: true,
            statePath: written.statePath,
            milestone: result.milestone,
            drafts: result.drafts,
            queueOrder: result.queueOrder,
            written: result.rendered.map((item) => ({ path: item.path })),
            state: written.state,
            nextAction: computeNextAction(written.state)
          },
          human: `Drafted ${result.drafts.length} work items from ${result.milestone.id}.\n`
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("work-items generate", error);
      }
    }),
    createCommand(workItemsRenderCommand, async ({ flags }) => {
      try {
        const envelope = readBootstrapState(typeof flags.state === "string" ? flags.state : ".qube/aib/session.json");
        const projectRoot = projectRootForState(envelope.statePath);
        const provider = flags.provider === "github" || flags.provider === "gitlab" || flags.provider === "linear" || flags.provider === "jira" || flags.provider === "markdown" ? flags.provider : undefined;
        if (!provider) {
          throw createCliError({
            command: "work-items render",
            kind: "work-item-render-failed",
            operation: "select work-item render provider",
            likelyCause: "Provider must be one of github, gitlab, linear, jira, or markdown.",
            suggestedNextAction: "Pass --provider github, --provider gitlab, --provider linear, --provider jira, or --provider markdown.",
            category: "validation",
            exitCode: 3
          });
        }
        const outputDir = typeof flags["output-dir"] === "string" ? flags["output-dir"] : undefined;
        if ((provider === "github" || provider === "gitlab" || provider === "linear" || provider === "jira") && flags["dry-run"] !== true) {
          throw createCliError({
            command: "work-items render",
            kind: "provider-mutation-unsupported",
            operation: `render ${provider} work items`,
            likelyCause: `${provider} issue creation is unsupported in this provider adapter.`,
            suggestedNextAction: `Use --dry-run to review planned ${provider} issues, or render markdown drafts for offline review.`,
            category: "safety",
            exitCode: 5
          });
        }

        let result: WorkItemRenderResult;
        try {
          result = flags["dry-run"] === true || provider === "github" || provider === "gitlab" || provider === "linear" || provider === "jira"
            ? await renderWorkItemDrafts(envelope.state, provider, { outputDir })
            : await writeRenderedMarkdownWorkItems(envelope.state, { outputDir, baseDir: projectRoot });
        } catch (error) {
          if (error instanceof WorkItemLintError) {
            throw createCliError({
              command: "work-items render",
              kind: "work-item-lint-failed",
              operation: "lint recorded work-item drafts before render",
              likelyCause: error.message,
              suggestedNextAction: "Regenerate work-item drafts so every draft carries owned, observable, verification-tagged criteria, then rerun aib work-items render --json.",
              category: "validation",
              exitCode: 3
            });
          }
          if (error instanceof WorkItemQueueOrderError) {
            throw createCliError({
              command: "work-items render",
              kind: "work-item-order-invalid",
              operation: "validate work-item queue ordering",
              likelyCause: error.message,
              suggestedNextAction: "Regenerate milestone/work-item drafts so Sequence and Blocked by ordering are consistent.",
              category: "validation",
              exitCode: 3
            });
          }
          const missingDrafts = error instanceof TypeError && /no work item drafts/u.test(error.message);
          throw createCliError({
            command: "work-items render",
            kind: missingDrafts ? "work-items-required" : "work-item-render-failed",
            operation: "render work item drafts",
            likelyCause: error instanceof Error ? error.message : "The work-item drafts could not be rendered.",
            suggestedNextAction: missingDrafts
              ? "Run aib work-items generate --milestone <milestone-id> --json before rendering provider outputs."
              : "Check filesystem permissions, state contents, and render target options, then rerun the command.",
            category: missingDrafts ? "validation" : "runtime",
            exitCode: 3
          });
        }

        if (flags["dry-run"] === true || provider === "github" || provider === "gitlab" || provider === "linear" || provider === "jira") {
          return {
            json: renderWorkItemJson(result, false, envelope.statePath),
            human: `Dry run: rendered ${result.rendered.length} work items for ${provider}.\n`
          };
        }

        const updated = withRenderedWorkItemState(envelope.state, result);
        const written = writeBootstrapState(envelope.statePath, updated);
        return {
          json: {
            ...renderWorkItemJson(result, true, written.statePath),
            state: written.state,
            nextAction: computeNextAction(written.state)
          },
          human: `Rendered ${result.rendered.length} markdown work items.\n`
        };
      } catch (error) {
        if (isCliSpecError(error)) throw error;
        throw stateError("work-items render", error);
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

function parseAgentSurfaces(value: unknown): readonly ReturnType<typeof requireAgentHost>[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError("--surfaces must contain one or more comma-separated agent harnesses.");
  }
  const surfaces = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0).map(requireAgentHost);
  return Object.freeze([...new Set(surfaces)]);
}

function requireAgentHost(value: string) {
  if (!isAgentHost(value)) {
    throw new TypeError(`Unsupported agent harness "${value}" in --surfaces.`);
  }
  return value;
}

runtimeRegistry = aibCli.registry;

export async function runAibCli(input: readonly string[]): Promise<number> {
  const result = await runCli(aibCli, input);
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode === 0 ? process.exitCode : result.exitCode;
  return result.exitCode;
}

function renderArenaSynthesis(plan: ReturnType<typeof synthesizeAutoresearchArena>): string {
  const questions = plan.blockingQuestions.length > 0
    ? ["", "Blocking questions:", ...plan.blockingQuestions.map(question => `- ${question.text} (${question.reason})`)]
    : [];
  const target = plan.target ? [`Target: ${plan.target.path}`, `Target kind: ${plan.target.kind}`] : [];
  const evaluator = plan.evaluator ? [`Evaluator: ${plan.evaluator.kind}`, `Evaluator hash: ${plan.evaluator.hash}`] : [];
  return [
    "AIB autoresearch arena synthesis",
    "",
    `Classification: ${plan.classification}`,
    ...target,
    `Goal: ${plan.goal || "(missing)"}`,
    ...(plan.objective ? [`Objective: ${plan.objective.description}`] : []),
    ...evaluator,
    `Next action: ${plan.nextAction}`,
    ...questions,
    ""
  ].join("\n");
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

function withWorkItemDraftState(state: BootstrapState, result: WorkItemDraftResult): BootstrapState {
  const updated: BootstrapState = {
    ...state,
    phase: "work_item_generation",
    artifacts: {
      ...state.artifacts,
      workItems: result.artifacts
    },
    planning: {
      ...state.planning,
      workItemDrafts: result.drafts
    }
  };
  return withPlanningNext(updated);
}

function withRenderedWorkItemState(state: BootstrapState, result: WorkItemRenderResult): BootstrapState {
  const updated: BootstrapState = {
    ...state,
    phase: "work_item_generation",
    artifacts: {
      ...state.artifacts,
      workItems: result.artifacts
    },
    planning: {
      ...state.planning,
      workItemDrafts: result.drafts.map((draft) => ({
        ...draft,
        status: "rendered" as const
      }))
    }
  };
  return withPlanningNext(updated);
}

function renderWorkItemJson(result: WorkItemRenderResult, mutated: boolean, statePath: string): {
  readonly mutated: boolean;
  readonly dryRun: boolean;
  readonly statePath: string;
  readonly provider: WorkItemRenderProvider;
  readonly drafts: readonly unknown[];
  readonly queueOrder: unknown;
  readonly rendered: readonly unknown[];
  readonly plannedIssues?: readonly unknown[];
  readonly plannedGitLabIssues?: readonly unknown[];
  readonly plannedJiraIssues?: readonly unknown[];
  readonly plannedWrites?: readonly unknown[];
  readonly written?: readonly unknown[];
} {
  const markdown = result.provider === "markdown" ? result.rendered.filter((item): item is RenderedMarkdownWorkItem => "path" in item) : [];
  const github = result.provider === "github" ? result.rendered : [];
  const gitlab = result.provider === "gitlab" ? result.rendered : [];
  const linear = result.provider === "linear" ? result.rendered : [];
  const jira = result.provider === "jira" ? result.rendered : [];
  return {
    mutated,
    dryRun: !mutated,
    statePath,
    provider: result.provider,
    drafts: result.drafts,
    queueOrder: result.queueOrder,
    rendered: result.rendered,
    ...(github.length > 0 && result.provider === "github" ? { plannedIssues: github } : {}),
    ...(gitlab.length > 0 && result.provider === "gitlab" ? { plannedGitLabIssues: gitlab } : {}),
    ...(linear.length > 0 ? { plannedLinearIssues: linear } : {}),
    ...(jira.length > 0 ? { plannedJiraIssues: jira } : {}),
    ...(markdown.length > 0 && !mutated ? { plannedWrites: markdown.map((item) => ({ path: item.path })) } : {}),
    ...(markdown.length > 0 && mutated ? { written: markdown.map((item) => ({ path: item.path })) } : {})
  };
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

function initConflictError(plan: InitPlan): ReturnType<typeof createCliError> {
  const conflict = plan.conflicts[0];
  return createCliError({
    command: "init",
    kind: "init-conflict",
    operation: conflict ? `prepare ${conflict.kind} at ${conflict.path}` : "prepare Bootstrap files",
    likelyCause: conflict?.reason ?? "Bootstrap init found a conflicting path.",
    suggestedNextAction: conflict?.suggestedNextAction ?? "Fix the reported path, then run aib init again.",
    category: "validation",
    exitCode: 3
  });
}

function isCliSpecError(error: unknown): error is ReturnType<typeof createCliError> {
  return typeof error === "object" && error !== null && "kind" in error && "exitCode" in error;
}

function projectRootForState(statePath: string): string {
  const stateDir = dirname(statePath);
  if (basename(stateDir) === "aib" && basename(dirname(stateDir)) === ".qube") {
    return dirname(dirname(stateDir));
  }
  return dirname(dirname(statePath));
}
