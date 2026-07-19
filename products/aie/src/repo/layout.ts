import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';
import type { RepoAffectedProject, RepoAffectedResult, RepoCiHint, RepoLayoutInspection, RepoLayoutKind, RepoPackageManager, RepoPathSignal, RepoProject, RepoProjectKind, RepoRootMarker } from '@tjalve/qube-core';
import type { Config } from '../config/index.js';
import type { GitExec, GitRunResult } from '../providers/local/local_git_provider.js';

interface PackageJson {
  readonly name?: unknown;
  readonly workspaces?: unknown;
  readonly scripts?: unknown;
}

interface PyProject {
  readonly name: string | null;
  readonly workspacePatterns: readonly string[];
  readonly toolSections: readonly string[];
}

interface RootBuildSignal {
  readonly path: string;
  readonly markerKind: RepoRootMarker['kind'];
  readonly projectKind: RepoProjectKind;
  readonly packageManager: string | null;
}

interface JsWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

interface PythonWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly toolSections: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

const ROOT_BUILD_SIGNAL_FILES: readonly RootBuildSignal[] = Object.freeze([
  { path: 'package.json', markerKind: 'package', projectKind: 'app', packageManager: null },
  { path: 'pyproject.toml', markerKind: 'package', projectKind: 'app', packageManager: null },
  { path: 'Cargo.toml', markerKind: 'package', projectKind: 'app', packageManager: null },
  { path: 'go.mod', markerKind: 'package', projectKind: 'app', packageManager: null },
  { path: 'pom.xml', markerKind: 'package', projectKind: 'app', packageManager: null },
  { path: 'build.gradle', markerKind: 'build', projectKind: 'app', packageManager: null },
  { path: 'build.gradle.kts', markerKind: 'build', projectKind: 'app', packageManager: null },
  { path: 'CMakeLists.txt', markerKind: 'build', projectKind: 'app', packageManager: null },
]);

const JS_WORKSPACE_MARKER_FILES = ['pnpm-workspace.yaml', 'turbo.json', 'nx.json', 'lerna.json'] as const;
const JS_WORKSPACE_PROJECT_DIRS = ['apps', 'packages', 'products', 'adapters', 'plugins'] as const;
const PYTHON_WORKSPACE_MARKER_FILES = ['uv.lock', 'poetry.lock', 'pdm.lock', 'tox.ini', 'noxfile.py'] as const;
const PYTHON_WORKSPACE_PROJECT_DIRS = ['apps', 'packages', 'services', 'libs'] as const;

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

function trimOutput(result: Pick<GitRunResult, 'stdout'>): string {
  return result.stdout.trim();
}

async function runGit(args: string[], cwd: string, git?: GitExec): Promise<GitRunResult> {
  if (git) return git(args, { cwd });
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { args, exitCode: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseRemoteLines(stdout: string): Array<{ name: string; url: string }> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/);
    if (match) remotes.set(match[1], match[2]);
  }
  return [...remotes].map(([name, url]) => ({ name, url }));
}

async function inspectRepoSignals(options: RepoInspectOptions): Promise<{
  readonly root: string | null;
  readonly remotes: Array<{ name: string; url: string }>;
  readonly generatedPathSignals: RepoPathSignal[];
  readonly warnings: string[];
}> {
  const start = options.cwd ?? process.cwd();
  const rootResult = await runGit(['rev-parse', '--show-toplevel'], start, options.git);
  const root = rootResult.exitCode === 0 ? trimOutput(rootResult) : null;
  const remoteResult = await runGit(['remote', '-v'], root ?? start, options.git);
  const warnings: string[] = [];
  if (!root) warnings.push('Not inside a git repository.');
  if (remoteResult.exitCode !== 0) warnings.push(remoteResult.stderr.trim() || 'Failed to inspect git remotes.');
  return {
    root,
    remotes: remoteResult.exitCode === 0 ? parseRemoteLines(remoteResult.stdout) : [],
    generatedPathSignals: root && existsSync(join(root, 'dist')) ? [{ path: 'dist', reason: 'Generated package build output path exists.' }] : [],
    warnings,
  };
}

function repoRelativePath(root: string, path: string): string | null {
  const relativePath = relative(root, path);
  if (relativePath === '') return '.';
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null;
  return portablePath(relativePath);
}

function readPackageJson(root: string, path = 'package.json'): PackageJson | null {
  try {
    return JSON.parse(readFileSync(join(root, path), 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function readPyProject(root: string, path = 'pyproject.toml'): PyProject | null {
  const text = readTextFile(root, path);
  if (text === null) return null;
  return {
    name: pyProjectName(text),
    workspacePatterns: pythonWorkspacePatterns(text),
    toolSections: pythonToolSections(text),
  };
}

function pyProjectName(text: string): string | null {
  let section = '';
  let projectName: string | null = null;
  let poetryName: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
    if (!nameMatch) continue;
    if (section === 'project') projectName = nameMatch[1].trim();
    if (section === 'tool.poetry') poetryName = nameMatch[1].trim();
  }
  return projectName ?? poetryName;
}

function pythonWorkspacePatterns(text: string): string[] {
  const patterns: string[] = [];
  let section = '';
  let collectingMembers = false;
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      collectingMembers = false;
      continue;
    }
    const inWorkspaceSection = section === 'tool.uv.workspace' || section === 'tool.pdm.workspace';
    if (!inWorkspaceSection) continue;
    if (line.match(/^\s*members\s*=\s*\[/)) collectingMembers = true;
    if (collectingMembers || line.match(/^\s*members\s*=/)) {
      for (const match of line.matchAll(/["']([^"']+)["']/g)) patterns.push(match[1]);
    }
    if (collectingMembers && line.includes(']')) collectingMembers = false;
  }
  return [...new Set(patterns)].sort();
}

function pythonToolSections(text: string): string[] {
  const sections = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    const section = sectionMatch?.[1].trim();
    if (section === 'tool.poetry' || section?.startsWith('tool.poetry.')) sections.add('tool.poetry');
    if (section === 'tool.hatch' || section?.startsWith('tool.hatch.')) sections.add('tool.hatch');
    if (section === 'tool.pdm' || section?.startsWith('tool.pdm.')) sections.add('tool.pdm');
    if (section === 'tool.uv' || section?.startsWith('tool.uv.')) sections.add('tool.uv');
  }
  return [...sections].sort();
}

function readWorkspacePatterns(packageJson: PackageJson | null, root: string): string[] {
  const workspaces = packageJson?.workspaces;
  const patterns: string[] = [];
  if (Array.isArray(workspaces)) patterns.push(...workspaces.filter((value): value is string => typeof value === 'string'));
  if (workspaces && typeof workspaces === 'object' && Array.isArray((workspaces as { packages?: unknown }).packages)) {
    patterns.push(...(workspaces as { packages: unknown[] }).packages.filter((value): value is string => typeof value === 'string'));
  }
  const workspaceFile = join(root, 'pnpm-workspace.yaml');
  if (existsSync(workspaceFile)) {
    for (const line of readFileSync(workspaceFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*-\s+["']?([^"']+)["']?\s*$/);
      if (match) patterns.push(match[1]);
    }
  }
  return [...new Set(patterns)].sort();
}

function expandWorkspacePattern(root: string, pattern: string, manifestName: string): string[] {
  const normalized = portablePath(pattern).replace(/\/+$/, '');
  if (normalized.includes('**') || normalized.startsWith('!')) return [];
  if (!normalized.includes('*')) {
    const projectPath = resolve(root, normalized);
    const relativeProjectPath = repoRelativePath(root, projectPath);
    return relativeProjectPath !== null && existsSync(join(projectPath, manifestName)) ? [relativeProjectPath] : [];
  }
  const starIndex = normalized.indexOf('*');
  const prefix = normalized.slice(0, starIndex).replace(/\/+$/, '');
  const suffix = normalized.slice(starIndex + 1).replace(/^\/+/, '');
  const base = prefix === '' ? root : resolve(root, prefix);
  if (repoRelativePath(root, base) === null) return [];
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(base, entry.name, suffix))
    .map(path => ({ path, relativePath: repoRelativePath(root, path) }))
    .filter(candidate => candidate.relativePath !== null && existsSync(join(candidate.path, manifestName)))
    .map(candidate => candidate.relativePath as string);
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

function readTextFile(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return null;
  }
}

function firstMatch(text: string | null, pattern: RegExp): string | null {
  const match = text?.match(pattern);
  return match?.[1]?.trim() || null;
}

function rootDirectoryName(root: string): string {
  const pathParts = portablePath(root).split('/').filter(Boolean);
  return pathParts[pathParts.length - 1] ?? 'root';
}

function rootProjectName(root: string, signal: RootBuildSignal): string | null {
  if (signal.path === 'package.json') {
    const packageJson = readPackageJson(root);
    return typeof packageJson?.name === 'string' ? packageJson.name : null;
  }
  const text = readTextFile(root, signal.path);
  if (signal.path === 'pyproject.toml') return firstMatch(text, /^\s*name\s*=\s*["']([^"']+)["']/m);
  if (signal.path === 'Cargo.toml') return firstMatch(text, /^\s*name\s*=\s*["']([^"']+)["']/m);
  if (signal.path === 'go.mod') return firstMatch(text, /^\s*module\s+(\S+)/m);
  if (signal.path === 'pom.xml') return firstMatch(text, /<artifactId>\s*([^<\s][^<]*?)\s*<\/artifactId>/);
  if (signal.path.endsWith('.csproj')) return signal.path.replace(/\.csproj$/i, '');
  return rootDirectoryName(root);
}

function detectRootBuildSignals(root: string | null, packageManagers: readonly RepoPackageManager[]): RootBuildSignal[] {
  if (!root) return [];
  const signals: RootBuildSignal[] = [];
  for (const signal of ROOT_BUILD_SIGNAL_FILES) {
    if (!existsSync(join(root, signal.path))) continue;
    const packageManager = signal.path === 'package.json' ? packageManagerForPath(packageManagers, '.') : signal.packageManager;
    signals.push({ ...signal, packageManager });
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.csproj')) {
      signals.push({ path: entry.name, markerKind: 'build', projectKind: 'app', packageManager: null });
    }
  }
  return signals.sort((left, right) => left.path.localeCompare(right.path));
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
      ['bun', `${prefix}bun.lock`],
      ['bun', `${prefix}bun.lockb`],
    ];
    const match = lockfiles.find(([, lockfile]) => existsSync(join(repoRoot, lockfile)));
    managers.push({ kind: match?.[0] ?? 'unknown', manifestPath: `${prefix}package.json`, lockfilePath: match?.[1] ?? null });
  }
  if (existsSync(join(repoRoot, 'package.json'))) addPackage('.');
  for (const top of JS_WORKSPACE_PROJECT_DIRS) {
    const directory = join(repoRoot, top);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json'))) addPackage(portablePath(join(top, entry.name)));
    }
  }
  return managers;
}

function detectJsWorkspaceSignals(root: string | null, rootPackage: PackageJson | null): JsWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const declaredPatterns = readWorkspacePatterns(rootPackage, root);
  const markerPaths = JS_WORKSPACE_MARKER_FILES.filter(path => existsSync(join(root, path)));
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandWorkspacePattern(root, pattern, 'package.json')),
    ...JS_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => {
      const directory = join(root, directoryName);
      if (!existsSync(directory)) return [];
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'package.json')))
        .map(entry => portablePath(join(directoryName, entry.name)));
    }),
  ])].sort();
  return { declaredPatterns, markerPaths, resolvedProjectPaths };
}

function hasJsWorkspaceSignals(signals: JsWorkspaceSignals): boolean {
  return signals.declaredPatterns.length > 0 || signals.markerPaths.length > 0 || signals.resolvedProjectPaths.length > 0;
}

function detectPythonWorkspaceSignals(root: string | null, rootPyProject: PyProject | null): PythonWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], toolSections: [], resolvedProjectPaths: [] };
  const declaredPatterns = [...(rootPyProject?.workspacePatterns ?? [])];
  const markerPaths = PYTHON_WORKSPACE_MARKER_FILES.filter(path => existsSync(join(root, path))).sort();
  const toolSections = [...(rootPyProject?.toolSections ?? [])].sort();
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandWorkspacePattern(root, pattern, 'pyproject.toml')),
    ...PYTHON_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => {
      const directory = join(root, directoryName);
      if (!existsSync(directory)) return [];
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && existsSync(join(directory, entry.name, 'pyproject.toml')))
        .map(entry => portablePath(join(directoryName, entry.name)));
    }),
  ])].sort();
  return { declaredPatterns, markerPaths, toolSections, resolvedProjectPaths };
}

function hasPythonWorkspaceSignals(signals: PythonWorkspaceSignals): boolean {
  return signals.declaredPatterns.length > 0 || signals.resolvedProjectPaths.length > 0;
}

function detectRootMarkers(root: string | null, rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals): RepoRootMarker[] {
  if (!root) return [];
  const candidates: RepoRootMarker[] = [
    { path: '.git', kind: 'git' },
    { path: '.github/workflows', kind: 'ci' },
    { path: 'tsconfig.json', kind: 'build' },
    { path: 'docs', kind: 'docs' },
    ...jsWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...pythonWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...pythonWorkspaceSignals.toolSections.map(section => ({ path: 'pyproject.toml', kind: 'workspace' as const, section })),
    ...rootSignals.map(signal => ({ path: signal.path, kind: signal.markerKind })),
  ];
  return candidates
    .filter(marker => existsSync(join(root, marker.path)))
    .filter((marker, index, markers) => markers.findIndex(other => other.path === marker.path && other.section === marker.section) === index);
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

function workspaceProjects(root: string, packageManagers: readonly RepoPackageManager[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals): RepoProject[] {
  const rootPackage = readPackageJson(root);
  const rootPyProject = readPyProject(root);
  const paths = [...new Set([...jsWorkspaceSignals.resolvedProjectPaths, ...pythonWorkspaceSignals.resolvedProjectPaths])].sort();
  const projects: RepoProject[] = [];
  const jsWorkspace = rootPackage && hasJsWorkspaceSignals(jsWorkspaceSignals);
  const pythonWorkspace = rootPyProject && hasPythonWorkspaceSignals(pythonWorkspaceSignals);
  if (pythonWorkspace && (!jsWorkspace || resolveWorkspaceConflict(jsWorkspaceSignals, pythonWorkspaceSignals) === 'python')) {
    const packageName = rootPyProject.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (rootPackage) {
    const packageName = typeof rootPackage.name === 'string' ? rootPackage.name : null;
    projects.push({ id: projectId('.', packageName), path: '.', kind: jsWorkspace ? 'workspace' : 'app', packageName, packageManager: packageManagerForPath(packageManagers, '.'), gates: gatesForProject('.') });
  } else if (rootPyProject) {
    const packageName = rootPyProject.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: pythonWorkspace ? 'workspace' : 'app', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (paths.length === 0 && rootSignals.length > 0) {
    const primarySignal = rootSignals[0];
    const packageName = rootProjectName(root, primarySignal);
    projects.push({ id: projectId('.', packageName), path: '.', kind: primarySignal.projectKind, packageName, packageManager: primarySignal.packageManager, gates: gatesForProject('.') });
  }
  for (const path of paths) {
    const packageJson = readPackageJson(root, `${path}/package.json`);
    const pyProject = readPyProject(root, `${path}/pyproject.toml`);
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : pyProject?.name ?? null;
    projects.push({ id: projectId(path, packageName), path, kind: 'package', packageName, packageManager: packageJson ? packageManagerForPath(packageManagers, path) : null, gates: gatesForProject(path) });
  }
  return projects;
}

function resolveWorkspaceConflict(jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals): 'javascript' | 'python' | 'conflict' {
  const jsMembers = jsWorkspaceSignals.resolvedProjectPaths.length;
  const pythonMembers = pythonWorkspaceSignals.resolvedProjectPaths.length;
  if (jsMembers > 0 && pythonMembers === 0) return 'javascript';
  if (pythonMembers > 0 && jsMembers === 0) return 'python';
  return 'conflict';
}

function detectLayoutKind(root: string | null, projects: readonly RepoProject[], generatedPaths: readonly RepoPathSignal[], vendorPaths: readonly RepoPathSignal[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals): RepoLayoutKind {
  if (!root) return 'unknown';
  if (vendorPaths.length > 0 || generatedPaths.length > 1) return 'generated-vendor-heavy';
  const jsRootWorkspace = hasJsWorkspaceSignals(jsWorkspaceSignals) && rootSignals.some(signal => signal.path === 'package.json');
  const pythonRootWorkspace = hasPythonWorkspaceSignals(pythonWorkspaceSignals) && rootSignals.some(signal => signal.path === 'pyproject.toml');
  if (jsRootWorkspace && pythonRootWorkspace) {
    const resolved = resolveWorkspaceConflict(jsWorkspaceSignals, pythonWorkspaceSignals);
    if (resolved === 'javascript') return 'javascript-typescript-workspace';
    if (resolved === 'python') return 'python-workspace-monorepo';
    return 'unknown';
  }
  if (jsRootWorkspace) return 'javascript-typescript-workspace';
  if (pythonRootWorkspace) return 'python-workspace-monorepo';
  if (rootSignals.length === 1) return 'single-app-service';
  if (rootSignals.length > 1) return 'unknown';
  return 'unknown';
}

function warningsForLayout(root: string | null, kind: RepoLayoutKind, projects: readonly RepoProject[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals): string[] {
  const warnings: string[] = [];
  const jsRootWorkspace = hasJsWorkspaceSignals(jsWorkspaceSignals) && rootSignals.some(signal => signal.path === 'package.json');
  const pythonRootWorkspace = hasPythonWorkspaceSignals(pythonWorkspaceSignals) && rootSignals.some(signal => signal.path === 'pyproject.toml');
  if (jsRootWorkspace && pythonRootWorkspace) {
    const resolved = resolveWorkspaceConflict(jsWorkspaceSignals, pythonWorkspaceSignals);
    warnings.push(resolved === 'conflict'
      ? 'Both JavaScript and Python root workspace declarations were detected and both or neither resolve member projects; repository layout is ambiguous.'
      : `Both JavaScript and Python root workspace declarations were detected; layout classification used the ${resolved === 'python' ? 'Python' : 'JavaScript'} workspace because only it resolves member projects.`);
  }
  if (!root) warnings.push('Not inside a git repository; layout inspection is incomplete.');
  if (rootSignals.length > 1 && kind === 'unknown') warnings.push(`Multiple root package/build signals were detected (${rootSignals.map(signal => signal.path).join(', ')}); repository layout is ambiguous.`);
  if (jsWorkspaceSignals.markerPaths.length > 0 && !rootSignals.some(signal => signal.path === 'package.json')) warnings.push(`JavaScript workspace marker(s) were detected (${jsWorkspaceSignals.markerPaths.join(', ')}) but no root package.json was found; workspace layout is ambiguous.`);
  if ((pythonWorkspaceSignals.markerPaths.length > 0 || pythonWorkspaceSignals.resolvedProjectPaths.length > 0) && !rootSignals.some(signal => signal.path === 'pyproject.toml')) warnings.push(`Python workspace marker(s) were detected (${[...pythonWorkspaceSignals.markerPaths, ...pythonWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root pyproject.toml was found; workspace layout is ambiguous.`);
  if (kind === 'javascript-typescript-workspace' && jsWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('JavaScript workspace signals were detected, but no member package roots were resolved.');
  if (kind === 'python-workspace-monorepo' && pythonWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Python workspace signals were detected, but no member package roots were resolved.');
  if (kind === 'unknown') warnings.push('Repository layout could not be classified from supported local signals.');
  if (projects.length === 0) warnings.push('No package or workspace projects were detected.');
  if (kind !== 'javascript-typescript-workspace' && kind !== 'python-workspace-monorepo' && kind !== 'single-app-service' && kind !== 'generated-vendor-heavy') {
    warnings.push('Affected-scope mapping is conservative for this layout kind.');
  }
  return warnings;
}

export async function inspectRepoLayout(options: RepoInspectOptions): Promise<RepoLayoutInspection> {
  const repoState = await inspectRepoSignals(options);
  const root = repoState.root;
  const packageManagers = detectPackageManagers(root);
  const rootSignals = detectRootBuildSignals(root, packageManagers);
  const rootPackage = root ? readPackageJson(root) : null;
  const rootPyProject = root ? readPyProject(root) : null;
  const jsWorkspaceSignals = detectJsWorkspaceSignals(root, rootPackage);
  const pythonWorkspaceSignals = detectPythonWorkspaceSignals(root, rootPyProject);
  const rootMarkers = detectRootMarkers(root, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals);
  const projects = root ? workspaceProjects(root, packageManagers, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals) : [];
  const generatedPaths = [
    ...repoState.generatedPathSignals.map(signal => ({ path: portablePath(signal.path), reason: signal.reason })),
    ...pathSignals(root, ['dist', 'build', 'coverage', 'generated'], 'Generated output path exists.'),
  ].filter((signal, index, signals) => signals.findIndex(other => other.path === signal.path) === index);
  const vendorPaths = pathSignals(root, ['vendor', 'third_party'], 'Vendored dependency path exists.');
  const kind = detectLayoutKind(root, projects, generatedPaths, vendorPaths, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals);
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
    warnings: [...repoState.warnings, ...warningsForLayout(root, kind, projects, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals)],
  };
}

/** True when a changed path sits at or under a layout path signal, using portable separators. */
export function changedPathUnderSignal(signal: RepoPathSignal, changedPath: string): boolean {
  const signalPath = portablePath(signal.path).replace(/\/+$/, '');
  const changed = portablePath(changedPath);
  return changed === signalPath || changed.startsWith(`${signalPath}/`);
}

function signalContainsPath(signals: readonly RepoPathSignal[], changedPath: string): boolean {
  return signals.some(signal => changedPathUnderSignal(signal, changedPath));
}

function containsPath(layoutKind: RepoLayoutKind, projectPath: string, changedPath: string): boolean {
  if (projectPath === '.') {
    if (layoutKind === 'single-app-service') return true;
    return !changedPath.includes('/') || changedPath.startsWith('.github/');
  }
  const prefix = `${projectPath.replace(/\/+$/, '')}/`;
  return changedPath === projectPath || changedPath.startsWith(prefix);
}

function gatesForChangedPath(path: string): string[] {
  if (path.startsWith('.github/workflows/')) return ['ci'];
  if (/package\.json$|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$|bun\.lockb?$|pyproject\.toml$|uv\.lock$|poetry\.lock$|pdm\.lock$|tox\.ini$|noxfile\.py$|Cargo\.toml$|go\.mod$|pom\.xml$|build\.gradle(?:\.kts)?$|CMakeLists\.txt$|\.csproj$/i.test(path)) return ['build', 'typecheck', 'test', 'dependency-review'];
  if (/(\.test\.|\.spec\.)/.test(path) || path.includes('/test/')) return ['test'];
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp)$/.test(path)) return ['build', 'typecheck', 'test'];
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
  const mutationEligiblePaths = changedPaths.filter(path => !signalContainsPath(layout.generatedPaths, path) && !signalContainsPath(layout.vendorPaths, path));
  for (const project of layout.projects) {
    const matches = mutationEligiblePaths.filter(path => containsPath(layout.kind, project.path, path));
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
