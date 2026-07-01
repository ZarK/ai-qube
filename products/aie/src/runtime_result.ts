import type { RuntimeCommandContext, RuntimeCommandResult } from '@tjalve/qube-cli/runtime';

export function flagEnabled(context: RuntimeCommandContext, name: string): boolean | undefined {
  const value = context.flags[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function readBooleanFlag(context: RuntimeCommandContext, name: string, fallback = false): boolean {
  return flagEnabled(context, name) ?? fallback;
}

export function stringArg(context: RuntimeCommandContext, name: string): string | undefined {
  const value = context.args[name];
  return typeof value === 'string' ? value : undefined;
}

export function stringFlag(context: RuntimeCommandContext, name: string): string | undefined {
  const value = context.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function stringListFlag(context: RuntimeCommandContext, name: string): string[] | undefined {
  const value = context.flags[name];
  if (value === undefined) return undefined;
  const split = (input: string): string[] => input.split(',').map(item => item.trim()).filter(item => item !== '');
  if (typeof value === 'string') return split(value);
  if (Array.isArray(value) && value.every(item => typeof item === 'string')) return value.flatMap(split);
  return undefined;
}

export function numberFlag(context: RuntimeCommandContext, name: string): number | undefined {
  const value = context.flags[name];
  return typeof value === 'number' ? value : undefined;
}

export function outputJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function commandResult(context: RuntimeCommandContext, jsonValue: unknown, humanOutput: string, exitCode = 0): RuntimeCommandResult {
  if (readBooleanFlag(context, 'json')) {
    if (exitCode !== 0) process.exitCode = exitCode;
    return { jsonStdout: outputJson(jsonValue) };
  }
  return { stdout: humanOutput.endsWith('\n') ? humanOutput : `${humanOutput}\n`, exitCode };
}

export function commandFailure(context: RuntimeCommandContext, jsonValue: unknown, humanMessage: string, exitCode = 1): RuntimeCommandResult {
  if (readBooleanFlag(context, 'json')) {
    process.exitCode = exitCode;
    return { jsonStdout: outputJson(jsonValue) };
  }
  return { stderr: `Error: ${humanMessage}\n`, exitCode };
}
