import type { ExitCodeCategory } from "../metadata/index.js";

export interface CliErrorDetails {
  readonly command?: string;
  readonly kind: string;
  readonly operation: string;
  readonly likelyCause: string;
  readonly suggestedNextAction: string;
  readonly category: ExitCodeCategory;
  readonly exitCode?: number;
}

export interface CliErrorShape extends CliErrorDetails {
  readonly exitCode: number;
}

export class CliError extends Error implements CliErrorShape {
  readonly command?: string;
  readonly kind: string;
  readonly operation: string;
  readonly likelyCause: string;
  readonly suggestedNextAction: string;
  readonly category: ExitCodeCategory;
  readonly exitCode: number;

  constructor(details: CliErrorDetails) {
    super(`${details.operation}: ${details.likelyCause}`);
    this.name = "CliError";
    if (details.command !== undefined) {
      this.command = details.command;
    }
    this.kind = details.kind;
    this.operation = details.operation;
    this.likelyCause = details.likelyCause;
    this.suggestedNextAction = details.suggestedNextAction;
    this.category = details.category;
    this.exitCode = details.exitCode ?? exitCodeForCategory(details.category);
  }
}

export function createCliError(details: CliErrorDetails): CliError {
  return new CliError(details);
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}

export function exitCodeForCategory(category: ExitCodeCategory): number {
  switch (category) {
    case "success":
      return 0;
    case "usage":
      return 2;
    case "validation":
      return 3;
    case "external":
      return 4;
    case "safety":
      return 5;
    case "unexpected":
      return 70;
    default:
      return 1;
  }
}

export function renderCliErrorText(error: CliErrorShape): string {
  return [
    `Error: ${error.kind}`,
    `Operation: ${error.operation}`,
    `Likely cause: ${error.likelyCause}`,
    `Suggested next action: ${error.suggestedNextAction}`,
    `Exit code category: ${error.category}`,
    ""
  ].join("\n");
}
