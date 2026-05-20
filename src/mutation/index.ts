import type { DryRunSupport, MetadataExtensions, MutationCategory, SupplyChainSensitiveKind } from "../metadata/index.js";

export const builtInMutationCategories = Object.freeze(["local-files", "local-config", "external-service", "dependency", "release"] as const);

export const supplyChainSensitiveKinds = Object.freeze([
  "dependency",
  "package-manager",
  "generator",
  "ci-workflow",
  "release",
  "ide-tooling",
  "mcp-server",
  "ai-agent-tool"
] as const);

export interface MutationMetadataInput<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly categories: readonly MutationCategory[];
  readonly extensions?: Extensions;
}

export interface DryRunPlanStep<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly action: string;
  readonly target: string;
  readonly category?: MutationCategory;
  readonly description?: string;
  readonly extensions?: Extensions;
}

export interface DryRunPlan<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly command: string;
  readonly summary: string;
  readonly mutationCategories?: readonly MutationCategory[];
  readonly steps: readonly DryRunPlanStep[];
  readonly rerunCommand?: string;
  readonly extensions?: Extensions;
}

export interface MutationWarning {
  readonly command: string;
  readonly categories: readonly MutationCategory[];
  readonly dryRun?: DryRunSupport;
  readonly supplyChainSensitive?: boolean;
  readonly message?: string;
}

export type SupplyChainCheckStatus = "blocked" | "needs-review" | "passed";

export interface SupplyChainBlockCheck {
  readonly name: string;
  readonly status: SupplyChainCheckStatus;
  readonly description: string;
}

export interface SupplyChainBlock<Extensions extends MetadataExtensions = MetadataExtensions> {
  readonly command: string;
  readonly reason: string;
  readonly sensitiveKinds?: readonly SupplyChainSensitiveKind[];
  readonly checks?: readonly SupplyChainBlockCheck[];
  readonly suggestedNextAction?: string;
  readonly extensions?: Extensions;
}

export function defineMutationMetadata<const Metadata extends MutationMetadataInput>(metadata: Metadata): Readonly<Metadata> {
  requireNonEmptyList(metadata.categories, "mutation.categories");
  return Object.freeze(metadata);
}

export function mutationCategories<const Categories extends readonly MutationCategory[]>(...categories: Categories): Readonly<Categories> {
  requireNonEmptyList(categories, "mutation.categories");
  return Object.freeze(categories);
}

export function dryRunSupported(): DryRunSupport {
  return Object.freeze({ supported: true });
}

export function dryRunUnsupported(reason: string): DryRunSupport {
  requireText(reason, "dryRun.reason");
  return Object.freeze({ supported: false, reason });
}

export function createDryRunPlan<const Plan extends DryRunPlan>(plan: Plan): Readonly<Plan> {
  requireText(plan.command, "dryRunPlan.command");
  requireText(plan.summary, "dryRunPlan.summary");
  requireNonEmptyList(plan.steps, "dryRunPlan.steps");
  for (const [index, step] of plan.steps.entries()) {
    requireText(step.action, `dryRunPlan.steps[${index}].action`);
    requireText(step.target, `dryRunPlan.steps[${index}].target`);
  }
  return Object.freeze(plan);
}

export function createSupplyChainBlock<const Block extends SupplyChainBlock>(block: Block): Readonly<Block> {
  requireText(block.command, "supplyChainBlock.command");
  requireText(block.reason, "supplyChainBlock.reason");
  for (const [index, check] of (block.checks ?? []).entries()) {
    requireText(check.name, `supplyChainBlock.checks[${index}].name`);
    requireText(check.description, `supplyChainBlock.checks[${index}].description`);
  }
  return Object.freeze(block);
}

export function createDryRunPlanFields(plan: DryRunPlan): Readonly<Record<string, unknown>> {
  return Object.freeze({
    dryRun: true,
    dryRunPlan: {
      command: plan.command,
      summary: plan.summary,
      mutationCategories: sortedText(plan.mutationCategories ?? plan.steps.flatMap((step) => step.category ? [step.category] : [])),
      steps: plan.steps.map((step) => stableStep(step)),
      rerunCommand: plan.rerunCommand,
      extensions: plan.extensions
    }
  });
}

export function createSupplyChainBlockFields(block: SupplyChainBlock): Readonly<Record<string, unknown>> {
  return Object.freeze({
    supplyChainBlock: {
      blocked: true,
      command: block.command,
      reason: block.reason,
      sensitiveKinds: sortedText(block.sensitiveKinds ?? []),
      checks: [...(block.checks ?? [])].map((check) => ({
        name: check.name,
        status: check.status,
        description: check.description
      })),
      suggestedNextAction: block.suggestedNextAction,
      extensions: block.extensions
    }
  });
}

export function renderDryRunPlan(plan: DryRunPlan): string {
  const categories = sortedText(plan.mutationCategories ?? plan.steps.flatMap((step) => step.category ? [step.category] : []));
  return joinSections([
    ["Dry run plan", `Command: ${plan.command}`, `Summary: ${plan.summary}`, `Mutation categories: ${categories.length === 0 ? "none" : categories.join(", ")}`].join("\n"),
    joinLines(["Planned changes:", ...plan.steps.map((step) => `  - ${step.action}: ${step.target}${step.description ? ` — ${step.description}` : ""}${step.category ? ` (${step.category})` : ""}`)]),
    `Next steps:\n  ${plan.rerunCommand ? `Rerun without --dry-run to apply: ${plan.rerunCommand}` : "Rerun without --dry-run to apply the planned changes."}`
  ]);
}

export function renderMutationWarning(warning: MutationWarning): string {
  const categories = sortedText(warning.categories);
  const dryRun = warning.dryRun ? (warning.dryRun.supported ? "supported" : `unsupported (${warning.dryRun.reason})`) : "not declared";
  return joinLines([
    "Mutation warning",
    `Command: ${warning.command}`,
    `Categories: ${categories.length === 0 ? "none" : categories.join(", ")}`,
    `Dry run: ${dryRun}`,
    `Supply chain sensitive: ${warning.supplyChainSensitive === true ? "yes" : "no"}`,
    `Guidance: ${warning.message ?? "Review the planned side effects before continuing."}`
  ]) + "\n";
}

export function renderSupplyChainBlock(block: SupplyChainBlock): string {
  const sensitiveKinds = sortedText(block.sensitiveKinds ?? []);
  const checks = block.checks && block.checks.length > 0
    ? block.checks.map((check) => `  - ${check.status}: ${check.name} — ${check.description}`)
    : ["  none"];
  return joinSections([
    ["Supply-chain block", `Command: ${block.command}`, `Reason: ${block.reason}`, `Sensitive operations: ${sensitiveKinds.length === 0 ? "not specified" : sensitiveKinds.join(", ")}`].join("\n"),
    joinLines(["Checks:", ...checks]),
    `Suggested next action:\n  ${block.suggestedNextAction ?? "Review the supply-chain risk and retry only after the consuming package policy allows it."}`
  ]);
}

function stableStep(step: DryRunPlanStep): Readonly<Record<string, unknown>> {
  return Object.freeze({
    action: step.action,
    target: step.target,
    category: step.category,
    description: step.description,
    extensions: step.extensions
  });
}

function sortedText(values: readonly (string | MutationCategory | SupplyChainSensitiveKind)[]): readonly string[] {
  return [...new Set(values.map(String))].sort(compareText);
}

function requireNonEmptyList(value: readonly unknown[], field: string): void {
  if (value.length === 0) {
    throw new TypeError(`${field} must include at least one item.`);
  }
}

function requireText(value: string | undefined, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty.`);
  }
}

function joinSections(sections: readonly string[]): string {
  return `${sections.join("\n\n")}\n`;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
