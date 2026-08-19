import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const suiteRoot = realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));

function runCommand(command, args, cwd) {
  process.stdout.write(`> ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${String(result.status)}.`);
}

function runPnpm(args, cwd) {
  if (process.platform === 'win32') {
    runCommand(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', ...args], cwd);
  } else {
    runCommand('pnpm', args, cwd);
  }
}

function packageContext(cwd = process.cwd()) {
  const packageRoot = realpathSync.native(cwd);
  const relativeRoot = path.relative(suiteRoot, packageRoot);
  if (relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) throw new Error('CI pack package must stay inside the suite.');
  const manifestPath = path.join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) throw new Error('CI pack package.json is missing.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name ?? '')) throw new Error('CI pack package name is invalid.');
  const buildScript = typeof manifest.scripts?.['ci:build'] === 'string' ? 'ci:build' : 'build';
  if (typeof manifest.scripts?.[buildScript] !== 'string') throw new Error(`${manifest.name} does not declare a CI pack build script.`);
  return { packageRoot, buildScript };
}

export function checkCiPack(cwd = process.cwd(), commands = { runCommand, runPnpm }) {
  const context = packageContext(cwd);
  const resolveScript = path.join(suiteRoot, 'scripts', 'resolve-publish-dependencies.mjs');
  const checkScript = path.join(suiteRoot, 'scripts', 'check-publish-manifest.mjs');
  const restoreScript = path.join(suiteRoot, 'scripts', 'restore-publish-dependencies.mjs');
  let primaryFailure = null;

  try {
    commands.runCommand(process.execPath, [resolveScript], context.packageRoot);
    commands.runCommand(process.execPath, [checkScript], context.packageRoot);
    commands.runPnpm(['run', context.buildScript], context.packageRoot);
    commands.runPnpm(['--config.ignore-scripts=true', 'pack', '--dry-run', '--json'], context.packageRoot);
  } catch (error) {
    primaryFailure = error;
  }

  try {
    commands.runCommand(process.execPath, [restoreScript], context.packageRoot);
  } catch (restoreFailure) {
    if (primaryFailure) throw new AggregateError([primaryFailure, restoreFailure], 'CI pack failed and the publish manifest could not be restored.');
    throw restoreFailure;
  }
  if (primaryFailure) throw primaryFailure;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkCiPack();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
