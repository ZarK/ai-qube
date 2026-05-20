import { confirm, isCancel, text } from "@clack/prompts";

import { createCliError } from "../errors/index.js";
import type { CommandMetadata } from "../metadata/index.js";
import { detectTerminalCapabilities, type TerminalCapabilities } from "../terminal/index.js";

export type PromptBlockReason = "ci" | "json" | "non-interactive" | "non-tty" | "tty-prompt-disabled";

export interface PromptGateOptions<Value> {
  readonly command?: CommandMetadata | string;
  readonly promptName?: string;
  readonly terminal?: TerminalCapabilities;
  readonly jsonMode?: boolean;
  readonly nonInteractive?: boolean;
  readonly value?: Value;
  readonly defaultValue?: Value;
  readonly defaults?: boolean;
  readonly yes?: boolean;
}

export type PromptGateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: PromptBlockReason; readonly message: string };

export type PromptRunner<Value> = () => Promise<Value | symbol> | Value | symbol;
export type ClackTextOptions = Parameters<typeof text>[0];
export type ClackConfirmOptions = Parameters<typeof confirm>[0];

export function evaluatePromptGate<Value>(options: PromptGateOptions<Value> = {}): PromptGateDecision {
  const terminal = options.terminal ?? (options.jsonMode === undefined ? detectTerminalCapabilities() : detectTerminalCapabilities({ jsonMode: options.jsonMode }));
  if (options.jsonMode === true || terminal.jsonMode) {
    return blocked("json", "Prompts are disabled in JSON output mode.");
  }
  if (options.nonInteractive === true || options.defaults === true || options.yes === true) {
    return blocked("non-interactive", "Prompts are disabled for explicit non-interactive flows.");
  }
  if (typeof options.command === "object" && options.command.interactions?.ttyPrompt === false) {
    return blocked("tty-prompt-disabled", "Command metadata declares that TTY prompts are disabled.");
  }
  if (terminal.ci) {
    return blocked("ci", "Prompts are disabled in CI environments.");
  }
  if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) {
    return blocked("non-tty", "Prompts are disabled when stdin or stdout is not a TTY.");
  }
  return Object.freeze({ allowed: true });
}

export async function resolvePromptValue<Value>(options: PromptGateOptions<Value> & { readonly prompt: PromptRunner<Value> }): Promise<Value> {
  if (options.value !== undefined) {
    return options.value;
  }
  const gate = evaluatePromptGate(options);
  if (!gate.allowed) {
    if (options.defaultValue !== undefined) {
      return options.defaultValue;
    }
    throw createPromptBlockedError(options, gate);
  }
  const value = await options.prompt();
  if (isPromptCancel(value)) {
    throw createCliError({
      command: commandName(options.command),
      kind: "prompt-cancelled",
      operation: `prompt ${options.promptName ?? "value"}`,
      likelyCause: "The interactive prompt was cancelled.",
      suggestedNextAction: "Retry with a flag or config value instead of relying on an interactive prompt.",
      category: "usage"
    });
  }
  return value;
}

export async function promptText(options: PromptGateOptions<string> & { readonly clack: ClackTextOptions }): Promise<string> {
  return resolvePromptValue({
    ...options,
    prompt: () => text(options.clack)
  });
}

export async function promptConfirm(options: PromptGateOptions<boolean> & { readonly clack: ClackConfirmOptions }): Promise<boolean> {
  return resolvePromptValue({
    ...options,
    prompt: () => confirm(options.clack)
  });
}

export function isPromptCancel(value: unknown): value is symbol {
  return isCancel(value);
}

function createPromptBlockedError<Value>(options: PromptGateOptions<Value>, gate: Exclude<PromptGateDecision, { readonly allowed: true }>): ReturnType<typeof createCliError> {
  return createCliError({
    command: commandName(options.command),
    kind: "prompt-blocked",
    operation: `prompt ${options.promptName ?? "value"}`,
    likelyCause: gate.message,
    suggestedNextAction: "Provide the value with flags or config, or rerun in an interactive terminal.",
    category: "usage"
  });
}

function blocked(reason: PromptBlockReason, message: string): PromptGateDecision {
  return Object.freeze({ allowed: false, reason, message });
}

function commandName(command: CommandMetadata | string | undefined): string {
  return typeof command === "string" ? command : command?.name ?? "<prompt>";
}
