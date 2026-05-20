export interface TerminalEnvironment {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTTY?: boolean;
  readonly stdoutIsTTY?: boolean;
  readonly stderrIsTTY?: boolean;
  readonly jsonMode?: boolean;
  readonly noColor?: boolean;
  readonly color?: boolean;
}

export interface TerminalCapabilities {
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  readonly ci: boolean;
  readonly jsonMode: boolean;
  readonly noColor: boolean;
  readonly colorLevel: 0 | 1 | 2 | 3;
  readonly color: boolean;
  readonly interactive: boolean;
  readonly progress: boolean;
  readonly dynamic: boolean;
}

export type TerminalStatusKind = "success" | "error" | "warning" | "info";

export function detectTerminalCapabilities(environment: TerminalEnvironment = {}): TerminalCapabilities {
  const env = environment.env ?? process.env;
  const argv = environment.argv ?? process.argv.slice(2);
  const stdinIsTTY = environment.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = environment.stdoutIsTTY ?? process.stdout.isTTY === true;
  const stderrIsTTY = environment.stderrIsTTY ?? process.stderr.isTTY === true;
  const jsonMode = environment.jsonMode ?? argvRequestsJson(argv);
  const ci = isCiEnvironment(env);
  const noColor = environment.noColor === true || jsonMode || argv.includes("--no-color") || hasNoColor(env);
  const colorLevel = environment.color === undefined
    ? resolveColorLevel({ env, stdoutIsTTY, noColor })
    : resolveColorLevel({ env, stdoutIsTTY, noColor, color: environment.color });
  const interactive = stdinIsTTY && stdoutIsTTY && !ci && !jsonMode;
  const dynamic = interactive && colorLevel > 0;
  return Object.freeze({
    stdinIsTTY,
    stdoutIsTTY,
    stderrIsTTY,
    ci,
    jsonMode,
    noColor,
    colorLevel,
    color: colorLevel > 0,
    interactive,
    progress: dynamic,
    dynamic
  });
}

export function stripAnsi(value: string): string {
  return value.replace(new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g"), "");
}

export function formatStatus(kind: TerminalStatusKind, message: string, capabilities: TerminalCapabilities = detectTerminalCapabilities()): string {
  const icon = statusIcon(kind, capabilities);
  const text = capabilities.color ? colorizeStatus(kind, message) : message;
  return `${icon} ${text}`;
}

export function shouldUseColor(capabilities: TerminalCapabilities = detectTerminalCapabilities()): boolean {
  return capabilities.color;
}

export function shouldUseProgress(capabilities: TerminalCapabilities = detectTerminalCapabilities()): boolean {
  return capabilities.progress;
}

export function shouldPrompt(capabilities: TerminalCapabilities = detectTerminalCapabilities()): boolean {
  return capabilities.interactive;
}

function resolveColorLevel(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutIsTTY: boolean;
  readonly noColor: boolean;
  readonly color?: boolean;
}): 0 | 1 | 2 | 3 {
  if (input.color === false || input.noColor) {
    return 0;
  }
  if (input.color === true) {
    return 1;
  }
  const forceColor = input.env.FORCE_COLOR;
  if (forceColor === "0" || forceColor === "false") {
    return 0;
  }
  if (forceColor === "2") {
    return 2;
  }
  if (forceColor === "3") {
    return 3;
  }
  if (forceColor !== undefined) {
    return 1;
  }
  if (input.env.GITHUB_ACTIONS === "true") {
    return 1;
  }
  return input.stdoutIsTTY ? 1 : 0;
}

function argvRequestsJson(argv: readonly string[]): boolean {
  const positionalSeparatorIndex = argv.indexOf("--");
  const flagArgv = positionalSeparatorIndex === -1 ? argv : argv.slice(0, positionalSeparatorIndex);
  return flagArgv.some((token, index) => token === "--json" || token === "--output=json" || (token === "--output" && flagArgv[index + 1] === "json"));
}

function hasNoColor(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== "";
}

function isCiEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI !== "false";
}

function statusIcon(kind: TerminalStatusKind, capabilities: TerminalCapabilities): string {
  if (!capabilities.color) {
    switch (kind) {
      case "success":
        return "[OK]";
      case "error":
        return "[ERROR]";
      case "warning":
        return "[WARN]";
      case "info":
        return "[INFO]";
    }
  }
  switch (kind) {
    case "success":
      return "\u001B[32m✔\u001B[0m";
    case "error":
      return "\u001B[31m✖\u001B[0m";
    case "warning":
      return "\u001B[33m!\u001B[0m";
    case "info":
      return "\u001B[36mi\u001B[0m";
  }
}

function colorizeStatus(kind: TerminalStatusKind, message: string): string {
  switch (kind) {
    case "success":
      return `\u001B[32m${message}\u001B[0m`;
    case "error":
      return `\u001B[31m${message}\u001B[0m`;
    case "warning":
      return `\u001B[33m${message}\u001B[0m`;
    case "info":
      return `\u001B[36m${message}\u001B[0m`;
  }
}
