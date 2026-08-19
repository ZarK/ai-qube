import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCorePackages } from './ci-core-plan.mjs';

const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const supportedStages = new Set(['build', 'typecheck', 'test', 'pack']);

function readPlan(serialized = process.env.CI_CORE_PLAN) {
  if (!serialized) throw new Error('CI_CORE_PLAN is required.');
  const plan = JSON.parse(serialized);
  if (!plan || plan.version !== 1 || plan.core !== true) throw new Error('CI_CORE_PLAN must be a version 1 core plan.');
  return plan;
}

function runCommand(command, args) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd: suiteRoot, env: process.env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}.`);
}

function runPackageScript(packageName, script) {
  const args = ['--filter', packageName, 'run', script];
  if (process.platform === 'win32') {
    runCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args]);
  } else {
    runCommand('pnpm', args);
  }
}

function ciScript(packageEntry, script) {
  const preferred = script === 'pack:check' ? 'ci:pack' : `ci:${script}`;
  return typeof packageEntry.scripts[preferred] === 'string' ? preferred : script;
}

function validateTargets(plan, packages) {
  const byName = new Map(packages.map(entry => [entry.name, entry]));
  for (const field of ['buildTargets', 'typecheckTargets', 'testTargets']) {
    if (!Array.isArray(plan[field])) throw new Error(`CI_CORE_PLAN.${field} must be an array.`);
    for (const packageName of plan[field]) {
      const packageEntry = byName.get(packageName);
      if (!packageEntry || typeof packageEntry.scripts[field === 'buildTargets' ? 'build' : field === 'typecheckTargets' ? 'typecheck' : 'test'] !== 'string') {
        throw new Error(`CI_CORE_PLAN.${field} contains unsupported package ${String(packageName)}.`);
      }
    }
  }
  if (!Array.isArray(plan.packTargets)) throw new Error('CI_CORE_PLAN.packTargets must be an array.');
  for (const target of plan.packTargets) {
    if (!target || typeof target.name !== 'string' || !['pack:check', 'release:check'].includes(target.script)) {
      throw new Error('CI_CORE_PLAN.packTargets contains an invalid target.');
    }
    if (typeof byName.get(target.name)?.scripts[target.script] !== 'string') {
      throw new Error(`CI_CORE_PLAN.packTargets contains unsupported package ${target.name}.`);
    }
  }
}

function runRootTests() {
  const testDirectory = path.join(suiteRoot, 'test');
  const testFiles = readdirSync(testDirectory)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join('test', name));
  if (testFiles.length === 0) throw new Error('Full core CI requires root test files.');
  runCommand(process.execPath, ['--test', '--test-concurrency=1', ...testFiles]);
}

export function runCoreStage(stage, serializedPlan = process.env.CI_CORE_PLAN) {
  if (!supportedStages.has(stage)) throw new Error(`Unsupported core CI stage: ${String(stage)}.`);
  const plan = readPlan(serializedPlan);
  const packages = loadCorePackages(suiteRoot);
  validateTargets(plan, packages);
  const byName = new Map(packages.map(entry => [entry.name, entry]));

  if (stage === 'build') {
    for (const packageName of plan.buildTargets) runPackageScript(packageName, ciScript(byName.get(packageName), 'build'));
  } else if (stage === 'typecheck') {
    for (const packageName of plan.typecheckTargets) runPackageScript(packageName, ciScript(byName.get(packageName), 'typecheck'));
  } else if (stage === 'test') {
    if (plan.rootTests === true) runRootTests();
    for (const packageName of plan.testTargets) runPackageScript(packageName, ciScript(byName.get(packageName), 'test'));
  } else {
    for (const target of plan.packTargets) runPackageScript(target.name, ciScript(byName.get(target.name), target.script));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCoreStage(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
