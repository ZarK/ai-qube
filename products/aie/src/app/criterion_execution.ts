import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutable } from '@tjalve/qube-core';
import type { Config, GateConfig } from '../config/index.js';
import { selectEnabledGates } from '../gate_config.js';
import { localReviewEvidenceSha256, verifyTrustedStoreChain } from '../local_review_evidence.js';
import { criterionInputDigest, hashFile, readCriterionInputs, type CriterionInput as SharedCriterionInput } from './criterion_inputs.js';
import type { PrGateExec, PrGateExecResult } from './pr_gate.js';
import {
  executableReviewCommandsTrusted,
  hash,
  mkdirTrustedStoreSync,
  scrubSecrets,
  writeReviewFileGuarded,
} from './local_review_runner_support.js';

const execFileAsync = promisify(execFile);
const STORE = ['.git', 'qube', 'aie'] as const;
const EXECUTION_DIR = [...STORE, 'host-provenance', 'executions'] as const;
const CONFIG_PATH = ['.qube', 'aie', 'config.json'] as const;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export interface CriterionInput extends SharedCriterionInput {}

interface GateIdentity {
  name: string;
  kind: GateConfig['kind'];
  command: string;
  stage: GateConfig['stage'];
  required: boolean;
  timeoutSeconds: number;
  workingDirectory: string;
  env: Array<{ name: string; sha256: string }>;
  externalService: boolean;
}

interface ExecutionReceipt {
  kind: 'criterion-execution';
  version: 1;
  headSha: string;
  gateName: string;
  gate: GateIdentity;
  command: string;
  argv: string[];
  workingDirectory: string;
  configSha256: string;
  inputs: CriterionInput[];
  inputDigestBefore: string;
  inputDigestAfter: string;
  observedInputDigestBefore: string;
  observedInputDigestAfter: string;
  exitCode: number;
  outputPath: string;
  outputSha256: string;
  startedAt: string;
  completedAt: string;
}

function digestBytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function repositoryPath(repoRoot: string, absolutePath: string): string {
  return relative(repoRoot, absolutePath).replace(/\\/gu, '/');
}

function configPath(repoRoot: string): string {
  return join(repoRoot, ...CONFIG_PATH);
}

function readConfigDigest(repoRoot: string): string {
  const path = configPath(repoRoot);
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie'], path);
  if (!lstatSync(path).isFile()) throw new Error(`Executor config is not a regular file: ${repositoryPath(repoRoot, path)}.`);
  return digestBytes(readFileSync(path));
}

function selectGate(config: Config, gateName: string): GateConfig {
  const matches = selectEnabledGates(config.gates, config.qualityControl).filter(gate => gate.name === gateName);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `Enabled gate ${JSON.stringify(gateName)} is not configured.`
      : `Enabled gate ${JSON.stringify(gateName)} is configured more than once.`);
  }
  const gate = matches[0];
  if (!Number.isSafeInteger(gate.timeoutSeconds) || gate.timeoutSeconds < 1) {
    throw new Error(`Gate ${gate.name} has an invalid execution deadline.`);
  }
  if (typeof gate.command !== 'string' || gate.command.trim() === '') throw new Error(`Gate ${gate.name} has an empty command.`);
  return gate;
}

function gateIdentity(gate: GateConfig): GateIdentity {
  return {
    name: gate.name,
    kind: gate.kind,
    command: gate.command,
    stage: gate.stage,
    required: gate.required,
    timeoutSeconds: gate.timeoutSeconds,
    workingDirectory: gate.workingDirectory.replace(/\\/gu, '/'),
    env: Object.entries(gate.env).sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ({ name, sha256: hash(value) })),
    externalService: gate.externalService,
  };
}

function sameJson(left: unknown, right: unknown): boolean {
  return localReviewEvidenceSha256(left) === localReviewEvidenceSha256(right);
}

function assertRepositoryGate(repoRoot: string, config: Config, gate: GateConfig): void {
  const path = configPath(repoRoot);
  verifyTrustedStoreChain(repoRoot, ['.qube', 'aie'], path);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('Executor config is not valid JSON.'); }
  if (!record(parsed) || !record(parsed.policy) || !record(parsed.policy.branch) || !record(parsed.policy.gates)) {
    throw new Error('Executor config does not contain the configured branch and gate policy.');
  }
  if (parsed.policy.branch.baseBranch !== config.baseBranch) throw new Error('Effective base branch does not match the repository config.');
  const definitions = parsed.policy.gates.definitions;
  if (!Array.isArray(definitions) || !definitions.some(definition => sameJson(definition, gate))) {
    throw new Error(`Gate ${gate.name} does not exactly match a repository-configured gate.`);
  }
}

function parseCommand(command: string): string[] {
  if (/[\u0000\r\n]/u.test(command)) throw new Error('Gate command contains a control character.');
  if (/[&|;<>`^%!$]/u.test(command)) throw new Error('Gate command contains unsupported shell syntax or expansion.');
  const args: string[] = [];
  let value = '';
  let quote: "'" | '"' | null = null;
  let token = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = null;
      else if (character === '\\' && quote === '"' && /["\\]/u.test(command[index + 1] ?? '')) value += command[++index];
      else value += character;
      token = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      token = true;
    } else if (/\s/u.test(character)) {
      if (token) {
        args.push(value);
        value = '';
        token = false;
      }
    } else if (character === '\\' && /[\s'"\\]/u.test(command[index + 1] ?? '')) {
      value += command[++index];
      token = true;
    } else {
      value += character;
      token = true;
    }
  }
  if (quote) throw new Error('Gate command contains an unterminated quote.');
  if (token) args.push(value);
  if (args.length === 0 || args[0] === '') throw new Error('Gate command has no executable.');
  return args;
}

function resolveWorkingDirectory(repoRoot: string, configured: string): { absolute: string; relative: string } {
  if (configured.trim() === '' || isAbsolute(configured)) throw new Error('Gate working directory must be repository-relative.');
  const normalized = configured.replace(/\\/gu, '/');
  if (normalized.split('/').includes('..')) throw new Error('Gate working directory cannot contain parent traversal.');
  const absolute = resolve(repoRoot, configured);
  const rootReal = realpathSync(repoRoot);
  const directoryReal = realpathSync(absolute);
  if (directoryReal !== rootReal && !directoryReal.startsWith(rootReal + sep)) {
    throw new Error(`Gate working directory resolves outside the repository: ${configured}.`);
  }
  if (!statSync(absolute).isDirectory()) throw new Error(`Gate working directory is not a directory: ${configured}.`);
  let current = repoRoot;
  for (const segment of relative(repoRoot, absolute).replace(/\\/gu, '/').split('/').filter(Boolean)) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Gate working directory uses a symlink: ${configured}.`);
  }
  return { absolute, relative: repositoryPath(repoRoot, absolute) || '.' };
}

function currentInputs(repoRoot: string, inputs: readonly CriterionInput[]): CriterionInput[] {
  const actual = inputs.map(input => {
    let current = repoRoot;
    for (const segment of input.path.split('/')) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) throw new Error(`Criterion execution input became a symlink or junction: ${input.path}.`);
    }
    return { kind: input.kind, path: input.path, sha256: hashFile(current) };
  });
  const checked = readCriterionInputs(actual, repoRoot, 'Criterion execution inputs');
  if (checked.errors.length) throw new Error(checked.errors.join(' '));
  return checked.inputs;
}

function boundedOutput(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(scrubSecrets(text), 'utf8');
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text: bytes.toString('utf8'), truncated: false };
  return { text: bytes.subarray(0, MAX_OUTPUT_BYTES).toString('utf8'), truncated: true };
}

function validateWindowsLaunch(values: readonly string[]): void {
  const unsafe = values.find(value => /[\u0000\r\n&|<>^%!()$`;]/u.test(value));
  if (unsafe !== undefined) {
    throw new Error(`Refusing to launch a Windows command wrapper whose resolved path or argument contains shell syntax or expansion: ${JSON.stringify(unsafe)}.`);
  }
}

async function defaultExec(args: string[], cwd: string, gate: GateConfig): Promise<PrGateExecResult> {
  const [configuredFile, ...configuredArgs] = args;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  Object.assign(env, gate.env);
  let file = configuredFile;
  let rest = configuredArgs;
  let windowsVerbatimArguments = false;
  if (process.platform === 'win32') {
    let resolvedPath: string | null = null;
    if (configuredFile.includes('/') || configuredFile.includes('\\')) {
      const candidate = resolve(cwd, configuredFile);
      try { if (lstatSync(candidate).isFile()) resolvedPath = candidate; } catch { resolvedPath = null; }
    } else {
      resolvedPath = resolveExecutable(configuredFile, { env, platform: 'win32' }).resolvedPath;
    }
    if (resolvedPath && /\.(?:cmd|bat)$/iu.test(resolvedPath)) {
      validateWindowsLaunch([resolvedPath, ...configuredArgs]);
      const quote = (value: string): string => /[\s"]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
      const commandLine = [resolvedPath, ...configuredArgs].map(quote).join(' ');
      file = env.ComSpec || env.COMSPEC || 'cmd.exe';
      rest = ['/d', '/s', '/c', `"${commandLine}"`];
      windowsVerbatimArguments = true;
    } else if (resolvedPath) file = resolvedPath;
  }
  try {
    const result = await execFileAsync(file, rest, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: gate.timeoutSeconds * 1000,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      windowsVerbatimArguments,
    });
    return { args, exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    const failure = error as { code?: number | string; killed?: boolean; stdout?: string; stderr?: string; message?: string };
    const timedOut = failure.killed === true || failure.code === 'ETIMEDOUT';
    const exitCode = timedOut ? 124 : typeof failure.code === 'number' ? failure.code : failure.code === 'ENOENT' ? 127 : 1;
    return { args, exitCode, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? 'Gate execution failed.' };
  }
}

export async function captureCriterionExecution(input: {
  repoRoot: string;
  config: Config;
  gateName: string;
  headSha: string;
  inputs: readonly CriterionInput[];
  readInputDigest: () => string;
  exec?: PrGateExec;
}): Promise<{ path: string; sha256: string }> {
  if (!GIT_SHA.test(input.headSha)) throw new Error('Criterion execution requires a valid Git head SHA.');
  const gate = selectGate(input.config, input.gateName);
  const args = parseCommand(gate.command);
  const cwd = resolveWorkingDirectory(input.repoRoot, gate.workingDirectory);
  const checkedInputs = readCriterionInputs(input.inputs, input.repoRoot, 'Criterion execution inputs');
  if (checkedInputs.errors.length) throw new Error(checkedInputs.errors.join(' '));
  const criterionInputs = checkedInputs.inputs;
  verifyTrustedStoreChain(input.repoRoot, ['.qube', 'aie'], configPath(input.repoRoot));
  if (!await executableReviewCommandsTrusted(input.repoRoot, input.config.baseBranch)) {
    throw new Error(`Refusing to execute gate ${gate.name}: .qube/aie/config.json is not unchanged from trusted base ${input.config.baseBranch}.`);
  }
  assertRepositoryGate(input.repoRoot, input.config, gate);
  const configSha256 = readConfigDigest(input.repoRoot);
  const directory = join(input.repoRoot, ...EXECUTION_DIR);
  verifyTrustedStoreChain(input.repoRoot, STORE, directory);
  const inputDigestBefore = criterionInputDigest(currentInputs(input.repoRoot, criterionInputs));
  const observedDigestBefore = input.readInputDigest();
  if (!SHA256.test(observedDigestBefore)) throw new Error('Criterion execution input observer returned an invalid SHA-256 digest.');
  if (observedDigestBefore !== inputDigestBefore) throw new Error('Criterion execution input observer does not match the current required inputs.');
  const startedAt = new Date().toISOString();
  let result: PrGateExecResult;
  try {
    result = input.exec ? await input.exec(args, cwd.absolute) : await defaultExec(args, cwd.absolute, gate);
  } catch (error) {
    result = { args, exitCode: 1, stdout: '', stderr: error instanceof Error ? error.message : 'Gate execution failed.' };
  }
  const completedAt = new Date().toISOString();
  let observedDigestAfter: string;
  let observerError: string | null = null;
  try { observedDigestAfter = input.readInputDigest(); }
  catch (error) {
    observerError = error instanceof Error ? error.message : 'Criterion input observer failed after execution.';
    observedDigestAfter = hash(`invalid:${observerError}`);
  }
  let inputDigestAfter: string;
  let currentInputError: string | null = null;
  try { inputDigestAfter = criterionInputDigest(currentInputs(input.repoRoot, criterionInputs)); }
  catch (error) {
    currentInputError = error instanceof Error ? error.message : 'Criterion inputs could not be read after execution.';
    inputDigestAfter = hash(`invalid:${currentInputError}`);
  }
  const stdout = boundedOutput(result.stdout);
  const stderr = boundedOutput(result.stderr);
  const executionId = randomUUID();
  const outputPath = join(directory, `${executionId}.output.json`);
  const receiptPath = join(directory, `${executionId}.json`);
  mkdirTrustedStoreSync(directory, { repoRoot: input.repoRoot, subtree: STORE });
  const outputText = `${JSON.stringify({
    kind: 'criterion-execution-output', version: 1, stdout: stdout.text, stderr: stderr.text,
    stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
  }, null, 2)}\n`;
  writeReviewFileGuarded(outputPath, outputText, { repoRoot: input.repoRoot, subtree: STORE });
  const receipt: ExecutionReceipt = {
    kind: 'criterion-execution', version: 1, headSha: input.headSha, gateName: gate.name,
    gate: gateIdentity(gate), command: gate.command, argv: args, workingDirectory: cwd.relative,
    configSha256, inputs: criterionInputs, inputDigestBefore, inputDigestAfter,
    observedInputDigestBefore: observedDigestBefore, observedInputDigestAfter: observedDigestAfter,
    exitCode: Number.isSafeInteger(result.exitCode) ? result.exitCode : 1,
    outputPath: repositoryPath(input.repoRoot, outputPath), outputSha256: digestBytes(outputText),
    startedAt, completedAt,
  };
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
  writeReviewFileGuarded(receiptPath, receiptText, { repoRoot: input.repoRoot, subtree: STORE });
  if (inputDigestBefore !== inputDigestAfter || observedDigestBefore !== observedDigestAfter || currentInputError || observerError) {
    throw new Error(`Gate ${gate.name} completed after its criterion inputs changed; the failed receipt was preserved at ${repositoryPath(input.repoRoot, receiptPath)}.`);
  }
  return { path: repositoryPath(input.repoRoot, receiptPath), sha256: digestBytes(receiptText) };
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function gitObjectExists(repoRoot: string, sha: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function isAncestor(repoRoot: string, ancestor: string, head: string): boolean {
  try {
    execFileSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, head], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function repositoryCommandsTrusted(repoRoot: string, baseRef: string): boolean {
  const checks: readonly string[][] = [
    ['rev-parse', '--is-inside-work-tree'],
    ['rev-parse', '--verify', baseRef],
    ['diff', '--quiet', '--', '.qube/aie/config.json'],
    ['diff', '--quiet', '--cached', '--', '.qube/aie/config.json'],
    ['diff', '--quiet', `${baseRef}...HEAD`, '--', '.qube/aie/config.json'],
  ];
  try {
    for (const args of checks) execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateCriterionExecution(input: {
  repoRoot: string;
  config: Config;
  reference: { path: string; sha256: string };
  headSha: string;
  inputs: readonly CriterionInput[];
  inputDigest: string;
  recordedAt: string;
  expectedGateName?: string;
}): string[] {
  const errors: string[] = [];
  if (!SHA256.test(input.reference.sha256)) errors.push('Criterion execution reference has an invalid SHA-256 digest.');
  if (!SHA256.test(input.inputDigest)) errors.push('Current criterion input digest is not a valid SHA-256 digest.');
  if (!GIT_SHA.test(input.headSha)) errors.push('Current criterion head is not a valid Git SHA.');
  if (!validInstant(input.recordedAt)) errors.push('Criterion proof recordedAt is not a canonical ISO timestamp.');
  if (!repositoryCommandsTrusted(input.repoRoot, input.config.baseBranch)) errors.push(`Executor config is not unchanged from trusted base ${input.config.baseBranch}.`);
  const checkedRequired = readCriterionInputs(input.inputs, input.repoRoot, 'Current criterion inputs');
  const requiredInputs = checkedRequired.inputs;
  errors.push(...checkedRequired.errors);
  if (checkedRequired.errors.length === 0 && criterionInputDigest(requiredInputs) !== input.inputDigest) errors.push('Current criterion input digest does not match the required input list.');
  const relativePath = input.reference.path.replace(/\\/gu, '/');
  if (isAbsolute(relativePath) || relativePath.split('/').includes('..') || !/^\.git\/qube\/aie\/host-provenance\/executions\/[^/]+\.json$/u.test(relativePath)) {
    errors.push('Criterion execution reference must name a receipt in the trusted execution store.');
    return errors;
  }
  const receiptPath = join(input.repoRoot, ...relativePath.split('/'));
  let receiptBytes: Buffer;
  let parsed: unknown;
  try {
    verifyTrustedStoreChain(input.repoRoot, STORE, receiptPath);
    if (!lstatSync(receiptPath).isFile()) throw new Error('receipt is not a regular file');
    receiptBytes = readFileSync(receiptPath);
    parsed = JSON.parse(receiptBytes.toString('utf8'));
    if (digestBytes(receiptBytes) !== input.reference.sha256) errors.push('Criterion execution receipt SHA-256 does not match its reference.');
  } catch (error) {
    errors.push(`Criterion execution receipt could not be read from the trusted store: ${error instanceof Error ? error.message : 'unknown read failure'}`);
    return errors;
  }
  if (!record(parsed) || parsed.kind !== 'criterion-execution' || parsed.version !== 1) {
    errors.push('Criterion execution receipt has an unsupported shape.');
    return errors;
  }
  if (input.expectedGateName !== undefined && parsed.gateName !== input.expectedGateName) errors.push(`Criterion execution receipt gate does not match expected gate ${input.expectedGateName}.`);
  let gate: GateConfig | null = null;
  try { gate = selectGate(input.config, typeof parsed.gateName === 'string' ? parsed.gateName : ''); }
  catch (error) { errors.push(error instanceof Error ? error.message : 'Receipt gate is not configured.'); }
  if (gate) {
    try { assertRepositoryGate(input.repoRoot, input.config, gate); }
    catch (error) { errors.push(error instanceof Error ? error.message : 'Configured gate identity could not be verified.'); }
  }
  let configSha256 = '';
  try { configSha256 = readConfigDigest(input.repoRoot); }
  catch (error) { errors.push(`Executor config could not be verified: ${error instanceof Error ? error.message : 'unknown read failure'}`); }
  if (parsed.configSha256 !== configSha256) errors.push('Criterion execution receipt does not match the current Executor config.');
  if (gate && !sameJson(parsed.gate, gateIdentity(gate))) errors.push(`Criterion execution receipt does not match configured gate ${gate.name}.`);
  if (gate && (parsed.command !== gate.command || !sameJson(parsed.argv, (() => { try { return parseCommand(gate.command); } catch { return null; } })()))) {
    errors.push(`Criterion execution receipt command does not match configured gate ${gate.name}.`);
  }
  if (typeof parsed.workingDirectory !== 'string') errors.push('Criterion execution receipt omits its working directory.');
  else if (gate) {
    try {
      if (resolveWorkingDirectory(input.repoRoot, gate.workingDirectory).relative !== parsed.workingDirectory) errors.push(`Criterion execution receipt working directory does not match configured gate ${gate.name}.`);
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Gate working directory is invalid.'); }
  }
  if (!GIT_SHA.test(String(parsed.headSha ?? '')) || !gitObjectExists(input.repoRoot, String(parsed.headSha))) {
    errors.push('Criterion execution receipt head is not a repository commit.');
  } else if (parsed.headSha !== input.headSha && (!gitObjectExists(input.repoRoot, input.headSha) || !isAncestor(input.repoRoot, String(parsed.headSha), input.headSha))) {
    errors.push('Criterion execution receipt head is not the current head or one of its ancestors.');
  }
  if (parsed.exitCode !== 0) errors.push(`Criterion execution gate did not pass (exit ${String(parsed.exitCode)}).`);
  const checkedReceipt = readCriterionInputs(parsed.inputs, input.repoRoot, 'Criterion execution receipt inputs');
  errors.push(...checkedReceipt.errors);
  if (checkedReceipt.errors.length === 0) {
    const receiptDigest = criterionInputDigest(checkedReceipt.inputs);
    if (parsed.inputDigestBefore !== receiptDigest || parsed.inputDigestAfter !== receiptDigest) errors.push('Criterion execution input digest is stale or changed during execution.');
  }
  if (!SHA256.test(String(parsed.observedInputDigestBefore ?? '')) || !SHA256.test(String(parsed.observedInputDigestAfter ?? ''))) {
    errors.push('Criterion execution receipt has an invalid input observer digest.');
  } else if (parsed.observedInputDigestBefore !== parsed.inputDigestBefore || parsed.observedInputDigestAfter !== parsed.inputDigestAfter) {
    errors.push('Criterion execution input observer does not match the canonical input digest.');
  } else if (parsed.observedInputDigestBefore !== parsed.observedInputDigestAfter) errors.push('Criterion execution input observer detected changes during execution.');
  if (checkedReceipt.errors.length === 0) for (const required of requiredInputs) {
    if (!checkedReceipt.inputs.some(candidate => candidate.kind === required.kind && candidate.path === required.path && candidate.sha256 === required.sha256)) {
      errors.push(`Criterion execution receipt does not include current input ${required.kind} ${required.path}.`);
    }
  }
  if (!validInstant(parsed.startedAt) || !validInstant(parsed.completedAt)) errors.push('Criterion execution receipt has an invalid execution timestamp.');
  else {
    if (Date.parse(parsed.startedAt) > Date.parse(parsed.completedAt)) errors.push('Criterion execution receipt completes before it starts.');
    if (validInstant(input.recordedAt) && Date.parse(parsed.completedAt) > Date.parse(input.recordedAt)) errors.push('Criterion proof predates the recorded execution.');
    if (Date.parse(parsed.completedAt) > Date.now()) errors.push('Criterion execution receipt completion time is in the future.');
  }
  if (typeof parsed.outputPath !== 'string' || !/^\.git\/qube\/aie\/host-provenance\/executions\/[^/]+\.output\.json$/u.test(parsed.outputPath)) {
    errors.push('Criterion execution receipt has an invalid output artifact path.');
  } else {
    const outputPath = join(input.repoRoot, ...parsed.outputPath.split('/'));
    const receiptName = relative(join(input.repoRoot, ...EXECUTION_DIR), receiptPath).replace(/\.json$/u, '');
    const outputName = relative(join(input.repoRoot, ...EXECUTION_DIR), outputPath).replace(/\.output\.json$/u, '');
    if (receiptName !== outputName) errors.push('Criterion execution receipt references output from a different execution.');
    try {
      verifyTrustedStoreChain(input.repoRoot, STORE, outputPath);
      if (!lstatSync(outputPath).isFile()) throw new Error('output is not a regular file');
      const outputBytes = readFileSync(outputPath);
      if (!SHA256.test(String(parsed.outputSha256 ?? '')) || digestBytes(outputBytes) !== parsed.outputSha256) errors.push('Criterion execution output SHA-256 does not match the persisted artifact.');
    } catch (error) {
      errors.push(`Criterion execution output could not be read from the trusted store: ${error instanceof Error ? error.message : 'unknown read failure'}`);
    }
  }
  return errors;
}
