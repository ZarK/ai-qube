function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Simple glob matcher shared with review-lane activation semantics. */
export function simpleGlobMatch(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (normalizedPattern === "**" || normalizedPattern === "**/*") return true;
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
  return new RegExp(`^${regex}$`).test(normalizedPath);
}

export function pathsTouchPatterns(paths: readonly string[], patterns: readonly string[]): boolean {
  if (patterns.length === 0 || paths.length === 0) return false;
  return paths.some(path => patterns.some(pattern => simpleGlobMatch(path, pattern)));
}
