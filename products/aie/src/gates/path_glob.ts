export type PathNormalizeFailure = 'empty-path' | 'absolute-path' | 'parent-directory';

export function normalizeRepoRelativePath(raw: string): { ok: true; path: string } | { ok: false; reason: PathNormalizeFailure } {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (trimmed === '') return { ok: false, reason: 'empty-path' };
  if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) return { ok: false, reason: 'absolute-path' };
  const parts = trimmed.split('/');
  if (parts.includes('..')) return { ok: false, reason: 'parent-directory' };
  return { ok: true, path: parts.filter(part => part !== '' && part !== '.').join('/') };
}

export function matchRepoGlob(path: string, glob: string): boolean {
  const normalizedPath = normalizeRepoRelativePath(path);
  const normalizedGlob = normalizeRepoRelativePath(glob);
  if (!normalizedPath.ok || !normalizedGlob.ok) return false;
  return globToRegExp(normalizedGlob.path).test(normalizedPath.path);
}

function globToRegExp(glob: string): RegExp {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const after = glob[index + 2];
      if (after === '/' || after === undefined) {
        pattern += after === '/' ? '(?:.+/)?' : '.*';
        index += after === '/' ? 2 : 1;
        continue;
      }
    }
    if (char === '*') {
      pattern += '[^/]*';
      continue;
    }
    if (char === '?') {
      pattern += '[^/]';
      continue;
    }
    if ('\\^$+{}[]()|.'.includes(char)) {
      pattern += `\\${char}`;
      continue;
    }
    pattern += char;
  }
  return new RegExp(`${pattern}$`);
}
