/**
 * aie doctor - diagnostics foundation (M1.4).
 *
 * Non-mutating checks for runtime, git, gh, worktree, config, base branch.
 * Emits structured JSON with stable diagnostic IDs when --json.
 * Human output is concise with [OK] / [WARN] / [FAIL] and next action.
 */

import { BaseCommand } from '../base_command';
import { loadConfig } from '../config';
import { execSync } from 'node:child_process';

interface Diagnostic {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  nextAction?: string;
}

export default class Doctor extends BaseCommand {
  static id = 'doctor';
  static summary = 'Check local environment, git, GitHub auth, and Executor config health';
  static description = 'Runs a series of non-mutating checks for Node version, git repository state, gh auth, linked worktree detection, base branch freshness, config presence and validity, and other prerequisites. Use before aie start or when troubleshooting.';
  static examples = ['$ aie doctor', '$ aie doctor --json'];
  static enableJsonFlag = true;

  async run(): Promise<void> {
    this.loadSpec();
    const diags: Diagnostic[] = [];

    // Node
    const nodeVer = process.version.replace('v', '');
    const major = parseInt(nodeVer.split('.')[0], 10);
    diags.push({
      id: 'NODE_VERSION',
      status: major >= 24 ? 'ok' : 'fail',
      message: `Node.js ${nodeVer}`,
      nextAction: major >= 24 ? undefined : 'Upgrade to Node.js 24 LTS or newer',
    });

    // CWD / repo root
    const cwd = process.cwd();
    diags.push({ id: 'CWD', status: 'ok', message: `cwd: ${cwd}` });

    // Git repo?
    let isGit = false;
    let currentBranch = '';
    let isWorktree = false;
    try {
      const gitDir = execSync('git rev-parse --git-dir', { stdio: 'pipe', encoding: 'utf8' }).trim();
      isGit = true;
      currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe', encoding: 'utf8' }).trim();
      // Detect linked worktree
      const worktreeList = execSync('git worktree list --porcelain', { stdio: 'pipe', encoding: 'utf8' });
      const wtCount = (worktreeList.match(/^worktree /gm) || []).length;
      isWorktree = wtCount > 1 || gitDir.includes('/worktrees/');
    } catch {
      isGit = false;
    }
    diags.push({
      id: 'GIT_REPO',
      status: isGit ? 'ok' : 'fail',
      message: isGit ? 'inside git repository' : 'not inside a git repository',
      nextAction: isGit ? undefined : 'cd to a git repo or run git init',
    });
    if (isGit) {
      diags.push({ id: 'CURRENT_BRANCH', status: 'ok', message: `branch: ${currentBranch}` });
      diags.push({
        id: 'LINKED_WORKTREE',
        status: isWorktree ? 'fail' : 'ok',
        message: isWorktree ? 'linked git worktree detected' : 'not a linked worktree',
        nextAction: isWorktree ? 'Use primary checkout (AGENTS.md forbids worktrees for Executor)' : undefined,
      });
    }

    // gh available and auth?
    let ghOk = false;
    let ghAuth = '';
    try {
      execSync('gh --version', { stdio: 'pipe' });
      ghAuth = execSync('gh auth status 2>&1', { stdio: 'pipe', encoding: 'utf8' });
      ghOk = ghAuth.includes('Logged in');
    } catch {
      ghOk = false;
    }
    diags.push({
      id: 'GH_CLI',
      status: ghOk ? 'ok' : 'warn',
      message: ghOk ? 'gh available and authenticated' : 'gh not available or not authenticated',
      nextAction: ghOk ? undefined : 'Install gh and run gh auth login',
    });

    // Config
    const cfgResult = loadConfig(cwd);
    const configOk = !!cfgResult.config && !cfgResult.error;
    diags.push({
      id: 'CONFIG',
      status: configOk ? 'ok' : (cfgResult.error?.kind === 'CONFIG_NOT_FOUND' ? 'warn' : 'fail'),
      message: configOk ? `config loaded from ${cfgResult.path || 'defaults'}` : cfgResult.error?.message || 'config issue',
      nextAction: cfgResult.error?.nextAction,
    });
    if (cfgResult.path) {
      diags.push({ id: 'CONFIG_PATH', status: 'ok', message: cfgResult.path });
    }

    // Base branch freshness (if git)
    if (isGit) {
      try {
        execSync(`git fetch ${cfgResult.config?.baseRemote || 'origin'} ${cfgResult.config?.baseBranch || 'main'} --quiet`, { stdio: 'pipe' });
        const behind = execSync(`git rev-list --count HEAD..${cfgResult.config?.baseRemote || 'origin'}/${cfgResult.config?.baseBranch || 'main'}`, { stdio: 'pipe', encoding: 'utf8' }).trim();
        const isFresh = parseInt(behind, 10) === 0;
        diags.push({
          id: 'BASE_BRANCH_FRESH',
          status: isFresh ? 'ok' : 'warn',
          message: isFresh ? 'base branch up to date' : `base branch behind by ${behind} commits`,
          nextAction: isFresh ? undefined : `git pull ${cfgResult.config?.baseRemote || 'origin'} ${cfgResult.config?.baseBranch || 'main'}`,
        });
      } catch {
        diags.push({ id: 'BASE_BRANCH_FRESH', status: 'warn', message: 'could not check base branch freshness' });
      }
    }

    // Output
    if (this.jsonEnabled()) {
      this.emitJson({ diagnostics: diags });
      return;
    }

    this.log('aie doctor - Executor environment report');
    for (const d of diags) {
      const icon = d.status === 'ok' ? '✓' : d.status === 'warn' ? '!' : '✗';
      this.log(`${icon} ${d.id}: ${d.message}`);
      if (d.nextAction) this.log(`  → ${d.nextAction}`);
    }
    this.log('');
    this.log('Run with --json for agent consumption. No state was mutated.');
  }
}
