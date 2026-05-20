import { defineCommand, defineArgument, defineFlag, defineTopic } from "../src/index.js";
import type { CommandMetadata, TopicMetadata } from "../src/index.js";

/**
 * Type assertion helper.
 */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
function assertType<T extends true>() {}

// Test literal preservation in Command
const cmd = defineCommand({
  kind: "command",
  name: "cache clear",
  description: "Clear the cache",
  extensions: {
    priority: "high",
    tags: ["cleanup", "internal"]
  }
} as const);

assertType<Equal<typeof cmd.name, "cache clear">>();
assertType<Equal<typeof cmd.extensions.priority, "high">>();
assertType<Equal<typeof cmd.extensions.tags, readonly ["cleanup", "internal"]>>();

// Test literal preservation in Topic
const topic = defineTopic({
  kind: "topic",
  name: "cache",
  description: "Cache commands",
  extensions: {
    group: "maintenance"
  }
} as const);

assertType<Equal<typeof topic.name, "cache">>();
assertType<Equal<typeof topic.extensions.group, "maintenance">>();

// Test mutation categories
const deployCmd = defineCommand({
  kind: "command",
  name: "deploy",
  description: "Deploy",
  mutation: {
    categories: ["external-service", "release"]
  },
  interactions: {
    dryRun: { supported: true }
  }
} as const);

assertType<Equal<typeof deployCmd.mutation.categories, readonly ["external-service", "release"]>>();

const dependencyCmd = defineCommand({
  kind: "command",
  name: "install deps",
  description: "Install dependencies",
  supplyChain: {
    sensitive: true,
    reason: "Dependency operations need review.",
    kinds: ["dependency", "package-manager"]
  }
} as const);

assertType<Equal<typeof dependencyCmd.supplyChain.kinds, readonly ["dependency", "package-manager"]>>();

// Test extension round-trip in Argument
const arg = defineArgument({
  name: "path",
  description: "Path",
  extensions: {
    validation: "exists"
  }
} as const);

assertType<Equal<typeof arg.extensions.validation, "exists">>();

// Test flag types
const flag = defineFlag({
  name: "force",
  description: "Force",
  type: "boolean"
} as const);

assertType<Equal<typeof flag.type, "boolean">>();

// Verify that it satisfies the base types
const _c: CommandMetadata = cmd;
const _t: TopicMetadata = topic;
