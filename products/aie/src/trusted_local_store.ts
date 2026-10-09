import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, parse, relative } from 'node:path';

export interface TrustedStoreContainment {
  root: string;
  subtree: readonly string[];
}

export interface TrustedLocalStore extends TrustedStoreContainment {
  path: string;
}

export function resolveTrustedLocalStore(repoRoot: string): TrustedLocalStore {
  let gitDir: string;
  try {
    if (lstatSync(join(repoRoot, '.git')).isSymbolicLink()) {
      throw new Error('The repository git marker is a symlink or junction.');
    }
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!isAbsolute(gitDir) || !lstatSync(gitDir).isDirectory()) {
      throw new Error('Git did not return an absolute git directory.');
    }
  } catch (error: unknown) {
    throw new Error('Cannot resolve the trusted local store git directory. Verify the repository git marker and filesystem access, then rerun.', { cause: error });
  }
  // Include the git directory and all its ancestors in every containment
  // check, including the primary git directory above a linked worktree.
  const root = parse(gitDir).root;
  const subtree = [...relative(root, gitDir).split(/[\\/]/), 'qube', 'aie'];
  return { root, subtree, path: join(gitDir, 'qube', 'aie') };
}
