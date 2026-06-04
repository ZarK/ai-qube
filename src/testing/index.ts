import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type TextExpectation = string | RegExp | readonly (string | RegExp)[];

export interface CliCommandResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface RunCliCommandOptions {
  readonly cwd?: string | URL;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeout?: number;
}

export interface CliResultExpectation {
  readonly status?: number | null;
  readonly stdout?: TextExpectation;
  readonly stderr?: TextExpectation;
  readonly stdoutExcludes?: TextExpectation;
  readonly stderrExcludes?: TextExpectation;
}

export interface CliHelpExpectation extends CliResultExpectation {
  readonly contains?: TextExpectation;
  readonly excludes?: TextExpectation;
  readonly assertNoExecutionMarker?: boolean;
}

export interface CliDryRunExpectation extends CliResultExpectation {
  readonly contains?: TextExpectation;
  readonly excludes?: TextExpectation;
}

export interface CliJsonErrorExpectation {
  readonly status?: number;
  readonly command?: string;
  readonly kind?: string;
  readonly category?: string;
  readonly exitCode?: number;
  readonly operation?: string | RegExp;
  readonly likelyCause?: string | RegExp;
  readonly suggestedNextAction?: string | RegExp;
  readonly envelope?: Readonly<Record<string, unknown>>;
}

export interface PackDryRunOptions extends RunCliCommandOptions {
  readonly packageManager?: string;
  readonly args?: readonly string[];
}

export interface PackFileEntry {
  readonly path: string;
  readonly [key: string]: unknown;
}

export interface PackEntry {
  readonly files: readonly PackFileEntry[];
  readonly [key: string]: unknown;
}

export interface PackContentsResult {
  readonly actualFiles: readonly string[];
  readonly missingFiles: readonly string[];
  readonly extraFiles: readonly string[];
}

export interface PackSafetyOptions {
  readonly allowedRootFiles?: readonly string[];
  readonly allowedDistExtensions?: readonly string[];
  readonly requiredRootFiles?: readonly string[];
}

const defaultAllowedRootFiles = Object.freeze(["LICENSE", "README.md", "package.json"] as const);
const defaultAllowedDistExtensions = Object.freeze([".js", ".js.map", ".d.ts", ".d.ts.map"] as const);

export function runCliCommand(command: string, args: readonly string[] = [], options: RunCliCommandOptions = {}): CliCommandResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    timeout: options.timeout,
    encoding: "utf8",
    shell: false
  });
  const base = Object.freeze({
    command,
    args: Object.freeze([...args]),
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr
  });
  return result.error ? Object.freeze({ ...base, error: result.error }) : base;
}

export function runNodeCliCommand(scriptPath: string | URL, args: readonly string[] = [], options: RunCliCommandOptions = {}): CliCommandResult {
  const normalizedScriptPath = scriptPath instanceof URL ? fileURLToPath(scriptPath) : scriptPath;
  return runCliCommand(process.execPath, [normalizedScriptPath, ...args], options);
}

export function assertCliResult(result: CliCommandResult, expectation: CliResultExpectation = {}): CliCommandResult {
  if (result.error) {
    throw result.error;
  }
  if (Object.hasOwn(expectation, "status")) {
    assert.equal(result.status, expectation.status, formatResultMessage(result, "status"));
  }
  if (expectation.stdout !== undefined) {
    assertTextMatches(result.stdout, expectation.stdout, "stdout");
  }
  if (expectation.stderr !== undefined) {
    assertTextMatches(result.stderr, expectation.stderr, "stderr");
  }
  if (expectation.stdoutExcludes !== undefined) {
    assertTextExcludes(result.stdout, expectation.stdoutExcludes, "stdout");
  }
  if (expectation.stderrExcludes !== undefined) {
    assertTextExcludes(result.stderr, expectation.stderrExcludes, "stderr");
  }
  return result;
}

export function assertCliSuccess(result: CliCommandResult, expectation: Omit<CliResultExpectation, "status"> = {}): CliCommandResult {
  return assertCliResult(result, { status: 0, stderr: "", ...expectation });
}

export function assertCliFailure(result: CliCommandResult, expectation: CliResultExpectation): CliCommandResult {
  assert.notEqual(result.status, 0, formatResultMessage(result, "expected non-zero status"));
  return assertCliResult(result, expectation);
}

export function parseCliJson(result: CliCommandResult): unknown {
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`CLI stdout was not valid JSON: ${detail}\n${formatResultMessage(result, "stdout")}`);
  }
}

export function parseCliJsonRecord(result: CliCommandResult): Readonly<Record<string, unknown>> {
  const parsed = parseCliJson(result);
  assertRecord(parsed, "CLI JSON stdout");
  return parsed;
}

export function assertCliJsonSuccess(result: CliCommandResult, expectedEnvelope?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  assertCliSuccess(result);
  const envelope = parseCliJsonRecord(result);
  assert.equal(envelope.ok, true);
  if (expectedEnvelope !== undefined) {
    assert.deepEqual(envelope, expectedEnvelope);
  }
  return envelope;
}

export function assertCliJsonError(result: CliCommandResult, expectation: CliJsonErrorExpectation = {}): Readonly<Record<string, unknown>> {
  assertCliResult(result, {
    ...(expectation.status !== undefined ? { status: expectation.status } : {}),
    stderr: ""
  });
  const envelope = parseCliJsonRecord(result);
  assert.equal(envelope.ok, false);
  if (expectation.envelope !== undefined) {
    assert.deepEqual(envelope, expectation.envelope);
  }
  if (expectation.command !== undefined) {
    assert.equal(envelope.command, expectation.command);
  }
  const error = envelope.error;
  assertRecord(error, "CLI JSON error");
  assertExpectedValue(error.kind, expectation.kind, "error.kind");
  assertExpectedValue(error.category, expectation.category, "error.category");
  assertExpectedValue(error.exitCode, expectation.exitCode, "error.exitCode");
  assertExpectedText(error.operation, expectation.operation, "error.operation");
  assertExpectedText(error.likelyCause, expectation.likelyCause, "error.likelyCause");
  assertExpectedText(error.suggestedNextAction, expectation.suggestedNextAction, "error.suggestedNextAction");
  return envelope;
}

export function assertCliPromptBlocked(result: CliCommandResult, expectation: Omit<CliJsonErrorExpectation, "kind"> = {}): Readonly<Record<string, unknown>> {
  return assertCliJsonError(result, { status: 2, kind: "prompt-blocked", category: "usage", ...expectation });
}

export function assertCliHelp(result: CliCommandResult, expectation: CliHelpExpectation = {}): CliCommandResult {
  const assertNoExecutionMarker = expectation.assertNoExecutionMarker ?? true;
  const excludes = assertNoExecutionMarker
    ? mergeExpectations(expectation.excludes, /EXECUTED/)
    : expectation.excludes;
  assertCliSuccess(result, {
    ...(expectation.stdout !== undefined ? { stdout: expectation.stdout } : {}),
    ...(expectation.stderr !== undefined ? { stderr: expectation.stderr } : {}),
    ...(expectation.stdoutExcludes !== undefined ? { stdoutExcludes: expectation.stdoutExcludes } : {}),
    ...(expectation.stderrExcludes !== undefined ? { stderrExcludes: expectation.stderrExcludes } : {})
  });
  if (expectation.contains !== undefined) {
    assertTextMatches(result.stdout, expectation.contains, "stdout");
  }
  if (excludes !== undefined) {
    assertTextExcludes(result.stdout, excludes, "stdout");
  }
  return result;
}

export function assertCliDryRun(result: CliCommandResult, expectation: CliDryRunExpectation = {}): CliCommandResult {
  const stdoutExpectation = mergeExpectations(/Dry run plan/, expectation.stdout) ?? /Dry run plan/;
  assertCliSuccess(result, {
    stdout: stdoutExpectation,
    ...(expectation.stderr !== undefined ? { stderr: expectation.stderr } : {}),
    ...(expectation.stdoutExcludes !== undefined ? { stdoutExcludes: expectation.stdoutExcludes } : {}),
    ...(expectation.stderrExcludes !== undefined ? { stderrExcludes: expectation.stderrExcludes } : {})
  });
  if (expectation.contains !== undefined) {
    assertTextMatches(result.stdout, expectation.contains, "stdout");
  }
  if (expectation.excludes !== undefined) {
    assertTextExcludes(result.stdout, expectation.excludes, "stdout");
  }
  return result;
}

export function runPackDryRun(options: PackDryRunOptions = {}): PackEntry {
  const packageManager = options.packageManager ?? "pnpm";
  const args = options.args ?? ["pack", "--dry-run", "--json"];
  const commandOptions = {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: {
      ...process.env,
      ...options.env,
      GIT_TERMINAL_PROMPT: "0"
    },
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {})
  };
  const directResult = runCliCommand(packageManager, args, commandOptions);
  const corepackFallback = createCorepackInvocation(packageManager, args);
  const result = isMissingCommand(directResult, packageManager) && corepackFallback
    ? runCliCommand(corepackFallback.command, corepackFallback.args, commandOptions)
    : directResult;
  assertCliResult(result, { status: 0 });
  return parsePackJson(result.stdout);
}

export function parsePackJson(stdout: string): PackEntry {
  const jsonText = extractJsonText(stdout);
  const parsed = JSON.parse(jsonText) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  assert.equal(entries.length, 1, "Expected pack dry-run JSON to return one package entry.");
  const [entry] = entries;
  assertRecord(entry, "pack entry");
  assert.ok(Array.isArray(entry.files), "Unexpected pack dry-run JSON shape: files must be an array.");
  return entry as PackEntry;
}

export function getPackFilePaths(entry: PackEntry): readonly string[] {
  return Object.freeze(entry.files.map((file) => normalizePackPath(file.path)).sort(compareText));
}

export function assertPackContents(entry: PackEntry, expectedFiles: readonly string[]): PackContentsResult {
  const actualFiles = getPackFilePaths(entry);
  const normalizedExpected = Object.freeze([...new Set(expectedFiles.map(normalizePackPath))].sort(compareText));
  const missingFiles = normalizedExpected.filter((file) => !actualFiles.includes(file));
  const extraFiles = actualFiles.filter((file) => !normalizedExpected.includes(file));

  if (missingFiles.length > 0 || extraFiles.length > 0) {
    throw new Error([
      "Pack contents did not match the allowed publish file list.",
      `Missing: ${missingFiles.length === 0 ? "none" : missingFiles.join(", ")}`,
      `Extra: ${extraFiles.length === 0 ? "none" : extraFiles.join(", ")}`
    ].join("\n"));
  }

  return Object.freeze({ actualFiles, missingFiles: Object.freeze(missingFiles), extraFiles: Object.freeze(extraFiles) });
}

export function assertPackSafety(entry: PackEntry, options: PackSafetyOptions = {}): readonly string[] {
  const actualFiles = getPackFilePaths(entry);
  const allowedRootFiles = options.allowedRootFiles ?? defaultAllowedRootFiles;
  const allowedDistExtensions = options.allowedDistExtensions ?? defaultAllowedDistExtensions;
  const requiredRootFiles = options.requiredRootFiles ?? defaultAllowedRootFiles;
  const unsafeFiles = actualFiles.filter((file) => !isAllowedPackFile(file, allowedRootFiles, allowedDistExtensions));
  const missingRequiredFiles = requiredRootFiles.filter((file) => !actualFiles.includes(file));

  if (unsafeFiles.length > 0 || missingRequiredFiles.length > 0) {
    throw new Error([
      "Pack contents included files outside the safe publish boundary.",
      `Unsafe: ${unsafeFiles.length === 0 ? "none" : unsafeFiles.join(", ")}`,
      `Missing required root files: ${missingRequiredFiles.length === 0 ? "none" : missingRequiredFiles.join(", ")}`
    ].join("\n"));
  }

  return actualFiles;
}

export function assertTextMatches(value: string, expectation: TextExpectation, label = "text"): void {
  for (const expected of toExpectationList(expectation)) {
    if (typeof expected === "string") {
      assert.ok(value.includes(expected), `${label} did not include expected text ${JSON.stringify(expected)}.\nActual ${label}:\n${value}`);
    } else {
      assert.match(value, expected);
    }
  }
}

export function assertTextExcludes(value: string, expectation: TextExpectation, label = "text"): void {
  for (const excluded of toExpectationList(expectation)) {
    if (typeof excluded === "string") {
      assert.equal(value.includes(excluded), false, `${label} included excluded text ${JSON.stringify(excluded)}.\nActual ${label}:\n${value}`);
    } else {
      assert.doesNotMatch(value, excluded);
    }
  }
}

function extractJsonText(stdout: string): string {
  const firstArray = stdout.indexOf("[");
  const firstObject = stdout.indexOf("{");
  const starts = [firstArray, firstObject].filter((index) => index >= 0).sort((left, right) => left - right);
  if (starts.length === 0) {
    return stdout;
  }
  return stdout.slice(starts[0]);
}

function normalizePackPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^package\//, "");
}

function isAllowedPackFile(file: string, allowedRootFiles: readonly string[], allowedDistExtensions: readonly string[]): boolean {
  if (allowedRootFiles.includes(file)) {
    return true;
  }
  if (!file.startsWith("dist/") || file.endsWith("/")) {
    return false;
  }
  return allowedDistExtensions.some((extension) => file.endsWith(extension));
}

function mergeExpectations(left: TextExpectation | undefined, right: TextExpectation | undefined): TextExpectation | undefined {
  const values = [...toExpectationList(left), ...toExpectationList(right)];
  return values.length === 0 ? undefined : Object.freeze(values);
}

function toExpectationList(expectation: TextExpectation | undefined): readonly (string | RegExp)[] {
  if (expectation === undefined) {
    return [];
  }
  if (typeof expectation === "string" || expectation instanceof RegExp) {
    return [expectation];
  }
  return expectation;
}

function isMissingCommand(result: CliCommandResult, command: string): boolean {
  const error = result.error as NodeJS.ErrnoException | undefined;
  return command === "pnpm" && error?.code === "ENOENT";
}

function createCorepackInvocation(packageManager: string, args: readonly string[]): { readonly command: string; readonly args: readonly string[] } | undefined {
  if (packageManager !== "pnpm") {
    return undefined;
  }
  if (process.platform === "win32") {
    const corepackScript = join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js");
    if (existsSync(corepackScript)) {
      return { command: process.execPath, args: [corepackScript, packageManager, ...args] };
    }
  }
  return { command: "corepack", args: [packageManager, ...args] };
}

function assertExpectedValue(actual: unknown, expected: unknown, label: string): void {
  if (expected !== undefined) {
    assert.deepEqual(actual, expected, label);
  }
}

function assertExpectedText(actual: unknown, expected: string | RegExp | undefined, label: string): void {
  if (expected === undefined) {
    return;
  }
  if (typeof actual !== "string") {
    assert.fail(`${label} must be a string.`);
  }
  if (typeof expected === "string") {
    assert.equal(actual, expected, label);
  } else {
    assert.match(actual, expected);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Readonly<Record<string, unknown>> {
  assert.equal(typeof value, "object", `${label} must be an object.`);
  assert.notEqual(value, null, `${label} must not be null.`);
  assert.equal(Array.isArray(value), false, `${label} must not be an array.`);
}

function formatResultMessage(result: CliCommandResult, label: string): string {
  return [
    `${label} assertion failed for ${result.command} ${result.args.join(" ")}`.trim(),
    `status: ${String(result.status)}`,
    `signal: ${String(result.signal)}`,
    `stdout:\n${result.stdout}`,
    `stderr:\n${result.stderr}`
  ].join("\n");
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
