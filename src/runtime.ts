import { createCliError } from "@tjalve/qube-cli/errors";
import { createDryRunPlanFields, renderDryRunPlan } from "@tjalve/qube-cli/mutation";
import { createCli, createCommand, createSchemaCommand, createTopicCommand, runCli } from "@tjalve/qube-cli/runtime";

import { loadAibConfig } from "./config.js";
import { createInitPlan } from "./init.js";
import { bootstrapRegistry, initCommand, planningTopic } from "./metadata.js";
import { packageJson } from "./package.js";

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
      if (flags["dry-run"] !== true) {
        throw createCliError({
          command: "init",
          kind: "init-dry-run-required",
          operation: "initialize bootstrap workspace",
          likelyCause: "The command would create local planning files, but --dry-run was not provided.",
          suggestedNextAction: "Run aib init --dry-run --json first so the agent can inspect the planned bootstrap state.",
          category: "safety",
          exitCode: 5
        });
      }

      try {
        const plan = createInitPlan({
          target: typeof args.target === "string" ? args.target : undefined,
          loadedConfig: loadAibConfig(typeof flags.config === "string" ? flags.config : undefined),
          idea: typeof flags.idea === "string" ? flags.idea : undefined
        });

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
            nextAction: plan.session.nextAction
          },
          human: `${renderDryRunPlan(plan.dryRunPlan)}State file not changed.\nAgent next action: ${plan.session.nextAction.prompt}\n`
        };
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
