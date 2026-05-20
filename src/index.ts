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
  return "ai-qube-cli provides reusable CLI infrastructure; consuming packages own command behavior, policy decisions, and side effects.";
}
