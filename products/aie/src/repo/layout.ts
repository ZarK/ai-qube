import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { RepoAffectedProject, RepoAffectedResult, RepoCiHint, RepoLayoutInspection, RepoLayoutKind, RepoPackageManager, RepoPathSignal, RepoProject, RepoRootMarker } from '@tjalve/qube-core';
import { configToExecutorPolicy } from '../config_policy.js';
import type { Config } from '../config/index.js';
import { createLocalGitRepositoryProvider } from '../providers/local/local_git_provider.js';
import type { GitExec } from '../providers/local/local_git_provider.js';

interface PackageJson {
  readonly name?: unknown;
  readonly workspaces?: unknown;
  readonly scripts?: unknown;
}

export interface RepoInspectOptions {
  readonly config: Config;
  readonly cwd?: string;
  readonly git?: GitExec;
}

export interface RepoAffectedOptions extends RepoInspectOptions {
  readonly changedPaths?: readonly string[];
}

export interface RepoInspectCommandResult extends RepoLayoutInspection {
  readonly ok: true;
  readonly command: 'repo inspect';
}

export interface RepoAffectedCommandResult extends RepoAffectedResult {
  readonly ok: true;
  readonly command: 'repo affected';
}

function portablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function readPackageJson(root: string, path = 'package.json'): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function readWorkspacePatterns(packageJson: PackageJson | null, root: string): string[] {
  const workspaces = packageJson?.workspaces;
  if (Array.isArray(workspaces)) return workspaces.filter((value): value is string => typeof value === 'string');
  if (workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages)) {
    return (workspaces as { packages: unknown[] }).packages.filter((value): value is string => typeof value === 'string');
  }
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(workspaceFile)) return [];
  const patterns: string[] = [];
  for (const line of readFileSync(workspaceFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+["']?([^"']+)["']?\s*$/);
    if (match) patterns.push(match[1]);
  }
  return patterns;
}

function expandWorkspacePattern(root: string, pattern: string): string[] {
  const normalized = portablePath(pattern).replace(/\/+$/, '');
  if (normalized.includes('**') || normalized.startsWith('!')) return [];
  if (!normalized.includes('*')) return existsSync(join(root, normalized, 'package.json')) ? [normalized] : [];
  const starIndex = normalized.indexOf('*');
  const prefix = normalized.slice(0, starIndex).replace(/\/+$/, '');
  const suffix = normalized.slice(starIndex + 1).replace(/^\/+/, '');
  const base = prefix === '' ? root : join(root, prefix);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => portablePath(join(prefix, entry.name, suffix)))
    .filter(path => existsSync(join(root, path, 'package.json')));
}

function projectId(path: string, packageName: string | null): string {
  return packageName ?? (path === '.' ? 'root' : portablePath(path).replace(/[^a-zA-Z0-9._-]+/g, '-'));
}

function packageManagerForPath(packageManagers: readonly RepoPackageManager[], path: string): string | null {
  const normalized = path === '.' ? '' : `${portablePath(path).replace(/\/+$/, '')}/`;
  const match = packageManagers.find(manager => manager.manifestPath === `${normalized}package.json`);
  if (match?.kind && match.kind !== 'unknown') return match.kind;
  return packageManagers.find(manager => manager.manifestPath === 'package.json')?.kind ?? match?.kind ?? null;
}

function gatesForProject(path: string): string[] {
  if (path === '.') return ['build', 'typecheck', 'test'];
  return ['build', 'typecheck', 'test'];
}

function detectPackageManagers(root: string | null): RepoPackageManager[] {
  if (!root) return [];
  const repoRoot = root;
  const managers: RepoPackageManager[] = [];
  function addPackage(path: string): void {
    const prefix = path === '.' ? '' : `${path}/`;
    const lockfiles: Array<[RepoPackageManager['kind'], string]> = [
      ['npm', `${prefix}package-lock.json`],
      ['pnpm', `${prefix}pnpm-lock.yaml`],
      ['yarn', `${prefix}yarn.lock`],
      ['bun', `${prefix}bun.lockb`],
    ];
    const match = lockfiles.find(([, lockfile]) => existsSync(join(repoRoot, lockfile)));
    managers.push({ kind: match?.[0] ?? 'unknown', manifestPath: `${prefix}package.json`, lockfilePath: match?.[1] ?? null });
  }
  if (existsSync(join(repoRoot, 'package.json'))) addPackage('.');
  for (const top of ['packages', 'products', 'adapters', 'plugins']) {
    const directory = join(repoRoot, top);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json'))) addPackage(portablePath(join(top, entry.name)));
    }
  }
  return managers;
}

function detectRootMarkers(root: string | null): RepoRootMarker[] {
  if (!root) return [];
  const candidates: RepoRootMarker[] = [
    { path: '.git', kind: 'git' },
    { path: 'package.json', kind: 'package' },
    { path: 'pnpm-workspace.yaml', kind: 'workspace' },
    { path: '.github/workflows', kind: 'ci' },
    { path: 'tsconfig.json', kind: 'build' },
    { path: 'docs', kind: 'docs' },
  ];
  return candidates.filter(marker => existsSync(join(root, marker.path)));
}

function detectCiHints(root: string | null): RepoCiHint[] {
  const workflows = root ? join(root, '.github', 'workflows') : null;
  if (!workflows || !existsSync(workflows)) return [];
  return readdirSync(workflows)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map(name => ({ kind: 'github-actions' as const, path: portablePath(join('.github', 'workflows', name)) }));
}

function pathSignals(root: string | null, names: readonly string[], reason: string): RepoPathSignal[] {
  if (!root) return [];
  return names.filter(path => existsSync(join(root, path))).map(path => ({ path, reason }));
}

function workspaceProjects(root: string, packageManagers: readonly RepoPackageManager[]): RepoProject[] {
  const rootPackage = readPackageJson(root);
  const patterns = readWorkspacePatterns(rootPackage, root);
  const paths = [...new Set(patterns.flatMap(pattern => expandWorkspacePattern(root, pattern)))].sort();
  const projects: RepoProject[] = [];
  if (rootPackage) {
    const packageName = typeof rootPackage.name === 'string' ? rootPackage.name : null;
    projects.push({ id: projectId('.', packageName), path: '.', kind: paths.length > 0 ? 'workspace' : 'package', packageName, packageManager: packageManagerForPath(packageManagers, '.'), gates: gatesForProject('.') });
  }
  for (const path of paths) {
    const packageJson = readPackageJson(root, `${path}/package.json`);
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : null;
    projects.push({ id: projectId(path, packageName), path, kind: 'package', packageName, packageManager: packageManagerForPath(packageManagers, path), gates: gatesForProject(path) });
  }
  return projects;
}

function detectLayoutKind(root: string | null, rootMarkers: readonly RepoRootMarker[], projects: readonly RepoProject[], generatedPaths: readonly RepoPathSignal[], vendorPaths: readonly RepoPathSignal[]): RepoLayoutKind {
  if (!root) return 'unknown';
  if (vendorPaths.length > 0 || generatedPaths.length > 1) return 'generated-vendor-heavy';
  if (rootMarkers.some(marker => marker.path === 'pnpm-workspace.yaml') || projects.filter(project => project.path !== '.').length > 0) return 'javascript-typescript-workspace';
  if (rootMarkers.some(marker => marker.path === 'package.json')) return 'single-app-service';
  return 'unknown';
}

function warningsForLayout(root: string | null, kind: RepoLayoutKind, projects: readonly RepoProject[]): string[] {
  const warnings: string[] = [];
  if (!root) warnings.push('Not inside a git repository; layout inspection is incomplete.');
  if (kind === 'unknown') warnings.push('Repository layout could not be classified from supported local signals.');
  if (projects.length === 0) warnings.push('No package or workspace projects were detected.');
  if (kind !== 'javascript-typescript-workspace' && kind !== 'single-app-service' && kind !== 'generated-vendor-heavy') {
    warnings.push('Affected-scope mapping is conservative for this layout kind.');
  }
  return warnings;
}

export async function inspectRepoLayout(options: RepoInspectOptions): Promise<RepoLayoutInspection> {
  const provider = createLocalGitRepositoryProvider({ cwd: options.cwd, git: options.git });
  const repoState = await provider.inspect(configToExecutorPolicy(options.config));
  const root = repoState.root;
  const packageManagers = detectPackageManagers(root);
  const rootMarkers = detectRootMarkers(root);
  const projects = root ? workspaceProjects(root, packageManagers) : [];
  const generatedPaths = [
    ...repoState.generatedPathSignals.map(signal => ({ path: portablePath(signal.path), reason: signal.reason })),
    ...pathSignals(root, ['dist', 'build', 'coverage', 'generated'], 'Generated output path exists.'),
  ].filter((signal, index, signals) => signals.findIndex(other => other.path === signal.path) === index);
  const vendorPaths = pathSignals(root, ['vendor', 'third_party'], 'Vendored dependency path exists.');
  const kind = detectLayoutKind(root, rootMarkers, projects, generatedPaths, vendorPaths);
  return {
    kind,
    root,
    remotes: repoState.remotes,
    rootMarkers,
    projects,
    packageManagers,
    lockfiles: packageManagers.map(manager => manager.lockfilePath).filter((path): path is string => path !== null),
    ciHints: detectCiHints(root),
    generatedPaths,
    vendorPaths,
    warnings: [...repoState.warnings, ...warningsForLayout(root, kind, projects)],
  };
}

function containsPath(projectPath: string, changedPath: string): boolean {
  if (projectPath === '.') return !changedPath.includes('/') || changedPath.startsWith('.github/') || changedPath === 'package.json' || changedPath.endsWith('lock.yaml');
  const prefix = `${projectPath.replace(/\/+$/, '')}/`;
  return changedPath === projectPath || changedPath.startsWith(prefix);
}

function gatesForChangedPath(path: string): string[] {
  if (path.startsWith('.github/workflows/')) return ['ci'];
  if (/package\.json$|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$|bun\.lockb$/.test(path)) return ['build', 'typecheck', 'test', 'dependency-review'];
  if (/(\.test\.|\.spec\.)/.test(path) || path.includes('/test/')) return ['test'];
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return ['build', 'typecheck', 'test'];
  if (/\.(md|mdx)$/.test(path)) return ['docs'];
  return ['test'];
}

async function changedPathsFromGit(options: RepoAffectedOptions, root: string | null): Promise<{ paths: string[]; warnings: string[] }> {
  if (options.changedPaths && options.changedPaths.length > 0) return { paths: options.changedPaths.map(portablePath), warnings: [] };
  if (!root) return { paths: [], warnings: ['Changed paths could not be inspected because the repository root is unavailable. Provide --changed paths to map affected scope explicitly.'] };
  const git = options.git ?? ((args: string[], gitOptions: { cwd: string }) => {
    const result = spawnSync('git', args, { cwd: gitOptions.cwd, encoding: 'utf8' });
    return { args, exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const baseRef = `${options.config.baseRemote}/${options.config.baseBranch}`;
  const result = await git(['diff', '--name-only', `${baseRef}...HEAD`], { cwd: root });
  if (result.exitCode === 0) return { paths: result.stdout.split(/\r?\n/).map(portablePath).filter(Boolean), warnings: [] };
  const cause = result.stderr.trim() || `git diff exited with ${result.exitCode}`;
  return {
    paths: [],
    warnings: [`Failed to inspect changed paths from ${baseRef}...HEAD. Likely cause: ${cause}. Next action: provide --changed paths or fetch and verify the configured base ref.`],
  };
}

export async function inspectAffected(options: RepoAffectedOptions): Promise<RepoAffectedResult> {
  const layout = await inspectRepoLayout(options);
  const changedPathResult = await changedPathsFromGit(options, layout.root);
  const changedPaths = changedPathResult.paths;
  const affectedProjects: RepoAffectedProject[] = [];
  for (const project of layout.projects) {
    const matches = changedPaths.filter(path => containsPath(project.path, path));
    if (matches.length === 0) continue;
    const gates = [...new Set(matches.flatMap(gatesForChangedPath))];
    affectedProjects.push({ project, changedPaths: matches, gates });
  }
  const unmatched = changedPaths.filter(path => !affectedProjects.some(project => project.changedPaths.includes(path)));
  const suggestedGates = [...new Set([...affectedProjects.flatMap(project => project.gates), ...unmatched.flatMap(gatesForChangedPath)])];
  return {
    layout,
    changedPaths,
    affectedProjects,
    suggestedGates,
    warnings: [
      ...layout.warnings,
      ...changedPathResult.warnings,
      ...(unmatched.length > 0 ? [`${unmatched.length} changed path(s) did not map to a detected project; use conservative gates.`] : []),
    ],
  };
}

export async function runRepoInspect(options: RepoInspectOptions): Promise<RepoInspectCommandResult> {
  return { ok: true, command: 'repo inspect', ...await inspectRepoLayout(options) };
}

export async function runRepoAffected(options: RepoAffectedOptions): Promise<RepoAffectedCommandResult> {
  return { ok: true, command: 'repo affected', ...await inspectAffected(options) };
}
