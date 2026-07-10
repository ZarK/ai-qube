function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

const patternRegexCache = new Map<string, RegExp | true>();

function patternToRegex(pattern: string): RegExp | true {
  const normalizedPattern = normalizePath(pattern);
  const cached = patternRegexCache.get(normalizedPattern);
  if (cached) return cached;
  if (normalizedPattern === "**" || normalizedPattern === "**/*") {
    patternRegexCache.set(normalizedPattern, true);
    return true;
  }
  let regex = "";
  for (let index = 0; index < normalizedPattern.length;) {
    const char = normalizedPattern[index];
    if (normalizedPattern.startsWith("**/", index)) {
      regex += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (normalizedPattern.startsWith("**", index)) {
      regex += ".*";
      index += 2;
      continue;
    }
    if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    index += 1;
  }
  const compiled = new RegExp(`^${regex}$`);
  patternRegexCache.set(normalizedPattern, compiled);
  return compiled;
}

/** Simple glob matcher shared with review-lane activation semantics. */
export function simpleGlobMatch(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const matcher = patternToRegex(pattern);
  if (matcher === true) return true;
  return matcher.test(normalizedPath);
}

export function pathsTouchPatterns(paths: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0 || paths.length === 0) return false;
  const matchers = patterns.map(pattern => patternToRegex(pattern));
  return paths.some(path => {
    const normalizedPath = normalizePath(path);
    return matchers.some(matcher => matcher === true || matcher.test(normalizedPath));
  });
}
