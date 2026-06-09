import { createCliError } from "@tjalve/qube-cli/errors";
import { createDryRunPlanFields, renderDryRunPlan } from "@tjalve/qube-cli/mutation";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "@tjalve/qube-cli/runtime";

import { loadAibConfig } from "./config.js";
import { createInitPlan } from "./init.js";
import { answerCommand, bootstrapRegistry, initCommand, nextCommand, planningTopic, statusCommand } from "./metadata.js";
import { packageJson } from "./package.js";
import { AnswerError, applyAnswer, computeNextAction, isAgentHost, readBootstrapState, writeBootstrapState } from "./state.js";

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
        return {
          json: {
            statePath: envelope.statePath,
            phase: envelope.state.phase,
            missingDecisions: nextAction.missingDecisions,
            artifacts: envelope.state.artifacts,
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
