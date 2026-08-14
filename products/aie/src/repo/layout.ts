import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
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

interface CargoProject {
  readonly name: string | null;
  readonly workspacePatterns: readonly string[];
}

interface RustWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

interface GoModule {
  readonly name: string | null;
}

interface GoWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

interface JavaKotlinWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

interface DotnetWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
  readonly resolvedProjectPaths: readonly string[];
}

interface BazelWorkspaceSignals {
  readonly declaredPatterns: readonly string[];
  readonly markerPaths: readonly string[];
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
const RUST_WORKSPACE_MARKER_FILES = ['Cargo.lock'] as const;
const RUST_WORKSPACE_PROJECT_DIRS = ['crates', 'apps', 'packages', 'services'] as const;
const GO_WORKSPACE_MARKER_FILES = ['go.work', 'go.work.sum'] as const;
const GO_WORKSPACE_PROJECT_DIRS = ['modules', 'packages', 'services', 'apps'] as const;
const JAVA_KOTLIN_SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'] as const;
const JAVA_KOTLIN_MEMBER_MANIFESTS = ['pom.xml', 'build.gradle', 'build.gradle.kts'] as const;
const JAVA_KOTLIN_PROJECT_DIRS = ['app', 'apps', 'lib', 'libs', 'modules', 'packages', 'services'] as const;
const DOTNET_PROJECT_EXTENSIONS = ['.csproj', '.fsproj'] as const;
const DOTNET_MARKER_FILES = ['Directory.Build.props'] as const;
const DOTNET_PROJECT_DIRS = ['src', 'apps', 'services', 'lib', 'libs', 'tests'] as const;
const BAZEL_WORKSPACE_PROOF_FILES = ['MODULE.bazel', 'WORKSPACE', 'WORKSPACE.bazel', 'pants.toml', '.buckconfig'] as const;
const BAZEL_SUPPORTING_MARKERS = ['MODULE.bazel.lock'] as const;
const BAZEL_PACKAGE_FILES = ['BUILD', 'BUILD.bazel', 'BUCK'] as const;
const BAZEL_PROJECT_DIRS = ['apps', 'packages', 'services', 'libs', 'src', 'modules'] as const;
const BAZEL_GENERATED_PATHS = ['bazel-bin', 'bazel-out', 'bazel-testlogs', 'bazel-genfiles', '.pants.d', 'buck-out'] as const;

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

function containedProjectPath(root: string, candidate: string): string | null {
  try {
    const resolvedRoot = realpathSync(root);
    const resolvedCandidate = existsSync(candidate) ? realpathSync(candidate) : resolve(candidate);
    return repoRelativePath(resolvedRoot, resolvedCandidate);
  } catch {
    return null;
  }
}

function containedChildProjects(root: string, directoryName: string, manifestName: string): string[] {
  const directory = join(root, directoryName);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const projectPath = resolve(directory, entry.name);
      const relativePath = containedProjectPath(root, projectPath);
      return relativePath !== null && existsSync(join(projectPath, manifestName)) ? relativePath : null;
    })
    .filter((path): path is string => path !== null);
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

function readCargoProject(root: string, path = 'Cargo.toml'): CargoProject | null {
  const text = readTextFile(root, path);
  if (text === null) return null;
  return {
    name: cargoPackageName(text),
    workspacePatterns: cargoWorkspacePatterns(text),
  };
}

function cargoPackageName(text: string): string | null {
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const nameMatch = line.match(/^\s*name\s*=\s*["']([^"']+)["']/);
    if (nameMatch && section === 'package') return nameMatch[1].trim();
  }
  return null;
}

function cargoWorkspacePatterns(text: string): string[] {
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
    if (section !== 'workspace') continue;
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
    const relativeProjectPath = containedProjectPath(root, projectPath);
    return relativeProjectPath !== null && existsSync(join(projectPath, manifestName)) ? [relativeProjectPath] : [];
  }
  const starIndex = normalized.indexOf('*');
  const prefix = normalized.slice(0, starIndex).replace(/\/+$/, '');
  const suffix = normalized.slice(starIndex + 1).replace(/^\/+/, '');
  const base = prefix === '' ? root : resolve(root, prefix);
  if (containedProjectPath(root, base) === null) return [];
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => resolve(base, entry.name, suffix))
    .map(path => ({ path, relativePath: containedProjectPath(root, path) }))
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
    for (const path of containedChildProjects(repoRoot, top, 'package.json')) addPackage(path);
  }
  return managers;
}

function detectJsWorkspaceSignals(root: string | null, rootPackage: PackageJson | null): JsWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const declaredPatterns = readWorkspacePatterns(rootPackage, root);
  const markerPaths = JS_WORKSPACE_MARKER_FILES.filter(path => existsSync(join(root, path)));
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandWorkspacePattern(root, pattern, 'package.json')),
    ...JS_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => containedChildProjects(root, directoryName, 'package.json')),
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
    ...PYTHON_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => containedChildProjects(root, directoryName, 'pyproject.toml')),
  ])].sort();
  return { declaredPatterns, markerPaths, toolSections, resolvedProjectPaths };
}

function hasPythonWorkspaceSignals(signals: PythonWorkspaceSignals): boolean {
  return signals.declaredPatterns.length > 0 || signals.resolvedProjectPaths.length > 0;
}

function detectRustWorkspaceSignals(root: string | null, rootCargo: CargoProject | null): RustWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const declaredPatterns = [...(rootCargo?.workspacePatterns ?? [])];
  const markerPaths = RUST_WORKSPACE_MARKER_FILES.filter(path => existsSync(join(root, path))).sort();
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandWorkspacePattern(root, pattern, 'Cargo.toml')),
    ...RUST_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => containedChildProjects(root, directoryName, 'Cargo.toml')),
  ])].sort();
  return { declaredPatterns, markerPaths, resolvedProjectPaths };
}

function hasRustWorkspaceSignals(signals: RustWorkspaceSignals): boolean {
  return signals.declaredPatterns.length > 0 || signals.resolvedProjectPaths.length > 0;
}

function readGoModule(root: string, path = 'go.mod'): GoModule | null {
  const text = readTextFile(root, path);
  if (text === null) return null;
  return { name: firstMatch(text, /^\s*module\s+(\S+)/m) };
}

function goWorkspaceUsePaths(text: string): string[] {
  const patterns: string[] = [];
  let inUseBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const useLine = trimmed.match(/^use\s+(\S+)/);
    if (useLine && !trimmed.includes('(')) {
      patterns.push(useLine[1].replace(/^["']|["']$/g, '').replace(/^\.\//, ''));
      continue;
    }
    if (/^use\s*\(/.test(trimmed)) {
      inUseBlock = true;
      continue;
    }
    if (inUseBlock && trimmed === ')') {
      inUseBlock = false;
      continue;
    }
    if (inUseBlock && trimmed && !trimmed.startsWith('//')) {
      patterns.push(trimmed.replace(/^["']|["']$/g, '').replace(/^\.\//, ''));
    }
  }
  return [...new Set(patterns)].sort();
}

function detectGoWorkspaceSignals(root: string | null): GoWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const workText = readTextFile(root, 'go.work');
  const declaredPatterns = workText ? goWorkspaceUsePaths(workText) : [];
  const markerPaths = GO_WORKSPACE_MARKER_FILES.filter(path => existsSync(join(root, path))).sort();
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandWorkspacePattern(root, pattern, 'go.mod')),
    ...GO_WORKSPACE_PROJECT_DIRS.flatMap(directoryName => containedChildProjects(root, directoryName, 'go.mod')),
  ])].sort();
  return { declaredPatterns, markerPaths, resolvedProjectPaths };
}

function hasGoWorkspaceSignals(signals: GoWorkspaceSignals): boolean {
  return signals.markerPaths.includes('go.work') || signals.declaredPatterns.length > 0 || signals.resolvedProjectPaths.length > 0;
}

function gradleIncludePaths(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (/\bincludeBuild\b/.test(trimmed)) continue;
    if (!/\binclude\b/.test(trimmed)) continue;
    const args = trimmed.replace(/^include\s*\(?/, '').replace(/\)?\s*;?\s*$/, '');
    for (const part of args.split(',')) {
      const token = part.trim().replace(/^["']|["']$/g, '');
      if (!token || token.startsWith('//')) continue;
      const path = portablePath(token.replace(/^:/, '').replace(/:/g, '/')).replace(/\/+$/, '');
      if (path) patterns.push(path);
    }
  }
  return [...new Set(patterns)].sort();
}

function mavenModulePaths(text: string): string[] {
  const block = text.match(/<modules>([\s\S]*?)<\/modules>/i);
  if (!block) return [];
  return [...new Set([...block[1].matchAll(/<module>\s*([^<]+?)\s*<\/module>/gi)].map(match => portablePath(match[1].trim()).replace(/\/+$/, '')).filter(path => path !== ''))].sort();
}

function expandJavaKotlinMember(root: string, pattern: string): string[] {
  return [...new Set(JAVA_KOTLIN_MEMBER_MANIFESTS.flatMap(manifest => expandWorkspacePattern(root, pattern, manifest)))].sort();
}

function javaKotlinProjectName(root: string, relativePath: string): string | null {
  if (relativePath === '.') {
    for (const settingsPath of JAVA_KOTLIN_SETTINGS_FILES) {
      const settingsName = firstMatch(readTextFile(root, settingsPath), /rootProject\.name\s*=\s*["']([^"']+)["']/);
      if (settingsName) return settingsName;
    }
  }
  const prefix = relativePath === '.' ? '' : `${relativePath}/`;
  const pom = readTextFile(root, `${prefix}pom.xml`);
  if (pom) {
    const artifact = firstMatch(pom.replace(/<parent>[\s\S]*?<\/parent>/, ''), /<artifactId>\s*([^<]+)\s*<\/artifactId>/);
    if (artifact) return artifact;
  }
  const gradle = readTextFile(root, `${prefix}build.gradle.kts`) ?? readTextFile(root, `${prefix}build.gradle`);
  if (gradle) {
    const named = firstMatch(gradle, /rootProject\.name\s*=\s*["']([^"']+)["']/)
      ?? firstMatch(gradle, /archivesBaseName\s*=\s*["']([^"']+)["']/)
      ?? firstMatch(gradle, /base\.archivesName\.set\(["']([^"']+)["']\)/);
    if (named) return named;
  }
  if (relativePath === '.') return null;
  return portablePath(relativePath).split('/').pop() ?? null;
}

function detectJavaKotlinWorkspaceSignals(root: string | null): JavaKotlinWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const settingsText = JAVA_KOTLIN_SETTINGS_FILES.map(path => readTextFile(root, path)).find(text => text !== null) ?? null;
  const pomText = readTextFile(root, 'pom.xml');
  const declaredPatterns = [
    ...(settingsText ? gradleIncludePaths(settingsText) : []),
    ...(pomText ? mavenModulePaths(pomText) : []),
  ];
  const markerPaths = [
    ...JAVA_KOTLIN_SETTINGS_FILES.filter(path => existsSync(join(root, path))),
    ...(pomText && mavenModulePaths(pomText).length > 0 ? ['pom.xml'] : []),
  ].sort();
  const resolvedProjectPaths = [...new Set([
    ...declaredPatterns.flatMap(pattern => expandJavaKotlinMember(root, pattern)),
    ...JAVA_KOTLIN_PROJECT_DIRS.flatMap(directoryName => JAVA_KOTLIN_MEMBER_MANIFESTS.flatMap(manifest => containedChildProjects(root, directoryName, manifest))),
  ])].sort();
  return { declaredPatterns: [...new Set(declaredPatterns)].sort(), markerPaths, resolvedProjectPaths };
}

function hasJavaKotlinWorkspaceBoundary(signals: JavaKotlinWorkspaceSignals): boolean {
  return JAVA_KOTLIN_SETTINGS_FILES.some(path => signals.markerPaths.includes(path)) || signals.markerPaths.includes('pom.xml');
}

function isDotnetProjectFile(path: string): boolean {
  const portable = portablePath(path).toLowerCase();
  return DOTNET_PROJECT_EXTENSIONS.some(extension => portable.endsWith(extension));
}

function listRootSolutionFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && (entry.name.endsWith('.sln') || entry.name.endsWith('.slnx')))
    .map(entry => entry.name)
    .sort();
}

function slnProjectPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/Project\("[^"]+"\)\s*=\s*"[^"]+"\s*,\s*"([^"]+)"/g)) {
    const path = portablePath(match[1].trim().replace(/\\/g, '/'));
    if (isDotnetProjectFile(path)) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

function slnxProjectPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(/<Project\b[^>]*\bPath\s*=\s*["']([^"']+)["']/gi)) {
    const path = portablePath(match[1].trim().replace(/\\/g, '/'));
    if (isDotnetProjectFile(path)) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

function dotnetDirectoryFromProjectFile(root: string, projectFile: string): string | null {
  const projectPath = resolve(root, projectFile);
  const relativeFile = containedProjectPath(root, projectPath);
  if (relativeFile === null || !existsSync(projectPath)) return null;
  if (!isDotnetProjectFile(relativeFile)) return null;
  if (!relativeFile.includes('/')) return '.';
  return relativeFile.replace(/\/[^/]+$/, '');
}

function containedChildDotnetProjects(root: string, directoryName: string): string[] {
  const directory = join(root, directoryName);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const projectPath = resolve(directory, entry.name);
      const relativePath = containedProjectPath(root, projectPath);
      if (relativePath === null) return null;
      const hasProject = readdirSync(projectPath, { withFileTypes: true }).some(child => child.isFile() && isDotnetProjectFile(child.name));
      return hasProject ? relativePath : null;
    })
    .filter((path): path is string => path !== null)
    .sort();
}

function detectDotnetWorkspaceSignals(root: string | null): DotnetWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const solutionFiles = listRootSolutionFiles(root);
  const declaredPatterns = [...new Set(solutionFiles.flatMap(file => {
    const text = readTextFile(root, file);
    if (!text) return [];
    return file.endsWith('.slnx') ? slnxProjectPaths(text) : slnProjectPaths(text);
  }))].sort();
  const markerPaths = [
    ...solutionFiles,
    ...DOTNET_MARKER_FILES.filter(path => existsSync(join(root, path))),
  ].sort();
  const provenMembers = declaredPatterns
    .map(projectFile => dotnetDirectoryFromProjectFile(root, projectFile))
    .filter((path): path is string => path !== null && path !== '.');
  const conventionalMembers = DOTNET_PROJECT_DIRS.flatMap(directoryName => containedChildDotnetProjects(root, directoryName));
  const resolvedProjectPaths = [...new Set(solutionFiles.length > 0 ? provenMembers : conventionalMembers)].sort();
  return { declaredPatterns, markerPaths, resolvedProjectPaths };
}

function hasDotnetSolutionBoundary(signals: DotnetWorkspaceSignals): boolean {
  return signals.markerPaths.some(path => path.endsWith('.sln') || path.endsWith('.slnx'));
}

function dotnetProjectName(root: string, relativePath: string): string | null {
  if (relativePath === '.') {
    const solution = listRootSolutionFiles(root)[0];
    if (solution) return solution.replace(/\.slnx?$/i, '');
  }
  const directory = relativePath === '.' ? root : join(root, relativePath);
  if (!existsSync(directory)) return relativePath.split('/').pop() ?? null;
  const projectFile = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && isDotnetProjectFile(entry.name))
    .map(entry => entry.name)
    .sort()[0];
  if (projectFile) return projectFile.replace(/\.(csproj|fsproj)$/i, '');
  return portablePath(relativePath).split('/').filter(Boolean).pop() ?? null;
}

function isBazelPackageFile(name: string): boolean {
  return (BAZEL_PACKAGE_FILES as readonly string[]).includes(name);
}

function directoryHasBazelPackageFile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some(entry => entry.isFile() && isBazelPackageFile(entry.name));
}

function containedChildBazelPackages(root: string, directoryName: string): string[] {
  const directory = directoryName === '' || directoryName === '.' ? root : join(root, directoryName);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const projectPath = resolve(directory, entry.name);
      const relativePath = containedProjectPath(root, projectPath);
      if (relativePath === null || relativePath === '.') return null;
      return directoryHasBazelPackageFile(projectPath) ? relativePath : null;
    })
    .filter((path): path is string => path !== null)
    .sort();
}

function pantsSourceRootPatterns(text: string): string[] {
  const patterns: string[] = [];
  let section = '';
  let collecting = false;
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      collecting = false;
      continue;
    }
    if (section !== 'source') continue;
    if (line.match(/^\s*root_patterns\s*=\s*\[/)) collecting = true;
    if (collecting || line.match(/^\s*root_patterns\s*=/)) {
      for (const match of line.matchAll(/["']([^"']+)["']/g)) {
        const normalized = portablePath(match[1]).replace(/^\/+/, '').replace(/\/+$/, '');
        if (normalized && normalized !== '.') patterns.push(normalized);
      }
    }
    if (collecting && line.includes(']')) collecting = false;
  }
  return [...new Set(patterns)].sort();
}

function bazelMembersFromPattern(root: string, pattern: string): string[] {
  const projectPath = resolve(root, pattern);
  const relativePath = containedProjectPath(root, projectPath);
  if (relativePath === null || relativePath === '.') return [];
  const members: string[] = [];
  if (directoryHasBazelPackageFile(projectPath)) members.push(relativePath);
  members.push(...containedChildBazelPackages(root, relativePath));
  return [...new Set(members)].sort();
}

function bazelModuleName(text: string): string | null {
  const start = text.search(/\bmodule\s*\(/);
  if (start === -1) return null;
  return firstMatch(text.slice(start), /\bname\s*=\s*["']([^"']+)["']/);
}

function detectBazelWorkspaceSignals(root: string | null): BazelWorkspaceSignals {
  if (!root) return { declaredPatterns: [], markerPaths: [], resolvedProjectPaths: [] };
  const proofMarkers = BAZEL_WORKSPACE_PROOF_FILES.filter(path => existsSync(join(root, path)));
  const markerPaths = [
    ...proofMarkers,
    ...BAZEL_SUPPORTING_MARKERS.filter(path => existsSync(join(root, path))),
  ].sort();
  const pantsText = readTextFile(root, 'pants.toml');
  const declaredPatterns = pantsText ? pantsSourceRootPatterns(pantsText) : [];
  const conventionalMembers = BAZEL_PROJECT_DIRS.flatMap(directoryName => containedChildBazelPackages(root, directoryName));
  const declaredMembers = declaredPatterns.flatMap(pattern => bazelMembersFromPattern(root, pattern));
  const resolvedProjectPaths = [...new Set(proofMarkers.length > 0 && declaredPatterns.length > 0 ? declaredMembers : conventionalMembers)].sort();
  return { declaredPatterns, markerPaths, resolvedProjectPaths };
}

function hasBazelWorkspaceBoundary(signals: BazelWorkspaceSignals): boolean {
  return BAZEL_WORKSPACE_PROOF_FILES.some(path => signals.markerPaths.includes(path));
}

function bazelProjectName(root: string, relativePath: string): string | null {
  if (relativePath === '.') {
    const moduleName = bazelModuleName(readTextFile(root, 'MODULE.bazel') ?? '');
    if (moduleName) return moduleName;
    const workspaceText = readTextFile(root, 'WORKSPACE.bazel') ?? readTextFile(root, 'WORKSPACE');
    const workspaceName = workspaceText ? firstMatch(workspaceText, /\bworkspace\s*\(\s*name\s*=\s*["']([^"']+)["']/) : null;
    if (workspaceName) return workspaceName;
    return rootDirectoryName(root);
  }
  return portablePath(relativePath).split('/').filter(Boolean).pop() ?? null;
}

function detectRootMarkers(root: string | null, rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals, rustWorkspaceSignals: RustWorkspaceSignals, goWorkspaceSignals: GoWorkspaceSignals, javaKotlinWorkspaceSignals: JavaKotlinWorkspaceSignals, dotnetWorkspaceSignals: DotnetWorkspaceSignals, bazelWorkspaceSignals: BazelWorkspaceSignals): RepoRootMarker[] {
  if (!root) return [];
  const candidates: RepoRootMarker[] = [
    { path: '.git', kind: 'git' },
    { path: '.github/workflows', kind: 'ci' },
    { path: 'tsconfig.json', kind: 'build' },
    { path: 'docs', kind: 'docs' },
    ...jsWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...pythonWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...pythonWorkspaceSignals.toolSections.map(section => ({ path: 'pyproject.toml', kind: 'workspace' as const, section })),
    ...rustWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...goWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...javaKotlinWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...dotnetWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
    ...bazelWorkspaceSignals.markerPaths.map(path => ({ path, kind: 'workspace' as const })),
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

function workspaceProjects(root: string, packageManagers: readonly RepoPackageManager[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals, rustWorkspaceSignals: RustWorkspaceSignals, goWorkspaceSignals: GoWorkspaceSignals, javaKotlinWorkspaceSignals: JavaKotlinWorkspaceSignals, dotnetWorkspaceSignals: DotnetWorkspaceSignals, bazelWorkspaceSignals: BazelWorkspaceSignals): RepoProject[] {
  const rootPackage = readPackageJson(root);
  const rootPyProject = readPyProject(root);
  const rootCargo = readCargoProject(root);
  const rootGo = readGoModule(root);
  const paths = [...new Set([...jsWorkspaceSignals.resolvedProjectPaths, ...pythonWorkspaceSignals.resolvedProjectPaths, ...rustWorkspaceSignals.resolvedProjectPaths, ...goWorkspaceSignals.resolvedProjectPaths, ...javaKotlinWorkspaceSignals.resolvedProjectPaths, ...dotnetWorkspaceSignals.resolvedProjectPaths, ...bazelWorkspaceSignals.resolvedProjectPaths])].sort();
  const projects: RepoProject[] = [];
  const jsWorkspace = Boolean(rootPackage && hasJsWorkspaceSignals(jsWorkspaceSignals));
  const pythonWorkspace = Boolean(rootPyProject && hasPythonWorkspaceSignals(pythonWorkspaceSignals));
  const rustWorkspace = Boolean(rootCargo && hasRustWorkspaceSignals(rustWorkspaceSignals));
  const goWorkspace = goWorkspaceSignals.markerPaths.includes('go.work');
  const javaWorkspace = hasJavaKotlinWorkspaceBoundary(javaKotlinWorkspaceSignals);
  const dotnetWorkspace = hasDotnetSolutionBoundary(dotnetWorkspaceSignals);
  const bazelWorkspace = hasBazelWorkspaceBoundary(bazelWorkspaceSignals);
  const winner = resolveProvenWorkspace({ js: jsWorkspace, python: pythonWorkspace, rust: rustWorkspace, go: goWorkspace, java: javaWorkspace, dotnet: dotnetWorkspace, bazel: bazelWorkspace }, jsWorkspaceSignals, pythonWorkspaceSignals, rustWorkspaceSignals, goWorkspaceSignals, javaKotlinWorkspaceSignals, dotnetWorkspaceSignals, bazelWorkspaceSignals);
  if (winner === 'bazel') {
    const packageName = bazelProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (winner === 'dotnet') {
    const packageName = dotnetProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (winner === 'java') {
    const packageName = javaKotlinProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (winner === 'go') {
    const packageName = rootGo?.name ?? null;
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (winner === 'rust' && rootCargo) {
    const packageName = rootCargo.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (winner === 'python' && rootPyProject) {
    const packageName = rootPyProject.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (rootPackage) {
    const packageName = typeof rootPackage.name === 'string' ? rootPackage.name : null;
    projects.push({ id: projectId('.', packageName), path: '.', kind: jsWorkspace ? 'workspace' : 'app', packageName, packageManager: packageManagerForPath(packageManagers, '.'), gates: gatesForProject('.') });
  } else if (rootPyProject) {
    const packageName = rootPyProject.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: pythonWorkspace ? 'workspace' : 'app', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (rootCargo) {
    const packageName = rootCargo.name;
    projects.push({ id: projectId('.', packageName), path: '.', kind: rustWorkspace ? 'workspace' : 'app', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (goWorkspace) {
    const packageName = rootGo?.name ?? null;
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (javaWorkspace) {
    const packageName = javaKotlinProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (dotnetWorkspace) {
    const packageName = dotnetProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (bazelWorkspace) {
    const packageName = bazelProjectName(root, '.');
    projects.push({ id: projectId('.', packageName), path: '.', kind: 'workspace', packageName, packageManager: null, gates: gatesForProject('.') });
  } else if (paths.length === 0 && rootSignals.length > 0) {
    const primarySignal = rootSignals[0];
    const packageName = rootProjectName(root, primarySignal);
    projects.push({ id: projectId('.', packageName), path: '.', kind: primarySignal.projectKind, packageName, packageManager: primarySignal.packageManager, gates: gatesForProject('.') });
  }
  for (const path of paths) {
    const packageJson = readPackageJson(root, `${path}/package.json`);
    const pyProject = readPyProject(root, `${path}/pyproject.toml`);
    const cargo = readCargoProject(root, `${path}/Cargo.toml`);
    const goModule = readGoModule(root, `${path}/go.mod`);
    const packageName = typeof packageJson?.name === 'string' ? packageJson.name : pyProject?.name ?? cargo?.name ?? goModule?.name ?? javaKotlinProjectName(root, path) ?? dotnetProjectName(root, path) ?? bazelProjectName(root, path);
    projects.push({ id: projectId(path, packageName), path, kind: 'package', packageName, packageManager: packageJson ? packageManagerForPath(packageManagers, path) : null, gates: gatesForProject(path) });
  }
  return projects;
}

type ProvenWorkspace = 'javascript' | 'python' | 'rust' | 'go' | 'java' | 'dotnet' | 'bazel' | 'conflict' | 'none';

function resolveProvenWorkspace(
  present: { js: boolean; python: boolean; rust: boolean; go: boolean; java: boolean; dotnet: boolean; bazel: boolean },
  jsWorkspaceSignals: JsWorkspaceSignals,
  pythonWorkspaceSignals: PythonWorkspaceSignals,
  rustWorkspaceSignals: RustWorkspaceSignals,
  goWorkspaceSignals: GoWorkspaceSignals,
  javaKotlinWorkspaceSignals: JavaKotlinWorkspaceSignals,
  dotnetWorkspaceSignals: DotnetWorkspaceSignals,
  bazelWorkspaceSignals: BazelWorkspaceSignals,
): ProvenWorkspace {
  const withMembers: ProvenWorkspace[] = [];
  if (present.js && jsWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('javascript');
  if (present.python && pythonWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('python');
  if (present.rust && rustWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('rust');
  if (present.go && goWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('go');
  if (present.java && javaKotlinWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('java');
  if (present.dotnet && dotnetWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('dotnet');
  if (present.bazel && bazelWorkspaceSignals.resolvedProjectPaths.length > 0) withMembers.push('bazel');
  if (withMembers.length > 1) return 'conflict';
  if (withMembers.length === 1) return withMembers[0];
  const presentKinds = [present.js && 'javascript', present.python && 'python', present.rust && 'rust', present.go && 'go', present.java && 'java', present.dotnet && 'dotnet', present.bazel && 'bazel'].filter((value): value is Exclude<ProvenWorkspace, 'conflict' | 'none'> => Boolean(value));
  if (presentKinds.length === 1) return presentKinds[0];
  if (presentKinds.length > 1) return 'conflict';
  return 'none';
}

function detectLayoutKind(root: string | null, projects: readonly RepoProject[], generatedPaths: readonly RepoPathSignal[], vendorPaths: readonly RepoPathSignal[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals, rustWorkspaceSignals: RustWorkspaceSignals, goWorkspaceSignals: GoWorkspaceSignals, javaKotlinWorkspaceSignals: JavaKotlinWorkspaceSignals, dotnetWorkspaceSignals: DotnetWorkspaceSignals, bazelWorkspaceSignals: BazelWorkspaceSignals): RepoLayoutKind {
  if (!root) return 'unknown';
  if (vendorPaths.length > 0 || generatedPaths.length > 1) return 'generated-vendor-heavy';
  const jsRootWorkspace = hasJsWorkspaceSignals(jsWorkspaceSignals) && rootSignals.some(signal => signal.path === 'package.json');
  const pythonRootWorkspace = hasPythonWorkspaceSignals(pythonWorkspaceSignals) && rootSignals.some(signal => signal.path === 'pyproject.toml');
  const rustRootWorkspace = hasRustWorkspaceSignals(rustWorkspaceSignals) && rootSignals.some(signal => signal.path === 'Cargo.toml');
  const goRootWorkspace = goWorkspaceSignals.markerPaths.includes('go.work');
  const javaRootWorkspace = hasJavaKotlinWorkspaceBoundary(javaKotlinWorkspaceSignals);
  const dotnetRootWorkspace = hasDotnetSolutionBoundary(dotnetWorkspaceSignals);
  const bazelRootWorkspace = hasBazelWorkspaceBoundary(bazelWorkspaceSignals);
  const proven = resolveProvenWorkspace(
    { js: jsRootWorkspace, python: pythonRootWorkspace, rust: rustRootWorkspace, go: goRootWorkspace, java: javaRootWorkspace, dotnet: dotnetRootWorkspace, bazel: bazelRootWorkspace },
    jsWorkspaceSignals,
    pythonWorkspaceSignals,
    rustWorkspaceSignals,
    goWorkspaceSignals,
    javaKotlinWorkspaceSignals,
    dotnetWorkspaceSignals,
    bazelWorkspaceSignals,
  );
  if (proven === 'javascript') return 'javascript-typescript-workspace';
  if (proven === 'python') return 'python-workspace-monorepo';
  if (proven === 'rust') return 'rust-workspace';
  if (proven === 'go') return 'go-workspace';
  if (proven === 'java') return 'java-kotlin-multi-project';
  if (proven === 'dotnet') return 'dotnet-solution';
  if (proven === 'bazel') return 'bazel-pants-buck-monorepo';
  if (proven === 'conflict') return 'unknown';
  if (rootSignals.length === 1) return 'single-app-service';
  if (rootSignals.length > 1) return 'unknown';
  return 'unknown';
}

function warningsForLayout(root: string | null, kind: RepoLayoutKind, projects: readonly RepoProject[], rootSignals: readonly RootBuildSignal[], jsWorkspaceSignals: JsWorkspaceSignals, pythonWorkspaceSignals: PythonWorkspaceSignals, rustWorkspaceSignals: RustWorkspaceSignals, goWorkspaceSignals: GoWorkspaceSignals, javaKotlinWorkspaceSignals: JavaKotlinWorkspaceSignals, dotnetWorkspaceSignals: DotnetWorkspaceSignals, bazelWorkspaceSignals: BazelWorkspaceSignals): string[] {
  const warnings: string[] = [];
  const jsRootWorkspace = hasJsWorkspaceSignals(jsWorkspaceSignals) && rootSignals.some(signal => signal.path === 'package.json');
  const pythonRootWorkspace = hasPythonWorkspaceSignals(pythonWorkspaceSignals) && rootSignals.some(signal => signal.path === 'pyproject.toml');
  const rustRootWorkspace = hasRustWorkspaceSignals(rustWorkspaceSignals) && rootSignals.some(signal => signal.path === 'Cargo.toml');
  const goRootWorkspace = goWorkspaceSignals.markerPaths.includes('go.work');
  const javaRootWorkspace = hasJavaKotlinWorkspaceBoundary(javaKotlinWorkspaceSignals);
  const dotnetRootWorkspace = hasDotnetSolutionBoundary(dotnetWorkspaceSignals);
  const bazelRootWorkspace = hasBazelWorkspaceBoundary(bazelWorkspaceSignals);
  const proven = resolveProvenWorkspace(
    { js: jsRootWorkspace, python: pythonRootWorkspace, rust: rustRootWorkspace, go: goRootWorkspace, java: javaRootWorkspace, dotnet: dotnetRootWorkspace, bazel: bazelRootWorkspace },
    jsWorkspaceSignals,
    pythonWorkspaceSignals,
    rustWorkspaceSignals,
    goWorkspaceSignals,
    javaKotlinWorkspaceSignals,
    dotnetWorkspaceSignals,
    bazelWorkspaceSignals,
  );
  const present = [jsRootWorkspace && 'JavaScript', pythonRootWorkspace && 'Python', rustRootWorkspace && 'Rust', goRootWorkspace && 'Go', javaRootWorkspace && 'Java/Kotlin', dotnetRootWorkspace && '.NET', bazelRootWorkspace && 'Bazel/Pants/Buck'].filter((value): value is string => Boolean(value));
  if (present.length > 1) {
    const names = present.length === 2 ? `Both ${present[0]} and ${present[1]}` : present.join(', ');
    const provenLabel = proven === 'javascript' ? 'JavaScript' : proven === 'python' ? 'Python' : proven === 'rust' ? 'Rust' : proven === 'go' ? 'Go' : proven === 'java' ? 'Java/Kotlin' : proven === 'dotnet' ? '.NET' : proven === 'bazel' ? 'Bazel/Pants/Buck' : null;
    warnings.push(proven === 'conflict' || !provenLabel
      ? `${names} root workspace declarations were detected and both or neither resolve member projects; repository layout is ambiguous.`
      : `${names} root workspace declarations were detected; layout classification used the ${provenLabel} workspace because only it resolves member projects.`);
  }
  if (!root) warnings.push('Not inside a git repository; layout inspection is incomplete.');
  if (rootSignals.length > 1 && kind === 'unknown') warnings.push(`Multiple root package/build signals were detected (${rootSignals.map(signal => signal.path).join(', ')}); repository layout is ambiguous.`);
  if (jsWorkspaceSignals.markerPaths.length > 0 && !rootSignals.some(signal => signal.path === 'package.json')) warnings.push(`JavaScript workspace marker(s) were detected (${jsWorkspaceSignals.markerPaths.join(', ')}) but no root package.json was found; workspace layout is ambiguous.`);
  if ((pythonWorkspaceSignals.markerPaths.length > 0 || pythonWorkspaceSignals.resolvedProjectPaths.length > 0) && !rootSignals.some(signal => signal.path === 'pyproject.toml')) warnings.push(`Python workspace marker(s) were detected (${[...pythonWorkspaceSignals.markerPaths, ...pythonWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root pyproject.toml was found; workspace layout is ambiguous.`);
  if ((rustWorkspaceSignals.markerPaths.length > 0 || rustWorkspaceSignals.resolvedProjectPaths.length > 0) && !rootSignals.some(signal => signal.path === 'Cargo.toml')) warnings.push(`Rust workspace marker(s) were detected (${[...rustWorkspaceSignals.markerPaths, ...rustWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root Cargo.toml was found; workspace layout is ambiguous.`);
  if (kind === 'javascript-typescript-workspace' && jsWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('JavaScript workspace signals were detected, but no member package roots were resolved.');
  if (kind === 'python-workspace-monorepo' && pythonWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Python workspace signals were detected, but no member package roots were resolved.');
  if (kind === 'rust-workspace' && rustWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Rust workspace signals were detected, but no member crate roots were resolved.');
  if ((goWorkspaceSignals.markerPaths.includes('go.work.sum') || goWorkspaceSignals.resolvedProjectPaths.length > 0) && !goWorkspaceSignals.markerPaths.includes('go.work')) warnings.push(`Go workspace marker(s) were detected (${[...goWorkspaceSignals.markerPaths, ...goWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root go.work was found; workspace layout is ambiguous.`);
  if (kind === 'go-workspace' && goWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Go workspace signals were detected, but no member module roots were resolved.');
  if ((javaKotlinWorkspaceSignals.resolvedProjectPaths.length > 0) && !hasJavaKotlinWorkspaceBoundary(javaKotlinWorkspaceSignals)) warnings.push(`Java/Kotlin module marker(s) were detected (${javaKotlinWorkspaceSignals.resolvedProjectPaths.join(', ')}) but no root settings.gradle, settings.gradle.kts, or aggregator pom.xml was found; workspace layout is ambiguous.`);
  if (kind === 'java-kotlin-multi-project' && javaKotlinWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Java/Kotlin multi-project signals were detected, but no member module roots were resolved.');
  if ((dotnetWorkspaceSignals.resolvedProjectPaths.length > 0 || DOTNET_MARKER_FILES.some(path => dotnetWorkspaceSignals.markerPaths.includes(path))) && !hasDotnetSolutionBoundary(dotnetWorkspaceSignals)) warnings.push(`.NET project marker(s) were detected (${[...dotnetWorkspaceSignals.markerPaths, ...dotnetWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root .sln or .slnx was found; workspace layout is ambiguous.`);
  if (kind === 'dotnet-solution' && dotnetWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('.NET solution signals were detected, but no member project roots were resolved.');
  if ((bazelWorkspaceSignals.resolvedProjectPaths.length > 0 || BAZEL_SUPPORTING_MARKERS.some(path => bazelWorkspaceSignals.markerPaths.includes(path))) && !hasBazelWorkspaceBoundary(bazelWorkspaceSignals)) warnings.push(`Bazel, Pants, or Buck package marker(s) were detected (${[...bazelWorkspaceSignals.markerPaths, ...bazelWorkspaceSignals.resolvedProjectPaths].join(', ')}) but no root MODULE.bazel, WORKSPACE, WORKSPACE.bazel, pants.toml, or .buckconfig was found; workspace layout is ambiguous.`);
  if (kind === 'bazel-pants-buck-monorepo' && bazelWorkspaceSignals.resolvedProjectPaths.length === 0) warnings.push('Bazel, Pants, or Buck workspace signals were detected, but no member package roots were resolved.');
  if (kind === 'bazel-pants-buck-monorepo') warnings.push('Affected scope maps to BUILD/BUCK package directories; Bazel, Pants, and Buck target graphs are not inferred from filenames.');
  if (kind === 'unknown') warnings.push('Repository layout could not be classified from supported local signals.');
  if (projects.length === 0) warnings.push('No package or workspace projects were detected.');
  if (kind !== 'javascript-typescript-workspace' && kind !== 'python-workspace-monorepo' && kind !== 'rust-workspace' && kind !== 'go-workspace' && kind !== 'java-kotlin-multi-project' && kind !== 'dotnet-solution' && kind !== 'bazel-pants-buck-monorepo' && kind !== 'single-app-service' && kind !== 'generated-vendor-heavy') {
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
  const rootCargo = root ? readCargoProject(root) : null;
  const jsWorkspaceSignals = detectJsWorkspaceSignals(root, rootPackage);
  const pythonWorkspaceSignals = detectPythonWorkspaceSignals(root, rootPyProject);
  const rustWorkspaceSignals = detectRustWorkspaceSignals(root, rootCargo);
  const goWorkspaceSignals = detectGoWorkspaceSignals(root);
  const javaKotlinWorkspaceSignals = detectJavaKotlinWorkspaceSignals(root);
  const dotnetWorkspaceSignals = detectDotnetWorkspaceSignals(root);
  const bazelWorkspaceSignals = detectBazelWorkspaceSignals(root);
  const rootMarkers = detectRootMarkers(root, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals, rustWorkspaceSignals, goWorkspaceSignals, javaKotlinWorkspaceSignals, dotnetWorkspaceSignals, bazelWorkspaceSignals);
  const projects = root ? workspaceProjects(root, packageManagers, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals, rustWorkspaceSignals, goWorkspaceSignals, javaKotlinWorkspaceSignals, dotnetWorkspaceSignals, bazelWorkspaceSignals) : [];
  const generatedPaths = [
    ...repoState.generatedPathSignals.map(signal => ({ path: portablePath(signal.path), reason: signal.reason })),
    ...pathSignals(root, ['dist', 'build', 'coverage', 'generated', 'target', '.gradle', 'bin', 'obj', ...BAZEL_GENERATED_PATHS], 'Generated output path exists.'),
  ].filter((signal, index, signals) => signals.findIndex(other => other.path === signal.path) === index);
  const vendorPaths = pathSignals(root, ['vendor', 'third_party'], 'Vendored dependency path exists.');
  const kind = detectLayoutKind(root, projects, generatedPaths, vendorPaths, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals, rustWorkspaceSignals, goWorkspaceSignals, javaKotlinWorkspaceSignals, dotnetWorkspaceSignals, bazelWorkspaceSignals);
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
    warnings: [...repoState.warnings, ...warningsForLayout(root, kind, projects, rootSignals, jsWorkspaceSignals, pythonWorkspaceSignals, rustWorkspaceSignals, goWorkspaceSignals, javaKotlinWorkspaceSignals, dotnetWorkspaceSignals, bazelWorkspaceSignals)],
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
  if (/package\.json$|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$|bun\.lockb?$|pyproject\.toml$|uv\.lock$|poetry\.lock$|pdm\.lock$|tox\.ini$|noxfile\.py$|Cargo\.toml$|Cargo\.lock$|go\.mod$|go\.work$|go\.sum$|pom\.xml$|settings\.gradle(?:\.kts)?$|build\.gradle(?:\.kts)?$|CMakeLists\.txt$|\.slnx?$|Directory\.Build\.props$|\.(cs|fs)proj$|MODULE\.bazel(?:\.lock)?$|WORKSPACE(?:\.bazel)?$|(?:^|\/)BUILD(?:\.bazel)?$|(?:^|\/)BUCK$|pants\.toml$|\.buckconfig$/i.test(path)) return ['build', 'typecheck', 'test', 'dependency-review'];
  if (/(\.test\.|\.spec\.)/.test(path) || path.includes('/test/')) return ['test'];
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|cs|c|cc|cpp|cxx|h|hpp|bzl)$/.test(path)) return ['build', 'typecheck', 'test'];
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
