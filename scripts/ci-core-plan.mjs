import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const suiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoots = Object.freeze(['packages', 'adapters', 'products', 'plugins']);
const excludedPackagePaths = Object.freeze(['products/aiq']);
const fullPlanPrefixes = Object.freeze(['.github/workflows/', 'scripts/', 'test/']);
const fullPlanFiles = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc']);

function normalizeChangedPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Changed paths must be non-empty strings.');
  const normalized = value.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`Changed path must stay relative to the repository: ${value}`);
  }
  return normalized;
}

function isExcludedPackagePath(relativePath) {
  return excludedPackagePaths.some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

export function loadCorePackages(root = suiteRoot) {
  const manifests = [];
  for (const packageRoot of packageRoots) {
    const absoluteRoot = path.join(root, packageRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const directory of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const relativePath = `${packageRoot}/${directory.name}`;
      if (isExcludedPackagePath(relativePath)) continue;
      const manifestPath = path.join(root, relativePath, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
        throw new Error(`${relativePath}/package.json must declare a package name.`);
      }
      if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(manifest.name)) {
        throw new Error(`${relativePath}/package.json declares an unsafe package name.`);
      }
      manifests.push({
        name: manifest.name,
        path: relativePath,
        scripts: Object.freeze({ ...(manifest.scripts ?? {}) }),
        dependencyNames: Object.freeze(Object.keys({
          ...(manifest.dependencies ?? {}),
          ...(manifest.optionalDependencies ?? {}),
          ...(manifest.peerDependencies ?? {}),
          ...(manifest.devDependencies ?? {}),
        })),
      });
    }
  }

  manifests.sort((left, right) => left.path.localeCompare(right.path));
  const packageNames = new Set(manifests.map(entry => entry.name));
  if (packageNames.size !== manifests.length) throw new Error('Core CI package names must be unique.');
  return manifests.map(entry => Object.freeze({
    ...entry,
    dependencyNames: Object.freeze(entry.dependencyNames.filter(name => packageNames.has(name))),
  }));
}

function addClosure(seeds, edges) {
  const selected = new Set(seeds);
  const pending = [...seeds];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const next of edges.get(current) ?? []) {
      if (selected.has(next)) continue;
      selected.add(next);
      pending.push(next);
    }
  }
  return selected;
}

function orderDependenciesFirst(names, packages) {
  const selected = new Set(names);
  const byName = new Map(packages.map(entry => [entry.name, entry]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Core CI package dependency cycle includes ${name}.`);
    visiting.add(name);
    const packageEntry = byName.get(name);
    if (!packageEntry) throw new Error(`Core CI selected unknown package ${name}.`);
    for (const dependency of packageEntry.dependencyNames) {
      if (selected.has(dependency)) visit(dependency);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }

  for (const packageEntry of packages) {
    if (selected.has(packageEntry.name)) visit(packageEntry.name);
  }
  return ordered;
}

function isDocumentationOnly(changedPath) {
  return changedPath === 'README.md'
    || changedPath === 'LICENSE'
    || changedPath.startsWith('docs/')
    || changedPath.startsWith('.github/ISSUE_TEMPLATE/')
    || changedPath === '.github/PULL_REQUEST_TEMPLATE.md';
}

function isFullPlanPath(changedPath) {
  return fullPlanFiles.has(changedPath)
    || changedPath.endsWith('/package.json')
    || fullPlanPrefixes.some(prefix => changedPath.startsWith(prefix));
}

function isAiqPath(changedPath) {
  return changedPath === 'products/aiq' || changedPath.startsWith('products/aiq/');
}

function createPlan(packages, verifyNames, options) {
  const byName = new Map(packages.map(entry => [entry.name, entry]));
  const dependencyEdges = new Map(packages.map(entry => [entry.name, entry.dependencyNames]));
  const buildNames = addClosure(verifyNames, dependencyEdges);
  const verifyTargets = orderDependenciesFirst(verifyNames, packages);
  const buildTargets = orderDependenciesFirst(buildNames, packages).filter(name => typeof byName.get(name)?.scripts.build === 'string');
  const typecheckTargets = verifyTargets.filter(name => typeof byName.get(name)?.scripts.typecheck === 'string');
  const testTargets = verifyTargets.filter(name => {
    const scripts = byName.get(name)?.scripts ?? {};
    return typeof scripts.test === 'string' && typeof scripts['release:check'] !== 'string';
  });
  const packTargets = verifyTargets.flatMap(name => {
    const scripts = byName.get(name)?.scripts ?? {};
    if (typeof scripts['pack:check'] === 'string') return [{ name, script: 'pack:check' }];
    if (typeof scripts['release:check'] === 'string') return [{ name, script: 'release:check' }];
    return [];
  });

  return Object.freeze({
    version: 1,
    core: verifyTargets.length > 0,
    aiq: options.aiq,
    full: options.full,
    reason: options.reason,
    changedPackages: Object.freeze([...options.changedPackages]),
    buildTargets: Object.freeze(buildTargets),
    typecheckTargets: Object.freeze(typecheckTargets),
    testTargets: Object.freeze(testTargets),
    packTargets: Object.freeze(packTargets.map(target => Object.freeze(target))),
    rootTests: options.full,
    manifestChecks: verifyTargets.length > 0,
  });
}

export function planCoreCi(changedPaths, root = suiteRoot) {
  if (!Array.isArray(changedPaths) || changedPaths.length === 0) throw new Error('At least one changed path is required.');
  const normalizedPaths = changedPaths.map(normalizeChangedPath);
  const packages = loadCorePackages(root);
  const byPath = [...packages].sort((left, right) => right.path.length - left.path.length);
  const changedPackages = new Set();
  let aiq = false;
  let fullReason = null;

  for (const changedPath of normalizedPaths) {
    if (isFullPlanPath(changedPath)) {
      fullReason ??= `full-sensitive-path:${changedPath}`;
      if (isAiqPath(changedPath) || changedPath.startsWith('.github/workflows/') || fullPlanFiles.has(changedPath)) aiq = true;
      continue;
    }
    if (isAiqPath(changedPath)) {
      aiq = true;
      continue;
    }
    const owningPackage = byPath.find(entry => changedPath === entry.path || changedPath.startsWith(`${entry.path}/`));
    if (owningPackage) {
      changedPackages.add(owningPackage.name);
      continue;
    }
    if (isDocumentationOnly(changedPath)) continue;
    fullReason ??= `unmapped-path:${changedPath}`;
  }

  if (fullReason) {
    return createPlan(packages, new Set(packages.map(entry => entry.name)), {
      aiq,
      full: true,
      reason: fullReason,
      changedPackages,
    });
  }
  if (changedPackages.size === 0) {
    return createPlan(packages, new Set(), {
      aiq,
      full: false,
      reason: aiq ? 'aiq-only' : 'documentation-only',
      changedPackages,
    });
  }

  const reverseEdges = new Map(packages.map(entry => [entry.name, []]));
  for (const packageEntry of packages) {
    for (const dependency of packageEntry.dependencyNames) reverseEdges.get(dependency)?.push(packageEntry.name);
  }
  const verifyNames = addClosure(changedPackages, reverseEdges);
  return createPlan(packages, verifyNames, {
    aiq,
    full: false,
    reason: 'mapped-packages',
    changedPackages,
  });
}

function parseCliArguments(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== '--paths-file' && argument !== '--github-output') throw new Error(`Unknown argument: ${argument}`);
    const value = args[index + 1];
    if (!value) throw new Error(`${argument} requires a value.`);
    values[argument.slice(2)] = value;
    index += 1;
  }
  if (!values['paths-file']) throw new Error('--paths-file is required.');
  return values;
}

export function runCorePlanCli(args = process.argv.slice(2)) {
  const options = parseCliArguments(args);
  const changedPaths = readFileSync(options['paths-file'], 'utf8').split(/\r?\n/).filter(Boolean);
  const plan = planCoreCi(changedPaths);
  const serialized = JSON.stringify(plan);
  if (options['github-output']) {
    appendFileSync(options['github-output'], `core=${String(plan.core)}\naiq=${String(plan.aiq)}\ncore_plan=${serialized}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCorePlanCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
