export * from "./metadata/index.js";
export * from "./registry/index.js";
export * from "./help/index.js";
export * from "./runtime/index.js";
export * from "./schema/index.js";
export * from "./errors/index.js";
export * from "./output/index.js";
export * from "./mutation/index.js";
export * from "./terminal/index.js";
export * from "./prompts/index.js";
export * from "./redaction/index.js";
export * from "./testing/index.js";

export interface ToolkitBoundary {
  readonly packageKind: "cli-infrastructure";
  readonly consumesCommandBehavior: false;
  readonly mutatesConsumerState: false;
}

export const toolkitBoundary: ToolkitBoundary = Object.freeze({
  packageKind: "cli-infrastructure",
  consumesCommandBehavior: false,
  mutatesConsumerState: false
});

export function describeToolkitBoundary(): string {
  return "@tjalve/qube-cli provides reusable CLI infrastructure; consuming packages own command behavior, policy decisions, and side effects.";
}
